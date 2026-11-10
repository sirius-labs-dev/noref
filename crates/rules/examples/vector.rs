//! Prints a cross-implementation test vector: replay outcome of a fixed log.
fn main() {
    let one = 1i64 << 32;
    let recs: [(u32, &[(u32, i64, i64)]); 4] = [
        (0, &[(0, 5 * one, one / 3), (1, -4 * one, -one / 7)]),
        (180, &[(0, -2 * one, 3 * one)]),
        (360, &[(1, -11 * one, one)]),
        (900, &[(0, 7 * one, -5 * one), (1, 3 * one, 2 * one)]),
    ];
    let mut log = Vec::new();
    for (t, e) in recs {
        let mut buf = [0u8; 64];
        let n = noref_rules::encode_record(&mut buf, t, e);
        log.extend_from_slice(&buf[..n]);
    }
    let o = noref_rules::replay(&log, noref_rules::MATCH_TICKS, noref_rules::MATCH_TICKS - 1).unwrap();
    let hx = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let d = noref_rules::sign_digest(7, noref_rules::MATCH_TICKS - 1, &o.head);
    println!("{} {} {} {}", o.winner, hx(&o.head), hx(&o.final_root), hx(&d));
}
