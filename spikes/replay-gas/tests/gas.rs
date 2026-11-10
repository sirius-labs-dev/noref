//! Sandbox gas measurement. Build first: cargo near build non-reproducible-wasm --no-abi
use base64::Engine as _;
use serde_json::json;

const TGAS: f64 = 1e12;

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

#[tokio::test]
async fn measure_replay_gas() -> anyhow::Result<()> {
    let wasm = std::fs::read("target/near/replay_gas.wasm")?;
    let sandbox = near_workspaces::sandbox().await?;
    let contract = sandbox.dev_deploy(&wasm).await?;

    let g = contract.view("genesis").await?.json::<String>()?;
    let state = base64::engine::general_purpose::STANDARD.decode(&g)?;
    let pre = hex::encode(tick_merkle::state_root(&state));

    // one tick, two impulses (typical contested tick)
    let mut inp = vec![0u8; arena::INPUT_ENTRY_SIZE * 2];
    tick_core::le::write_i64(&mut inp, 4, 3i64 << 32);
    tick_core::le::write_u32(&mut inp, arena::INPUT_ENTRY_SIZE, 1);
    tick_core::le::write_i64(&mut inp, arena::INPUT_ENTRY_SIZE + 12, -(2i64 << 32));

    let out = contract
        .call("replay_tick")
        .args_json(json!({"state": g, "inputs": b64(&inp), "tick_index": 0, "pre_root": pre}))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "{:?}", out);
    let total = out.total_gas_burnt.as_gas() as f64 / TGAS;
    let receipt = out.receipt_outcomes()[0].gas_burnt.as_gas() as f64 / TGAS;
    let logs: Vec<String> = out.logs().iter().map(|l| l.to_string()).collect();
    let post: String = out.json()?;
    let mut s = state.clone();
    <arena::Arena as tick_core::TickLogic>::tick(&mut s, &inp, 0).unwrap();
    assert_eq!(post, hex::encode(tick_merkle::state_root(&s)), "on-chain replay != native");
    println!(
        "replay_tick: total burnt {total:.3} Tgas | receipt {receipt:.3} Tgas | logs {logs:?}"
    );

    for n in [1u64, 100, 1_000, 5_000, 10_000, 30_000] {
        let r = contract
            .call("replay_n")
            .args_json(json!({"state": g, "n": n}))
            .max_gas()
            .transact()
            .await?;
        if r.is_success() {
            println!("replay_n({n:>6}): ok, total {:.3} Tgas", r.total_gas_burnt.as_gas() as f64 / TGAS);
        } else {
            println!("replay_n({n:>6}): FAILED (likely out of gas) {:.3} Tgas", r.total_gas_burnt.as_gas() as f64 / TGAS);
        }
    }
    Ok(())
}
