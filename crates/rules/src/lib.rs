//! NoRef match rules. One crate, three users: the contract (dispute
//! replay), the off-chain runner and the browser client. Anything that
//! decides who won lives here so they can never disagree.
//!
//! Match model:
//! - player A flicks ball 0, player B flicks ball 1, the other balls are
//!   pegs. A match is ROUNDS rounds of ROUND_TICKS ticks at 60 Hz; at the
//!   first tick of each round both players flick at once (commit-reveal
//!   off-chain), then the table runs until the next round.
//! - The input log is a list of records `tick u32 | n u8 | n entries`,
//!   strictly increasing by tick, each entry an arena input
//!   (`ball u32 | dvx i64 | dvy i64`). Ticks without a record get no input.
//! - Input chain: `head = H("noref/in", head, tick, entries)` per record,
//!   starting from all zero. Both clients compute it as they play and sign
//!   `H("noref/sig/v1", match_id, tick, head)` about once a second.
//! - A dispute submits a log plus the opponent's signature over the head
//!   at the log's last signed tick. The contract replays the whole match
//!   (inputs after that tick are simply absent) and reads the verdict.
#![no_std]

use arena::{Arena, INPUT_ENTRY_SIZE, STATE_SIZE};
use sha2::{Digest, Sha256};
use tick_core::{le, TickLogic};

pub use arena::side;

/// 60 Hz.
pub const TICKS_PER_SECOND: u32 = 60;
/// One round: 3 seconds. Inputs may only land on a round's first tick.
pub const ROUND_TICKS: u32 = 3 * TICKS_PER_SECOND;
/// Standard match length.
pub const ROUNDS: u32 = 6;
pub const MATCH_TICKS: u32 = ROUNDS * ROUND_TICKS;
/// Longest match the contract will replay in one call: 30 rounds (90 s).
/// Measured on sandbox: 6 rounds ~20 Tgas, 100 rounds ~296 Tgas (too close
/// to the 300 Tgas cap), so 30 rounds keeps a wide margin.
pub const MAX_DURATION: u32 = 30 * ROUND_TICKS;
/// Flick strength cap (vector length), 12.0 units/tick in Q32.32.
pub const MAX_IMPULSE: i64 = 12 << 32;
/// At most one entry per player per tick.
pub const MAX_ENTRIES_PER_TICK: usize = 2;

const IN_TAG: &[u8] = b"noref/in";
const SIG_TAG: &[u8] = b"noref/sig/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleError {
    /// log bytes don't parse
    Malformed,
    /// ticks not strictly increasing, or past the match end
    BadTick,
    /// entry for a ball no player controls, impulse over the cap, or two
    /// entries for the same ball in one tick
    BadEntry,
    Game,
}

/// One parsed log record.
#[derive(Debug, Clone, Copy)]
pub struct Record<'a> {
    pub tick: u32,
    pub entries: &'a [u8],
}

/// Iterates and validates records of a log.
pub struct Records<'a> {
    log: &'a [u8],
    off: usize,
    last_tick: Option<u32>,
    duration: u32,
}

impl<'a> Records<'a> {
    pub fn new(log: &'a [u8], duration: u32) -> Self {
        Records { log, off: 0, last_tick: None, duration }
    }
}

fn check_entries(entries: &[u8]) -> Result<(), RuleError> {
    let n = entries.len() / INPUT_ENTRY_SIZE;
    if n == 0 || n > MAX_ENTRIES_PER_TICK {
        return Err(RuleError::BadEntry);
    }
    let mut seen = [false; 2];
    for i in 0..n {
        let off = i * INPUT_ENTRY_SIZE;
        let ball = le::read_u32(entries, off) as usize;
        if ball > 1 || seen[ball] {
            return Err(RuleError::BadEntry);
        }
        seen[ball] = true;
        let dvx = le::read_i64(entries, off + 4) as i128;
        let dvy = le::read_i64(entries, off + 12) as i128;
        let max = MAX_IMPULSE as i128;
        if dvx * dvx + dvy * dvy > max * max {
            return Err(RuleError::BadEntry);
        }
    }
    Ok(())
}

