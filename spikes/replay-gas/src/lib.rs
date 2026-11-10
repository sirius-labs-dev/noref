//! Spike contract. `replay_tick` is the expensive half of a one-step dispute:
//! check the pre-state root, run one arena tick with the same game code the
//! off-chain runner uses, return the post-state root. `replay_n` runs n ticks
//! with no inputs, to see how much replay fits in one call.
use arena::{Arena, STATE_SIZE};
use near_sdk::json_types::Base64VecU8;
use near_sdk::{env, near, require};
use tick_core::TickLogic;

fn hex(b: &[u8; 32]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(64);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

#[near(contract_state)]
#[derive(Default)]
pub struct ReplayGas {}

#[near]
impl ReplayGas {
    /// Genesis state, so callers can start a replay chain.
    pub fn genesis(&self) -> Base64VecU8 {
        let mut s = vec![0u8; STATE_SIZE];
        Arena::init(&mut s).unwrap();
        s.into()
    }

    /// One-step proof core: pre-root must match, run one tick, return post-root.
    pub fn replay_tick(&self, state: Base64VecU8, inputs: Base64VecU8, tick_index: u64, pre_root: String) -> String {
        let mut s: Vec<u8> = state.into();
        require!(s.len() == STATE_SIZE, "bad state size");
        require!(hex(&tick_merkle::state_root(&s)) == pre_root, "pre-state root mismatch");
        Arena::tick(&mut s, &inputs.0, tick_index).unwrap_or_else(|_| env::panic_str("bad input"));
        let post = hex(&tick_merkle::state_root(&s));
        env::log_str(&format!("gas_used={}", env::used_gas().as_gas()));
        post
    }

    /// Replay n ticks with empty inputs from `state`; returns the final root.
    pub fn replay_n(&self, state: Base64VecU8, n: u64) -> String {
        let mut s: Vec<u8> = state.into();
        require!(s.len() == STATE_SIZE, "bad state size");
        for t in 0..n {
            Arena::tick(&mut s, &[], t).unwrap();
        }
        let root = hex(&tick_merkle::state_root(&s));
        env::log_str(&format!("gas_used={}", env::used_gas().as_gas()));
        root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_matches_native() {
        let c = ReplayGas::default();
        let g: Vec<u8> = c.genesis().into();
        let pre = hex(&tick_merkle::state_root(&g));
        // ball 0 gets a +1.0 impulse in x
        let mut inp = vec![0u8; arena::INPUT_ENTRY_SIZE];
        tick_core::le::write_i64(&mut inp, 4, 1i64 << 32);
        let post = c.replay_tick(g.clone().into(), inp.clone().into(), 0, pre);

        let mut s = g;
        Arena::tick(&mut s, &inp, 0).unwrap();
        assert_eq!(post, hex(&tick_merkle::state_root(&s)));
    }
}
