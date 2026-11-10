//! NoRef arena: a flick-and-park duel on a 256x256 table.
//!
//! Ball 0 is player A's, ball 1 is player B's, balls 2..7 are pegs in a
//! ring around the center. Every ball is a disc of radius 8 with equal
//! mass; discs collide elastically, bounce off the walls and slow down
//! under friction until they stop. Whoever's ball rests closer to the
//! center wins. The start is mirror-symmetric (x -> 256 - x swaps A and B),
//! so neither side starts ahead.
//!
//! Everything is Q32.32 fixed point with i128 intermediates, no floats, no
//! heap, no host calls: the same bytes in, the same bytes out, natively,
//! in the browser and inside the NEAR contract.

#![no_std]
#![deny(clippy::float_arithmetic)]
#![deny(unsafe_code)]

use tick_core::fx::{self, Fx};
use tick_core::{le, TickError, TickLogic};

pub const N_BALLS: usize = 8;

/// State layout, little-endian:
///   0..8        tick counter (u64)
///   8 + i*32    ball i: pos_x, pos_y, vel_x, vel_y (4 x i64, Q32.32)
pub const STATE_SIZE: usize = 8 + N_BALLS * 32;

/// One input entry: ball index (u32) + impulse dvx, dvy (2 x i64, Q32.32).
pub const INPUT_ENTRY_SIZE: usize = 4 + 8 + 8;

pub const ARENA_SIZE: i32 = 256;
const ARENA_MIN: Fx = 0;
const ARENA_MAX: Fx = fx::from_int(ARENA_SIZE);
pub const RADIUS: i32 = 8;
const MIN_DIST: Fx = fx::from_int(2 * RADIUS);
/// velocity *= 1 - 1/16 per tick: a flick of speed v travels about 16 v
const FRICTION: Fx = fx::ONE - (fx::ONE >> 4);
/// below 1/256 unit per tick a ball is considered at rest
const REST: Fx = fx::ONE >> 8;
/// walls give back 80% of the speed
const WALL_RESTITUTION: Fx = (fx::ONE / 5) * 4;

pub const CENTER: Fx = fx::from_int(128);

pub struct Arena;

/// Start positions in whole units: A left, B right, six pegs on a ring of
/// radius 48 around the center at 0, 60, ..., 300 degrees.
pub const START: [(i32, i32); N_BALLS] = [
    (40, 128),
    (216, 128),
    (176, 128),
    (152, 170),
    (104, 170),
    (80, 128),
    (104, 86),
    (152, 86),
];

impl Arena {
    pub fn init(state: &mut [u8]) -> Result<(), TickError> {
        if state.len() != STATE_SIZE {
            return Err(TickError::BadStateSize);
        }
        state.fill(0);
        for (i, (x, y)) in START.iter().enumerate() {
            let base = 8 + i * 32;
            le::write_i64(state, base, fx::from_int(*x));
            le::write_i64(state, base + 8, fx::from_int(*y));
        }
        Ok(())
    }

    /// True once every ball is at rest.
    pub fn at_rest(state: &[u8]) -> bool {
        (0..N_BALLS).all(|i| {
            let base = 8 + i * 32;
            le::read_i64(state, base + 16) == 0 && le::read_i64(state, base + 24) == 0
        })
    }
}

/// Match verdict encoding shared with anything that settles on it.
pub mod side {
    pub const DRAW: u8 = 0;
    pub const FIRST: u8 = 1;
    pub const SECOND: u8 = 2;
}

/// Squared distance of a ball to the center, Q64.64 in i128.
pub fn center_dist2(state: &[u8], ball: usize) -> i128 {
    let base = 8 + ball * 32;
    let dx = le::read_i64(state, base) as i128 - CENTER as i128;
    let dy = le::read_i64(state, base + 8) as i128 - CENTER as i128;
    (dx * dx).saturating_add(dy * dy)
}

/// Whoever parked closer to the center wins; exact tie is a draw.
pub fn verdict(state: &[u8]) -> Result<u8, TickError> {
    if state.len() != STATE_SIZE {
        return Err(TickError::BadStateSize);
    }
    Ok(match center_dist2(state, 0).cmp(&center_dist2(state, 1)) {
        core::cmp::Ordering::Less => side::FIRST,
        core::cmp::Ordering::Greater => side::SECOND,
        core::cmp::Ordering::Equal => side::DRAW,
    })
}

