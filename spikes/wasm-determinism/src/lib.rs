//! Spike: does the arena tick produce bit-identical state natively and in wasm32?
//! `run(seed, n)` plays n ticks with pseudo-random impulses and returns an
//! FNV-1a digest folded over the full state after every tick.
#![cfg_attr(target_arch = "wasm32", no_std)]
use arena::{Arena, INPUT_ENTRY_SIZE, N_BALLS, STATE_SIZE};
use tick_core::{le, rng::Rng, TickLogic};

pub fn digest_run(seed: u64, n: u64) -> u64 {
    let mut state = [0u8; STATE_SIZE];
    Arena::init(&mut state).unwrap();
    let mut rng = Rng::new(seed);
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut inputs = [0u8; INPUT_ENTRY_SIZE * 2];
    for t in 0..n {
        let k = (rng.next_below(3)) as usize; // 0..2 impulses this tick
        for j in 0..k {
            let off = j * INPUT_ENTRY_SIZE;
            le::write_u32(&mut inputs, off, rng.next_below(N_BALLS as u64) as u32);
            // impulses up to +-4.0 in Q32.32, plus occasional huge ones to hit saturation paths
            let big = rng.next_below(50) == 0;
            let mag: i64 = if big { i64::MAX / 3 } else { 4i64 << 32 };
            let dvx = (rng.next_u64() as i64) % mag;
            let dvy = (rng.next_u64() as i64) % mag;
            le::write_i64(&mut inputs, off + 4, dvx);
            le::write_i64(&mut inputs, off + 12, dvy);
        }
        Arena::tick(&mut state, &inputs[..k * INPUT_ENTRY_SIZE], t).unwrap();
        for b in state.iter() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
    }
    h
}

#[no_mangle]
pub extern "C" fn run(seed: u64, n: u64) -> u64 {
    digest_run(seed, n)
}

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
