//! NoRef escrow. Nobody reports the winner with authority: not a server,
//! not a referee, not the opponent.
//!
//! 1. `create` / `join`: both players lock the same stake and register an
//!    ed25519 session key they sign their input-chain heads with.
//! 2. They play off-chain. About once a second each client signs the
//!    joint input chain head and hands the signature to the other side.
//! 3. `claim`: either player says who won. `confirm`: the other agrees and
//!    the pot pays out at once.
//! 4. `dispute`: instead of agreeing, a player submits the input log plus
//!    the *opponent's* signature over it. The contract replays the whole
//!    match with the same game code (noref-rules) and records the verdict.
//!    A longer opponent-signed log can still replace it while the window
//!    is open; each improvement reopens the window.
//! 5. `finalize`: after the window, the best replayed verdict wins; with no
//!    dispute, the claim stands. A draw refunds both. `refund` covers a
//!    match nobody claims.
use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};
use noref_rules::side;

/// Grace after the nominal match end before an unclaimed match refunds.
const CLAIM_GRACE_NS: u64 = 10 * 60 * 1_000_000_000;
const MIN_WINDOW_SECS: u64 = 10;
const MAX_WINDOW_SECS: u64 = 24 * 3600;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Open,
    Live,
    Settled,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Claim {
    pub by: AccountId,
    pub winner: u8,
}

/// Best replayed result so far.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Replayed {
    pub signed_tick: u32,
    pub winner: u8,
    pub by: AccountId,
    /// hex merkle root of the final replayed state
    pub final_root: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Match {
    pub a: AccountId,
    pub b: Option<AccountId>,
    /// if set, only this account may join
    pub invited: Option<AccountId>,
    pub stake: NearToken,
    pub duration: u32,
    pub key_a: String,
    pub key_b: Option<String>,
    pub phase: Phase,
    pub window_secs: u64,
    pub started_ns: U64,
    pub claim: Option<Claim>,
    pub replayed: Option<Replayed>,
    pub window_end_ns: U64,
    /// side that was paid (DRAW on refund), once settled
    pub result: Option<u8>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct NoRef {
    matches: LookupMap<u64, Match>,
    next_id: u64,
}

fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

fn unhex32(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    require!(b.len() == 64, "key must be 64 hex chars");
    let v = |c: u8| -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => env::panic_str("bad hex"),
        }
    };
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = (v(b[2 * i]) << 4) | v(b[2 * i + 1]);
    }
    out
}

fn now() -> u64 {
    env::block_timestamp()
}

#[near]
impl NoRef {
    #[init]
    pub fn new() -> Self {
        Self { matches: LookupMap::new(b"m"), next_id: 0 }
    }

    /// Open a match. Attach the stake. `duration` in ticks (60 Hz): whole
    /// rounds of noref_rules::ROUND_TICKS, at most noref_rules::MAX_DURATION. `session_key` is the hex ed25519 public key this player
    /// signs input-chain heads with.
    #[payable]
    pub fn create(&mut self, duration: u32, session_key: String, window_secs: u64, opponent: Option<AccountId>) -> U64 {
        let stake = env::attached_deposit();
        require!(stake > NearToken::from_yoctonear(0), "attach a stake");
        require!(noref_rules::valid_duration(duration), "bad duration: whole rounds, at most 30");
        require!((MIN_WINDOW_SECS..=MAX_WINDOW_SECS).contains(&window_secs), "bad window");
        unhex32(&session_key);
        let id = self.next_id;
        self.next_id += 1;
        self.matches.insert(
            id,
            Match {
                a: env::predecessor_account_id(),
                b: None,
                invited: opponent,
                stake,
                duration,
                key_a: session_key.to_lowercase(),
                key_b: None,
                phase: Phase::Open,
                window_secs,
                started_ns: U64(0),
                claim: None,
                replayed: None,
                window_end_ns: U64(0),
                result: None,
            },
        );
        env::log_str(&format!("noref:create id={id}"));
        U64(id)
    }

    /// Join an open match with the same stake.
    #[payable]
    pub fn join(&mut self, id: U64, session_key: String) {
        let me = env::predecessor_account_id();
        let m = self.get_mut(id.0);
        require!(m.phase == Phase::Open, "not open");
        require!(me != m.a, "cannot play yourself");
        if let Some(inv) = &m.invited {
            require!(*inv == me, "not invited");
        }
        require!(env::attached_deposit() == m.stake, "stake must match");
        unhex32(&session_key);
        m.b = Some(me);
        m.key_b = Some(session_key.to_lowercase());
        m.phase = Phase::Live;
        m.started_ns = U64(now());
        env::log_str(&format!("noref:join id={}", id.0));
    }

    /// Creator takes the stake back before anyone joins.
    pub fn cancel(&mut self, id: U64) -> Promise {
        let me = env::predecessor_account_id();
        let m = self.get_mut(id.0);
        require!(m.phase == Phase::Open, "not open");
        require!(me == m.a, "only creator");
        m.phase = Phase::Cancelled;
        Promise::new(me).transfer(m.stake)
    }