#[derive(Clone, Copy)]
struct Ball {
    px: Fx,
    py: Fx,
    vx: Fx,
    vy: Fx,
}

fn load(state: &[u8]) -> [Ball; N_BALLS] {
    let mut b = [Ball { px: 0, py: 0, vx: 0, vy: 0 }; N_BALLS];
    for (i, ball) in b.iter_mut().enumerate() {
        let base = 8 + i * 32;
        ball.px = le::read_i64(state, base);
        ball.py = le::read_i64(state, base + 8);
        ball.vx = le::read_i64(state, base + 16);
        ball.vy = le::read_i64(state, base + 24);
    }
    b
}

fn store(state: &mut [u8], b: &[Ball; N_BALLS]) {
    for (i, ball) in b.iter().enumerate() {
        let base = 8 + i * 32;
        le::write_i64(state, base, ball.px);
        le::write_i64(state, base + 8, ball.py);
        le::write_i64(state, base + 16, ball.vx);
        le::write_i64(state, base + 24, ball.vy);
    }
}

fn sat(v: i128) -> Fx {
    v.clamp(i64::MIN as i128, i64::MAX as i128) as Fx
}

/// floor(sqrt(n)), integer Newton iteration: deterministic everywhere.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = 1u128 << ((128 - n.leading_zeros()).div_ceil(2));
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// Elastic collision + separation for one pair of equal-mass discs.
fn collide(a: &mut Ball, b: &mut Ball) {
    let dx = b.px as i128 - a.px as i128;
    let dy = b.py as i128 - a.py as i128;
    // saturating: hostile states may hold huge coordinates; real contacts are < 16 units apart
    let d2 = dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy)); // Q64.64
    let min2 = (MIN_DIST as i128) * (MIN_DIST as i128);
    if d2 >= min2 {
        return;
    }
    if d2 == 0 {
        // perfectly stacked: separate along x, deterministic
        a.px = sat(a.px as i128 - (MIN_DIST / 2) as i128);
        b.px = sat(b.px as i128 + (MIN_DIST / 2) as i128);
        return;
    }
    // velocity exchange along the normal, only if approaching
    let rvx = b.vx as i128 - a.vx as i128;
    let rvy = b.vy as i128 - a.vy as i128;
    let dot = rvx.saturating_mul(dx).saturating_add(rvy.saturating_mul(dy)); // Q64.64
    if dot < 0 {
        // k = dot / d2, applied as k * d
        let jx = dot.saturating_mul(dx) / d2;
        let jy = dot.saturating_mul(dy) / d2;
        a.vx = sat(a.vx as i128 + jx);
        a.vy = sat(a.vy as i128 + jy);
        b.vx = sat(b.vx as i128 - jx);
        b.vy = sat(b.vy as i128 - jy);
    }
    // push apart by half the overlap each, along the normal
    let dist = isqrt(d2 as u128) as i128; // Q32.32
    if dist == 0 {
        return;
    }
    let half = (MIN_DIST as i128 - dist) / 2 + 1;
    let sx = dx * half / dist;
    let sy = dy * half / dist;
    a.px = sat(a.px as i128 - sx);
    a.py = sat(a.py as i128 - sy);
    b.px = sat(b.px as i128 + sx);
    b.py = sat(b.py as i128 + sy);
}

/// Reflect off a wall with restitution; clamp so absurd speeds can't escape.
fn bounce(p: &mut Fx, v: &mut Fx) {
    if *p < ARENA_MIN {
        *p = ARENA_MIN.saturating_add(ARENA_MIN.saturating_sub(*p));
        *v = fx::mul(v.saturating_neg(), WALL_RESTITUTION);
    } else if *p > ARENA_MAX {
        *p = ARENA_MAX.saturating_sub(p.saturating_sub(ARENA_MAX));
        *v = fx::mul(v.saturating_neg(), WALL_RESTITUTION);
    }
    *p = (*p).clamp(ARENA_MIN, ARENA_MAX);
}

fn damp(v: Fx) -> Fx {
    let v = fx::mul(v, FRICTION);
    if v.unsigned_abs() < REST as u64 {
        0
    } else {
        v
    }
}

