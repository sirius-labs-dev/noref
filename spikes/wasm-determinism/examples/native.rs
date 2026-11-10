fn main() {
    for (seed, n) in [(1u64, 10_000u64), (42, 10_000), (0xdead_beef, 10_000), (7, 100_000)] {
        println!("{seed} {n} {:016x}", wasm_determinism::digest_run(seed, n));
    }
}
