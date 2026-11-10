//! NoRef engine for JavaScript. The exact same rule code the contract
//! replays disputes with, exposed through a tiny C ABI over static buffers:
//! JS writes bytes into IN, calls a function, reads STATE/OUT.
//!
//! Buffers: STATE (live table), SAVE (scratch copy for look-ahead), IN
//! (inputs / logs, 64 KiB), OUT (results, 128 bytes; bytes 64..96 hold the
//! running input-chain head for chain_step).
#![allow(static_mut_refs)]

use arena::{Arena, STATE_SIZE};
use tick_core::TickLogic;

static mut STATE: [u8; STATE_SIZE] = [0; STATE_SIZE];
static mut SAVE: [u8; STATE_SIZE] = [0; STATE_SIZE];
static mut IN: [u8; 65536] = [0; 65536];
static mut OUT: [u8; 128] = [0; 128];

fn err_code(e: noref_rules::RuleError) -> i32 {
    match e {
        noref_rules::RuleError::Malformed => -1,
        noref_rules::RuleError::BadTick => -2,
        noref_rules::RuleError::BadEntry => -3,
        noref_rules::RuleError::Game => -4,
    }
}

#[no_mangle]
pub extern "C" fn buf_state() -> *mut u8 {
    unsafe { STATE.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn buf_in() -> *mut u8 {
    unsafe { IN.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn buf_out() -> *mut u8 {
    unsafe { OUT.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn buf_in_len() -> u32 {
    65536
}
#[no_mangle]
pub extern "C" fn state_size() -> u32 {
    STATE_SIZE as u32
}
#[no_mangle]
pub extern "C" fn round_ticks() -> u32 {
    noref_rules::ROUND_TICKS
}
#[no_mangle]
pub extern "C" fn match_ticks() -> u32 {
    noref_rules::MATCH_TICKS
}
#[no_mangle]
pub extern "C" fn max_duration() -> u32 {
    noref_rules::MAX_DURATION
}
#[no_mangle]
pub extern "C" fn max_impulse() -> i64 {
    noref_rules::MAX_IMPULSE
}

/// Reset STATE to the opening position.
#[no_mangle]
pub extern "C" fn init() {
    unsafe { Arena::init(&mut STATE).unwrap() }
}

/// Advance STATE one tick with `in_len` bytes of inputs from IN. 0 = ok.
#[no_mangle]
pub extern "C" fn tick(in_len: u32, t: u32) -> i32 {
    unsafe {
        match Arena::tick(&mut STATE, &IN[..in_len as usize], t as u64) {
            Ok(()) => 0,
            Err(_) => -4,
        }
    }
}

#[no_mangle]
pub extern "C" fn verdict() -> i32 {
    unsafe { arena::verdict(&STATE).map(|v| v as i32).unwrap_or(-4) }
}

#[no_mangle]
pub extern "C" fn at_rest() -> i32 {
    unsafe { Arena::at_rest(&STATE) as i32 }
}

/// Squared distance of a ball to the center, as f64 in whole units^2
/// (display and NPC scoring only; never used to decide anything).
#[no_mangle]
pub extern "C" fn center_dist2_units(ball: u32) -> i64 {
    unsafe { (arena::center_dist2(&STATE, ball as usize) >> 64) as i64 }
}

#[no_mangle]
pub extern "C" fn save() {
    unsafe { SAVE.copy_from_slice(&STATE) }
}

#[no_mangle]
pub extern "C" fn restore() {
    unsafe { STATE.copy_from_slice(&SAVE) }
}

/// Replay the log in IN[..log_len]. OUT[0] winner, OUT[1..33] head,
/// OUT[33..65] final state root. Returns winner or a negative error code.
#[no_mangle]
pub extern "C" fn replay(log_len: u32, duration: u32, signed_tick: u32) -> i32 {
    unsafe {
        match noref_rules::replay(&IN[..log_len as usize], duration, signed_tick) {
            Ok(o) => {
                OUT[0] = o.winner;
                OUT[1..33].copy_from_slice(&o.head);
                OUT[33..65].copy_from_slice(&o.final_root);
                o.winner as i32
            }
            Err(e) => err_code(e),
        }
    }
}

/// Input chain head of IN[..log_len] up to tick `upto`, into OUT[0..32].
#[no_mangle]
pub extern "C" fn head_at(log_len: u32, duration: u32, upto: u32) -> i32 {
    unsafe {
        match noref_rules::head_at(&IN[..log_len as usize], duration, upto) {
            Ok(h) => {
                OUT[..32].copy_from_slice(&h);
                0
            }
            Err(e) => err_code(e),
        }
    }
}

/// OUT[64..96] = chain_step(OUT[64..96], tick, IN[..entries_len]).
#[no_mangle]
pub extern "C" fn chain_step(tick: u32, entries_len: u32) {
    unsafe {
        let mut head = [0u8; 32];
        head.copy_from_slice(&OUT[64..96]);
        let next = noref_rules::chain_step(&head, tick, &IN[..entries_len as usize]);
        OUT[64..96].copy_from_slice(&next);
    }
}

/// OUT[0..32] = sign_digest(match_id, tick, IN[0..32]).
#[no_mangle]
pub extern "C" fn sign_digest(match_id: u64, tick: u32) {
    unsafe {
        let mut head = [0u8; 32];
        head.copy_from_slice(&IN[..32]);
        let d = noref_rules::sign_digest(match_id, tick, &head);
        OUT[..32].copy_from_slice(&d);
    }
}

/// Advance STATE `n` ticks with no inputs, starting at tick index `start`.
/// Stops early once everything is at rest. Returns ticks actually run.
#[no_mangle]
pub extern "C" fn run_ticks(n: u32, start: u32) -> u32 {
    unsafe {
        for k in 0..n {
            if Arena::at_rest(&STATE) {
                return k;
            }
            if Arena::tick(&mut STATE, &[], (start + k) as u64).is_err() {
                return k;
            }
        }
        n
    }
}