impl<'a> Iterator for Records<'a> {
    type Item = Result<Record<'a>, RuleError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.off == self.log.len() {
            return None;
        }
        let rest = &self.log[self.off..];
        if rest.len() < 5 {
            self.off = self.log.len();
            return Some(Err(RuleError::Malformed));
        }
        let tick = le::read_u32(rest, 0);
        let n = rest[4] as usize;
        let len = n * INPUT_ENTRY_SIZE;
        if rest.len() < 5 + len {
            self.off = self.log.len();
            return Some(Err(RuleError::Malformed));
        }
        if tick >= self.duration || tick % ROUND_TICKS != 0 || self.last_tick.is_some_and(|t| tick <= t) {
            self.off = self.log.len();
            return Some(Err(RuleError::BadTick));
        }
        let entries = &rest[5..5 + len];
        if let Err(e) = check_entries(entries) {
            self.off = self.log.len();
            return Some(Err(e));
        }
        self.last_tick = Some(tick);
        self.off += 5 + len;
        Some(Ok(Record { tick, entries }))
    }
}

/// Advance the input chain by one record.
pub fn chain_step(head: &[u8; 32], tick: u32, entries: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(IN_TAG);
    h.update(head);
    h.update(tick.to_le_bytes());
    h.update(entries);
    h.finalize().into()
}

/// Input chain head over every record with tick <= `upto`.
pub fn head_at(log: &[u8], duration: u32, upto: u32) -> Result<[u8; 32], RuleError> {
    let mut head = [0u8; 32];
    for r in Records::new(log, duration) {
        let r = r?;
        if r.tick > upto {
            break;
        }
        head = chain_step(&head, r.tick, r.entries);
    }
    Ok(head)
}

/// The 32-byte digest a player signs (ed25519) to endorse the log up to `tick`.
pub fn sign_digest(match_id: u64, tick: u32, head: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(SIG_TAG);
    h.update(match_id.to_le_bytes());
    h.update(tick.to_le_bytes());
    h.update(head);
    h.finalize().into()
}

/// Result of replaying a whole match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Outcome {
    pub winner: u8,
    /// input chain head over the whole submitted log
    pub head: [u8; 32],
    /// merkle root of the final state
    pub final_root: [u8; 32],
}

/// Replay the full match from genesis. Every record in `log` must have
/// tick <= `signed_tick` (the opponent only endorsed that much); ticks
/// after it run with no inputs until `duration`.
pub fn replay(log: &[u8], duration: u32, signed_tick: u32) -> Result<Outcome, RuleError> {
    if duration == 0 || duration > MAX_DURATION || duration % ROUND_TICKS != 0 || signed_tick >= duration {
        return Err(RuleError::BadTick);
    }
    let mut state = [0u8; STATE_SIZE];
    Arena::init(&mut state).map_err(|_| RuleError::Game)?;
    let mut head = [0u8; 32];
    let mut records = Records::new(log, duration).peekable();
    for t in 0..duration {
        let mut inputs: &[u8] = &[];
        if let Some(Ok(r)) = records.peek() {
            if r.tick == t {
                if r.tick > signed_tick {
                    return Err(RuleError::BadTick);
                }
                inputs = r.entries;
                head = chain_step(&head, r.tick, r.entries);
                records.next();
            }
        } else if let Some(Err(e)) = records.peek() {
            return Err(*e);
        }
        Arena::tick(&mut state, inputs, t as u64).map_err(|_| RuleError::Game)?;
    }
    if let Some(r) = records.next() {
        r?;
        return Err(RuleError::BadTick);
    }
    let winner = arena::verdict(&state).map_err(|_| RuleError::Game)?;
    Ok(Outcome { winner, head, final_root: tick_merkle::state_root(&state) })
}

/// Is `duration` a valid match length?
pub fn valid_duration(duration: u32) -> bool {
    duration > 0 && duration <= MAX_DURATION && duration % ROUND_TICKS == 0
}

