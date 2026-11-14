//! NoRef fighter vault. Deployed on an NPC fighter's own account, so the
//! fighter's bankroll *is* this contract's balance and the rules for that
//! money are code, not a promise from whoever runs the NPC.
//!
//! - **Playing.** The operator (the server that picks the NPC's moves) holds
//!   only a function-call key for this account, limited to the `play_*`
//!   methods. Those can only call the NoRef arena (`create`, `join`,
//!   `claim`, `confirm`, `dispute`, `cancel`) and every stake is checked
//!   here: at least `min_stake`, at most 1/`risk_share` of the bankroll. A
//!   fighter that cannot stake the minimum is closed. No method sends money
//!   anywhere else on the operator's say-so.
//! - **Shares.** Anyone can `back` the fighter with NEAR and get shares at
//!   the current price (bankroll / shares); `cash_out` burns shares and pays
//!   their value. The price comes from this account's own balance, so no
//!   oracle is involved. Both are refused while a stake is out in a match,
//!   so nobody buys in cheap mid-match or sells out before a loss lands.
//! - **Dividends.** When the bankroll passes `div_at`, anyone can call
//!   `pay_dividends`: everything above `div_keep` is set aside for the
//!   shareholders pro rata, and `claim_dividend` (anyone may trigger it for
//!   any holder) pays each holder their part.
//! - **Matches in play.** Stakes sent to the arena are remembered until
//!   `sync(id)` (anyone may call it) sees the match settled or cancelled.
//!
//! Written small on purpose (no generated cross-contract bindings, no
//! base64 codec, no `format!`): the code is stored on six accounts and
//! NEAR charges storage per byte.
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError};

/// Dividend accumulator precision.
const SCALE: u128 = 1_000_000_000_000;
/// One share at the start is worth one milliNEAR.
const MILLI: u128 = 1_000_000_000_000_000_000_000;
const MIN_BACK: u128 = 10 * MILLI;

#[derive(serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ArenaMatch {
    pub phase: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Holder {
    pub shares: U128,
    /// shares * acc / SCALE at the last update; the difference is unpaid dividend
    pub debt: U128,
}