impl TickLogic for Arena {
    const STATE_SIZE: usize = STATE_SIZE;

    fn tick(state: &mut [u8], inputs: &[u8], _tick_index: u64) -> Result<(), TickError> {
        if state.len() != STATE_SIZE {
            return Err(TickError::BadStateSize);
        }
        if !inputs.len().is_multiple_of(INPUT_ENTRY_SIZE) {
            return Err(TickError::BadInput);
        }
        let mut balls = load(state);

        // impulses first
        let mut off = 0;
        while off < inputs.len() {
            let i = le::read_u32(inputs, off) as usize;
            if i >= N_BALLS {
                return Err(TickError::BadInput);
            }
            balls[i].vx = balls[i].vx.saturating_add(le::read_i64(inputs, off + 4));
            balls[i].vy = balls[i].vy.saturating_add(le::read_i64(inputs, off + 12));
            off += INPUT_ENTRY_SIZE;
        }

        // integrate + walls
        for b in balls.iter_mut() {
            b.px = b.px.saturating_add(b.vx);
            b.py = b.py.saturating_add(b.vy);
            bounce(&mut b.px, &mut b.vx);
            bounce(&mut b.py, &mut b.vy);
        }

        // pairwise collisions, fixed order
        for i in 0..N_BALLS {
            for j in i + 1..N_BALLS {
                let (lo, hi) = balls.split_at_mut(j);
                collide(&mut lo[i], &mut hi[0]);
            }
        }

        // friction, and keep everything on the table after separation
        for b in balls.iter_mut() {
            b.vx = damp(b.vx);
            b.vy = damp(b.vy);
            b.px = b.px.clamp(ARENA_MIN, ARENA_MAX);
            b.py = b.py.clamp(ARENA_MIN, ARENA_MAX);
        }

        store(state, &balls);
        let t = le::read_u64(state, 0);
        le::write_u64(state, 0, t.wrapping_add(1));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tick_core::rng::Rng;

    fn entry(ball: u32, dvx: i64, dvy: i64) -> [u8; INPUT_ENTRY_SIZE] {
        let mut e = [0u8; INPUT_ENTRY_SIZE];
        le::write_u32(&mut e, 0, ball);
        le::write_i64(&mut e, 4, dvx);
        le::write_i64(&mut e, 12, dvy);
        e
    }

    fn genesis() -> [u8; STATE_SIZE] {
        let mut s = [0u8; STATE_SIZE];
        Arena::init(&mut s).unwrap();
        s
    }

    fn run_flicks(flicks: &[(u64, u32, i64, i64)], ticks: u64) -> [u8; STATE_SIZE] {
        let mut s = genesis();
        for t in 0..ticks {
            let mut buf = [0u8; INPUT_ENTRY_SIZE * 2];
            let mut n = 0;
            for (ft, ball, dx, dy) in flicks {
                if *ft == t {
                    buf[n * INPUT_ENTRY_SIZE..(n + 1) * INPUT_ENTRY_SIZE].copy_from_slice(&entry(*ball, *dx, *dy));
                    n += 1;
                }
            }
            Arena::tick(&mut s, &buf[..n * INPUT_ENTRY_SIZE], t).unwrap();
        }
        s
    }

    fn fuzz(seed: u64, ticks: u64) -> [u8; STATE_SIZE] {
        let mut s = genesis();
        let mut r = Rng::new(seed);
        for t in 0..ticks {
            let mut inp = [0u8; INPUT_ENTRY_SIZE];
            let n = if t % 180 == 0 {
                inp = entry(r.next_below(2) as u32, (r.next_u64() as i64) % (8 << 32), (r.next_u64() as i64) % (8 << 32));
                INPUT_ENTRY_SIZE
            } else {
                0
            };
            Arena::tick(&mut s, &inp[..n], t).unwrap();
        }
        s
    }

    fn fnv(s: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in s {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
        h
    }

    #[test]
    fn deterministic() {
        assert_eq!(fuzz(9, 50_000), fuzz(9, 50_000));
    }

    const GOLDEN_FUZZ_10K: u64 = 0x3a2290157f510e65;

    #[test]
    fn golden_fuzz_10k() {
        let h = fnv(&fuzz(42, 10_000));
        if GOLDEN_FUZZ_10K == 0 {
            panic!("set GOLDEN_FUZZ_10K = {h:#018x}");
        }
        assert_eq!(h, GOLDEN_FUZZ_10K, "state hash drifted: {h:#018x}");
    }

    #[test]
    fn genesis_is_a_draw_and_at_rest() {
        let s = genesis();
        assert_eq!(verdict(&s), Ok(side::DRAW));
        assert!(Arena::at_rest(&s));
        let s = run_flicks(&[], 600);
        assert!(Arena::at_rest(&s));
        assert_eq!(s[8..], genesis()[8..]);
    }

    #[test]
    fn max_flick_stops_within_a_round() {
        let s = run_flicks(&[(0, 0, 12 << 32, 0)], 180);
        assert!(Arena::at_rest(&s));
    }

    #[test]
    fn mirror_symmetry_is_fair() {
        // mirroring the table swaps A and B and flips x of every impulse;
        // the result must be the mirrored verdict
        let flicks = [(0u64, 0u32, 3i64 << 32, 1i64 << 31), (0, 1, -(2i64 << 32), 1 << 30), (180, 0, 1 << 32, -(1i64 << 32))];
        let mirrored: [(u64, u32, i64, i64); 3] = core::array::from_fn(|k| {
            let (t, b, dx, dy) = flicks[k];
            (t, 1 - b, -dx, dy)
        });
        let s = run_flicks(&flicks, 360);
        let m = run_flicks(&mirrored, 360);
        let v = verdict(&s).unwrap();
        let w = verdict(&m).unwrap();
        let swap = |x: u8| match x {
            side::FIRST => side::SECOND,
            side::SECOND => side::FIRST,
            d => d,
        };
        assert_eq!(w, swap(v));
        // and positions mirror within rounding of a few ulps per collision
        let ax = le::read_i64(&s, 8);
        let bx = le::read_i64(&m, 8 + 32);
        assert!((ax + bx - fx::from_int(256)).abs() < 1 << 12, "{ax} {bx}");
    }

    #[test]
    fn collision_moves_the_target() {
        // A shoots straight right into the peg at (80,128)
        let s = run_flicks(&[(0, 0, 4 << 32, 0)], 180);
        let peg_x = le::read_i64(&s, 8 + 5 * 32);
        assert!(peg_x > fx::from_int(80), "peg should be knocked right");
    }

    #[test]
    fn positions_stay_on_the_table() {
        let s = fuzz(3, 20_000);
        for i in 0..N_BALLS {
            let base = 8 + i * 32;
            for off in [0, 8] {
                let p = le::read_i64(&s, base + off);
                assert!((ARENA_MIN..=ARENA_MAX).contains(&p));
            }
        }
    }

    #[test]
    fn rejects_bad_input() {
        let mut s = genesis();
        assert_eq!(Arena::tick(&mut s, &[0u8; 7], 0), Err(TickError::BadInput));
        assert_eq!(Arena::tick(&mut s, &entry(8, 0, 0), 0), Err(TickError::BadInput));
        let mut short = [0u8; 10];
        assert_eq!(Arena::tick(&mut short, &[], 0), Err(TickError::BadStateSize));
        assert_eq!(verdict(&short), Err(TickError::BadStateSize));
    }

    #[test]
    fn verdict_survives_adversarial_extremes() {
        let mut s = genesis();
        le::write_i64(&mut s, 8, i64::MIN);
        le::write_i64(&mut s, 16, i64::MIN);
        le::write_i64(&mut s, 40, i64::MIN);
        le::write_i64(&mut s, 48, i64::MIN);
        assert_eq!(verdict(&s), Ok(side::DRAW));
        // and ticking a hostile state never panics
        le::write_i64(&mut s, 24, i64::MAX);
        le::write_i64(&mut s, 56, i64::MIN);
        for t in 0..100 {
            Arena::tick(&mut s, &[], t).unwrap();
        }
    }

    #[test]
    fn isqrt_is_exact_floor() {
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, 1 << 64, (1 << 64) + 1, u64::MAX as u128 * u64::MAX as u128, u128::MAX] {
            let r = isqrt(n);
            assert!(r * r <= n);
            assert!((r + 1).checked_mul(r + 1).is_none_or(|x| x > n));
        }
    }
}