    /// Say who won (side::FIRST = a, side::SECOND = b, side::DRAW).
    pub fn claim(&mut self, id: U64, winner: u8) {
        let me = env::predecessor_account_id();
        let m = self.get_mut(id.0);
        require!(m.phase == Phase::Live, "not live");
        require!(m.claim.is_none(), "already claimed");
        require!(Self::is_player(m, &me), "not a player");
        require!(winner <= side::SECOND, "bad side");
        let window = m.window_secs * 1_000_000_000;
        m.claim = Some(Claim { by: me, winner });
        m.window_end_ns = U64(now() + window);
        env::log_str(&format!("noref:claim id={} winner={winner}", id.0));
    }

    /// The other player agrees with the claim: pay out now. Not allowed once
    /// a replay contradicts the claim.
    pub fn confirm(&mut self, id: U64) -> Promise {
        let me = env::predecessor_account_id();
        let m = self.get_mut(id.0);
        require!(m.phase == Phase::Live, "not live");
        let claim = m.claim.clone().unwrap_or_else(|| env::panic_str("no claim"));
        require!(Self::is_player(m, &me) && me != claim.by, "only the other player");
        if let Some(r) = &m.replayed {
            require!(r.winner == claim.winner, "replay contradicts the claim");
        }
        let winner = claim.winner;
        Self::settle(m, winner)
    }

    /// Prove the result by replay. `log` is the raw input log, `signed_tick`
    /// the tick the opponent's signature covers, `signature` the opponent's
    /// 64-byte ed25519 signature over sign_digest(id, signed_tick, head).
    pub fn dispute(&mut self, id: U64, log: Base64VecU8, signed_tick: u32, signature: Base64VecU8) -> u8 {
        let me = env::predecessor_account_id();
        let m = self.get_mut(id.0);
        require!(m.phase == Phase::Live, "not live");
        require!(m.claim.is_some(), "nothing to dispute yet: claim first");
        require!(now() < m.window_end_ns.0, "window closed");
        require!(Self::is_player(m, &me), "not a player");
        if let Some(r) = &m.replayed {
            require!(signed_tick > r.signed_tick, "a longer signed log is already on record");
        }
        let opp_key = if me == m.a { m.key_b.clone().unwrap() } else { m.key_a.clone() };

        let outcome = noref_rules::replay(&log.0, m.duration, signed_tick)
            .unwrap_or_else(|e| env::panic_str(&format!("invalid log: {e:?}")));
        // the signature covers the chain head over every record <= signed_tick,
        // which (replay already enforced) is every record in the log
        let digest = noref_rules::sign_digest(id.0, signed_tick, &outcome.head);
        let sig: [u8; 64] = signature.0.as_slice().try_into().unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"));
        require!(env::ed25519_verify(&sig, &digest, &unhex32(&opp_key)), "opponent signature does not match this log");

        let window = m.window_secs * 1_000_000_000;
        m.replayed = Some(Replayed {
            signed_tick,
            winner: outcome.winner,
            by: me,
            final_root: hex(&outcome.final_root),
        });
        m.window_end_ns = U64(now() + window);
        env::log_str(&format!(
            "noref:replay id={} signed_tick={signed_tick} winner={} claim={} gas_used={}",
            id.0,
            outcome.winner,
            m.claim.as_ref().unwrap().winner,
            env::used_gas().as_gas()
        ));
        outcome.winner
    }

    /// After the window: the replayed verdict if there is one, else the claim.
    pub fn finalize(&mut self, id: U64) -> Promise {
        let m = self.get_mut(id.0);
        require!(m.phase == Phase::Live, "not live");
        let claim = m.claim.clone().unwrap_or_else(|| env::panic_str("no claim"));
        require!(now() >= m.window_end_ns.0, "window still open");
        let winner = m.replayed.as_ref().map(|r| r.winner).unwrap_or(claim.winner);
        Self::settle(m, winner)
    }

    /// Nobody claimed long after the match should have ended: refund both.
    pub fn refund(&mut self, id: U64) -> Promise {
        let m = self.get_mut(id.0);
        require!(m.phase == Phase::Live, "not live");
        require!(m.claim.is_none(), "claimed: use finalize");
        let end = m.started_ns.0 + (m.duration as u64) * 1_000_000_000 / noref_rules::TICKS_PER_SECOND as u64;
        require!(now() >= end + CLAIM_GRACE_NS, "too early");
        Self::settle(m, side::DRAW)
    }

    pub fn get_match(&self, id: U64) -> Option<Match> {
        self.matches.get(&id.0).cloned()
    }

    pub fn match_count(&self) -> U64 {
        U64(self.next_id)
    }

    fn is_player(m: &Match, who: &AccountId) -> bool {
        *who == m.a || m.b.as_ref() == Some(who)
    }

    fn get_mut(&mut self, id: u64) -> &mut Match {
        self.matches.get_mut(&id).unwrap_or_else(|| env::panic_str("no such match"))
    }

    fn settle(m: &mut Match, winner: u8) -> Promise {
        m.phase = Phase::Settled;
        m.result = Some(winner);
        let b = m.b.clone().unwrap();
        let pot = m.stake.saturating_mul(2);
        env::log_str(&format!("noref:settle winner={winner}"));
        match winner {
            side::FIRST => Promise::new(m.a.clone()).transfer(pot),
            side::SECOND => Promise::new(b).transfer(pot),
            // a draw (or a refund) pays both back. Two transfers joined with
            // `and` cannot be returned from a call ("Returning joint promise
            // is currently prohibited"), so the second runs after the first.
            _ => Promise::new(m.a.clone()).transfer(m.stake).then(Promise::new(b).transfer(m.stake)),
        }
    }
}