/// Encode one record (helper for clients/tests). Writes into `out`, returns bytes written.
pub fn encode_record(out: &mut [u8], tick: u32, entries: &[(u32, i64, i64)]) -> usize {
    le::write_u32(out, 0, tick);
    out[4] = entries.len() as u8;
    let mut off = 5;
    for (ball, dvx, dvy) in entries {
        le::write_u32(out, off, *ball);
        le::write_i64(out, off + 4, *dvx);
        le::write_i64(out, off + 12, *dvy);
        off += INPUT_ENTRY_SIZE;
    }
    off
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::vec::Vec;

    const R: u32 = ROUND_TICKS;
    const D: u32 = MATCH_TICKS;

    fn log_of(recs: &[(u32, &[(u32, i64, i64)])]) -> Vec<u8> {
        let mut v = Vec::new();
        for (t, e) in recs {
            let mut buf = [0u8; 5 + 2 * INPUT_ENTRY_SIZE];
            let n = encode_record(&mut buf, *t, e);
            v.extend_from_slice(&buf[..n]);
        }
        v
    }

    #[test]
    fn empty_match_is_a_draw() {
        let o = replay(&[], D, 0).unwrap();
        assert_eq!(o.winner, side::DRAW);
        assert_eq!(o.head, [0u8; 32]);
    }

    #[test]
    fn replay_equals_manual_play() {
        let one = 1i64 << 32;
        let log = log_of(&[(0, &[(0, 5 * one, one)]), (R, &[(1, -6 * one, 0), (0, 0, -one)]), (3 * R, &[(1, 0, one)])]);
        let o = replay(&log, D, D - 1).unwrap();

        let mut s = [0u8; STATE_SIZE];
        Arena::init(&mut s).unwrap();
        let mut head = [0u8; 32];
        for t in 0..D {
            let rec = Records::new(&log, D).map(|r| r.unwrap()).find(|r| r.tick == t);
            let inp = rec.map(|r| r.entries).unwrap_or(&[]);
            if let Some(r) = rec {
                head = chain_step(&head, r.tick, r.entries);
            }
            Arena::tick(&mut s, inp, t as u64).unwrap();
        }
        assert_eq!(o.final_root, tick_merkle::state_root(&s));
        assert_eq!(o.winner, arena::verdict(&s).unwrap());
        assert_eq!(o.head, head);
        assert_eq!(head_at(&log, D, D - 1).unwrap(), head);
    }

    #[test]
    fn head_at_is_a_prefix_commitment() {
        let one = 1i64 << 32;
        let log = log_of(&[(0, &[(0, one, 0)]), (R, &[(1, 0, one)])]);
        let short = log_of(&[(0, &[(0, one, 0)])]);
        assert_eq!(head_at(&log, D, R - 1).unwrap(), head_at(&short, D, D - 1).unwrap());
        assert_ne!(head_at(&log, D, R).unwrap(), head_at(&short, D, R).unwrap());
    }

    #[test]
    fn rejects_bad_logs() {
        let one = 1i64 << 32;
        // ball 2 is a peg, not a player
        assert_eq!(replay(&log_of(&[(0, &[(2, one, 0)])]), D, D - 1), Err(RuleError::BadEntry));
        // flick over the cap (vector length)
        assert_eq!(replay(&log_of(&[(0, &[(0, 9 * one, 9 * one)])]), D, D - 1), Err(RuleError::BadEntry));
        assert!(replay(&log_of(&[(0, &[(0, MAX_IMPULSE, 0)])]), D, D - 1).is_ok());
        // same ball twice in one tick
        assert_eq!(replay(&log_of(&[(0, &[(0, one, 0), (0, one, 0)])]), D, D - 1), Err(RuleError::BadEntry));
        // input off a round boundary
        assert_eq!(replay(&log_of(&[(5, &[(0, one, 0)])]), D, D - 1), Err(RuleError::BadTick));
        // rounds out of order
        assert_eq!(replay(&log_of(&[(R, &[(0, one, 0)]), (R, &[(1, one, 0)])]), D, D - 1), Err(RuleError::BadTick));
        // record past what the opponent signed
        assert_eq!(replay(&log_of(&[(2 * R, &[(0, one, 0)])]), D, R), Err(RuleError::BadTick));
        // record past the match end
        assert_eq!(replay(&log_of(&[(D, &[(0, one, 0)])]), D, D - 1), Err(RuleError::BadTick));
        // truncated bytes
        let mut l = log_of(&[(0, &[(0, one, 0)])]);
        l.pop();
        assert_eq!(replay(&l, D, D - 1), Err(RuleError::Malformed));
        // bad lengths
        assert_eq!(replay(&[], MAX_DURATION + R, 0), Err(RuleError::BadTick));
        assert_eq!(replay(&[], D + 1, 0), Err(RuleError::BadTick));
    }
}