#[near(serializers = [json])]
pub struct Info {
    pub name: String,
    pub arena: AccountId,
    /// yoctoNEAR the shares are worth: balance minus storage, gas reserve and unpaid dividends
    pub bankroll: U128,
    pub total_shares: U128,
    /// yoctoNEAR per share
    pub price: U128,
    pub holders: u32,
    pub in_play: Vec<(U64, U128)>,
    pub max_stake: U128,
    pub min_stake: U128,
    pub closed: bool,
    pub owed_dividends: U128,
    pub div_at: U128,
    pub div_keep: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Fighter {
    name: String,
    arena: AccountId,
    min_stake: u128,
    risk_share: u128,
    reserve: u128,
    div_at: u128,
    div_keep: u128,
    total_shares: u128,
    holders: LookupMap<AccountId, Holder>,
    holder_list: Vec<AccountId>,
    acc: u128,
    owed: u128,
    /// (match id, stake) out in the arena
    in_play: Vec<(u64, u128)>,
}

fn num(mut n: u128) -> String {
    let mut b = [0u8; 40];
    let mut i = b.len();
    loop {
        i -= 1;
        b[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    String::from_utf8_lossy(&b[i..]).into_owned()
}

/// JSON string literal for values we only pass through (account ids, hex keys, base64).
fn q(s: &str) -> String {
    require!(!s.contains('"') && !s.contains('\\'), "bad string");
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    o.push_str(s);
    o.push('"');
    o
}

#[near]
impl Fighter {
    /// `holders`: the shares that exist already (e.g. carried over from an
    /// off-chain register), in milliNEAR-at-start units. With none, the whole
    /// bankroll is minted to `founder` at one share per milliNEAR.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        name: String,
        arena: AccountId,
        founder: AccountId,
        holders: Vec<(AccountId, U128)>,
        min_stake: U128,
        risk_share: u32,
        reserve: U128,
        div_at: U128,
        div_keep: U128,
    ) -> Self {
        require!(risk_share >= 2, "risk_share must be at least 2");
        require!(div_keep.0 < div_at.0, "div_keep must be below div_at");
        let mut f = Self {
            name,
            arena,
            min_stake: min_stake.0,
            risk_share: risk_share as u128,
            reserve: reserve.0,
            div_at: div_at.0,
            div_keep: div_keep.0,
            total_shares: 0,
            holders: LookupMap::new(b"h"),
            holder_list: Vec::new(),
            acc: 0,
            owed: 0,
            in_play: Vec::new(),
        };
        if holders.is_empty() {
            let s = f.bankroll(0) / MILLI;
            require!(s > 0, "nothing to mint: fund the account first");
            f.mint(&founder, s);
        } else {
            for (who, s) in holders {
                f.mint(&who, s.0);
            }
        }
        f
    }

    // ---------------- shares ----------------

    /// Buy shares at the current price with the attached NEAR.
    #[payable]
    pub fn back(&mut self) -> U128 {
        self.require_idle();
        let d = env::attached_deposit().as_yoctonear();
        require!(d >= MIN_BACK, "back with at least 0.01 NEAR");
        let before = self.bankroll(d);
        let s = if self.total_shares == 0 || before == 0 { d / MILLI } else { d * self.total_shares / before };
        require!(s > 0, "too small for one share");
        let who = env::predecessor_account_id();
        self.pay_pending(&who);
        self.mint(&who, s);
        U128(s)
    }

    /// Sell shares at the current price; unpaid dividends are paid too.
    pub fn cash_out(&mut self, shares: U128) -> Promise {
        self.require_idle();
        let who = env::predecessor_account_id();
        let have = self.holders.get(&who).map(|h| h.shares.0).unwrap_or(0);
        require!(shares.0 > 0 && shares.0 <= have, "not that many shares");
        // value first: taking the dividend lowers `owed`, which would inflate the bankroll
        let amount = shares.0 * self.bankroll(0) / self.total_shares;
        let pending = self.take_pending(&who);
        self.burn(&who, shares.0);
        Promise::new(who).transfer(NearToken::from_yoctonear(amount + pending))
    }

    /// Set aside everything above `div_keep` for the shareholders, once the
    /// bankroll passes `div_at`. Anyone may call it.
    pub fn pay_dividends(&mut self) -> U128 {
        self.require_idle();
        require!(self.total_shares > 0, "no shares");
        let b = self.bankroll(0);
        require!(b > self.div_at, "bankroll is not above the dividend line");
        let amount = b - self.div_keep;
        self.acc += amount * SCALE / self.total_shares;
        self.owed += amount;
        U128(amount)
    }

    /// Pay a holder their unpaid dividends. Anyone may call it, for anyone:
    /// the money only ever goes to that holder.
    pub fn claim_dividend(&mut self, account_id: AccountId) -> U128 {
        let p = self.take_pending(&account_id);
        if p > 0 {
            let _ = Promise::new(account_id).transfer(NearToken::from_yoctonear(p));
        }
        U128(p)
    }

    // ---------------- playing (operator key only) ----------------

    pub fn play_create(&mut self, duration: u32, session_key: String, window_secs: u64, opponent: Option<AccountId>, stake: U128) -> Promise {
        self.require_operator();
        self.check_stake(stake.0);
        let opp = opponent.map(|o| q(o.as_str())).unwrap_or_else(|| "null".into());
        let args = "{\"duration\":".to_string() + &num(duration as u128) + ",\"session_key\":" + &q(&session_key) + ",\"window_secs\":" + &num(window_secs as u128) + ",\"opponent\":" + &opp + "}";
        self.arena_call("create", args, stake.0, 20)
            .then(Promise::new(env::current_account_id()).function_call("on_created", ("{\"stake\":\"".to_string() + &num(stake.0) + "\"}").into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(10)))
    }

    pub fn play_join(&mut self, id: U64, session_key: String, stake: U128) -> Promise {
        self.require_operator();
        self.check_stake(stake.0);
        let args = "{\"id\":\"".to_string() + &num(id.0 as u128) + "\",\"session_key\":" + &q(&session_key) + "}";
        self.arena_call("join", args, stake.0, 20).then(Promise::new(env::current_account_id()).function_call(
            "on_joined",
            ("{\"id\":\"".to_string() + &num(id.0 as u128) + "\",\"stake\":\"" + &num(stake.0) + "\"}").into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(10),
        ))
    }

    pub fn play_claim(&mut self, id: U64, winner: u8) -> Promise {
        self.require_operator();
        self.arena_call("claim", "{\"id\":\"".to_string() + &num(id.0 as u128) + "\",\"winner\":" + &num(winner as u128) + "}", 0, 20)
    }

    pub fn play_confirm(&mut self, id: U64) -> Promise {
        self.require_operator();
        self.arena_call("confirm", "{\"id\":\"".to_string() + &num(id.0 as u128) + "\"}", 0, 20)
    }

    pub fn play_cancel(&mut self, id: U64) -> Promise {
        self.require_operator();
        self.arena_call("cancel", "{\"id\":\"".to_string() + &num(id.0 as u128) + "\"}", 0, 20)
    }

    /// `log` and `signature` are base64, passed to the arena as they are.
    pub fn play_dispute(&mut self, id: U64, log: String, signed_tick: u32, signature: String) -> Promise {
        self.require_operator();
        let args = "{\"id\":\"".to_string() + &num(id.0 as u128) + "\",\"log\":" + &q(&log) + ",\"signed_tick\":" + &num(signed_tick as u128) + ",\"signature\":" + &q(&signature) + "}";
        // the replay needs most of a transaction's gas: give it all that is left
        Promise::new(self.arena.clone()).function_call_weight("dispute", args.into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(200), GasWeight(1))
    }

    #[private]
    pub fn on_created(&mut self, #[callback_result] r: Result<U64, PromiseError>, stake: U128) -> U64 {
        // on failure the arena refunds the deposit to us
        let id = r.unwrap_or_else(|_| env::panic_str("arena create failed"));
        self.in_play.push((id.0, stake.0));
        id
    }

    #[private]
    pub fn on_joined(&mut self, #[callback_result] r: Result<(), PromiseError>, id: U64, stake: U128) {
        require!(r.is_ok(), "arena join failed");
        self.in_play.push((id.0, stake.0));
    }

    // ---------------- bookkeeping anyone can trigger ----------------

    /// Forget a match's stake once the arena says it is over.
    pub fn sync(&mut self, id: U64) -> Promise {
        require!(self.in_play.iter().any(|(k, _)| *k == id.0), "not in play");
        let args = "{\"id\":\"".to_string() + &num(id.0 as u128) + "\"}";
        self.arena_call("get_match", args.clone(), 0, 10)
            .then(Promise::new(env::current_account_id()).function_call("on_synced", args.into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(10)))
    }

    #[private]
    pub fn on_synced(&mut self, #[callback_result] r: Result<Option<ArenaMatch>, PromiseError>, id: U64) -> bool {
        let over = matches!(&r, Ok(Some(m)) if m.phase == "Settled" || m.phase == "Cancelled");
        if over {
            self.in_play.retain(|(k, _)| *k != id.0);
        }
        over
    }

    // ---------------- views ----------------

    pub fn info(&self) -> Info {
        let b = self.bankroll(0);
        Info {
            name: self.name.clone(),
            arena: self.arena.clone(),
            bankroll: U128(b),
            total_shares: U128(self.total_shares),
            price: U128(if self.total_shares > 0 { b / self.total_shares } else { MILLI }),
            holders: self.holder_list.len() as u32,
            in_play: self.in_play.iter().map(|(k, v)| (U64(*k), U128(*v))).collect(),
            max_stake: U128(b / self.risk_share),
            min_stake: U128(self.min_stake),
            closed: b / self.risk_share < self.min_stake,
            owed_dividends: U128(self.owed),
            div_at: U128(self.div_at),
            div_keep: U128(self.div_keep),
        }
    }

    /// (shares, unpaid dividend in yoctoNEAR)
    pub fn shares_of(&self, account_id: AccountId) -> (U128, U128) {
        match self.holders.get(&account_id) {
            Some(h) => (h.shares, U128(self.pending(h))),
            None => (U128(0), U128(0)),
        }
    }

    /// Every holder and their shares.
    pub fn holders(&self) -> Vec<(AccountId, U128)> {
        self.holder_list.iter().map(|a| (a.clone(), self.holders.get(a).map(|h| h.shares).unwrap_or(U128(0)))).collect()
    }

    // ---------------- internals ----------------

    fn arena_call(&self, method: &str, args: String, deposit: u128, tgas: u64) -> Promise {
        Promise::new(self.arena.clone()).function_call(method.to_string(), args.into_bytes(), NearToken::from_yoctonear(deposit), Gas::from_tgas(tgas))
    }

    /// What the shares are worth: balance minus `extra` (a deposit being
    /// handled right now), storage, the gas reserve and unpaid dividends.
    /// Stakes out in a match are not counted (back/cash_out wait for them).
    fn bankroll(&self, extra: u128) -> u128 {
        let bal = env::account_balance().as_yoctonear().saturating_sub(extra);
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        bal.saturating_sub(storage + self.reserve + self.owed)
    }

    fn require_operator(&self) {
        require!(env::predecessor_account_id() == env::current_account_id(), "only the fighter's own key can play");
    }

    fn require_idle(&self) {
        require!(self.in_play.is_empty(), "the fighter has a stake out in a match: try again when it settles");
    }

    fn check_stake(&self, stake: u128) {
        require!(self.in_play.is_empty(), "already in a match");
        require!(stake >= self.min_stake, "stake below the fighter's minimum");
        let max = self.bankroll(0) / self.risk_share;
        require!(max >= self.min_stake, "the fighter is closed: its bankroll cannot cover the minimum stake");
        require!(stake <= max, "stake above 1/risk_share of the bankroll");
    }

    fn pending(&self, h: &Holder) -> u128 {
        (h.shares.0 * self.acc / SCALE).saturating_sub(h.debt.0)
    }

    fn take_pending(&mut self, who: &AccountId) -> u128 {
        let acc = self.acc;
        let Some(h) = self.holders.get_mut(who) else { return 0 };
        let p = (h.shares.0 * acc / SCALE).saturating_sub(h.debt.0);
        h.debt = U128(h.shares.0 * acc / SCALE);
        let p = p.min(self.owed);
        self.owed -= p;
        p
    }

    fn pay_pending(&mut self, who: &AccountId) {
        let p = self.take_pending(who);
        if p > 0 {
            let _ = Promise::new(who.clone()).transfer(NearToken::from_yoctonear(p));
        }
    }

    fn mint(&mut self, who: &AccountId, s: u128) {
        let acc = self.acc;
        let mut h = self.holders.get(who).cloned().unwrap_or_default();
        if h.shares.0 == 0 {
            self.holder_list.push(who.clone());
        }
        h.shares = U128(h.shares.0 + s);
        h.debt = U128(h.shares.0 * acc / SCALE);
        self.holders.insert(who.clone(), h);
        self.total_shares += s;
    }

    fn burn(&mut self, who: &AccountId, s: u128) {
        let acc = self.acc;
        let mut h = self.holders.get(who).cloned().unwrap();
        h.shares = U128(h.shares.0 - s);
        h.debt = U128(h.shares.0 * acc / SCALE);
        if h.shares.0 == 0 {
            self.holders.remove(who);
            self.holder_list.retain(|a| a != who);
        } else {
            self.holders.insert(who.clone(), h);
        }
        self.total_shares -= s;
    }
}
