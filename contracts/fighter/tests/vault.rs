//! The fighter vault against the real arena contract on a local sandbox.
//! Build both wasm files first:
//!   (cd ../noref && cargo near build non-reproducible-wasm --no-abi)
//!   cargo near build non-reproducible-wasm --no-abi
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use noref_rules::{encode_record, replay, side, sign_digest};
use serde_json::{json, Value};

const DURATION: u32 = noref_rules::MATCH_TICKS;
const WINDOW: u64 = 10;
const ONE: i64 = 1 << 32;
const MILLI: u128 = 1_000_000_000_000_000_000_000;

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}
fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}
fn pubhex(k: &SigningKey) -> String {
    k.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect()
}
fn log_of(recs: &[(u32, Vec<(u32, i64, i64)>)]) -> Vec<u8> {
    let mut v = Vec::new();
    for (t, e) in recs {
        let mut buf = [0u8; 64];
        let n = encode_record(&mut buf, *t, e);
        v.extend_from_slice(&buf[..n]);
    }
    v
}
fn a_wins_log() -> Vec<(u32, Vec<(u32, i64, i64)>)> {
    for v in 2..=12i64 {
        for dy in [-2i64, -1, 0, 1, 2] {
            let recs = vec![(0, vec![(0, v * ONE / 2, dy * ONE / 2)])];
            if replay(&log_of(&recs), DURATION, DURATION - 1).unwrap().winner == side::FIRST {
                return recs;
            }
        }
    }
    panic!("no A-winning flick in grid");
}
fn milli(n: u128) -> String {
    (n * MILLI).to_string()
}

struct T {
    w: Worker<Sandbox>,
    arena: Contract,
    vex: Account,
    house: Account,
    player: Account,
}

/// Arena, a fighter "vex" with 5 NEAR (house holds all shares), a player.
async fn setup() -> anyhow::Result<T> {
    let w = near_workspaces::sandbox().await?;
    let arena = w.dev_deploy(&std::fs::read("../../target/near/noref_contract/noref_contract.wasm")?).await?;
    arena.call("new").transact().await?.into_result()?;
    let root = w.root_account()?;
    let house = w.dev_create_account().await?;
    let player = w.dev_create_account().await?;
    let vex = root.create_subaccount("vex").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    vex.deploy(&std::fs::read("target/near/noref_fighter.wasm")?).await?.into_result()?;
    vex.call(vex.id(), "new")
        .args_json(json!({"name": "Vex", "arena": arena.id(), "founder": house.id(), "holders": [], "min_stake": milli(50), "risk_share": 10, "reserve": milli(100), "div_at": milli(6000), "div_keep": milli(4000)}))
        .transact()
        .await?
        .into_result()?;
    Ok(T { w, arena, vex, house, player })
}

async fn info(t: &T) -> anyhow::Result<Value> {
    Ok(t.vex.view(t.vex.id(), "info").await?.json()?)
}
fn u(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

/// Player creates a match against Vex; Vex joins through its vault.
async fn player_vs_vex(t: &T, stake_milli: u128) -> anyhow::Result<u64> {
    let id: Value = t
        .player
        .call(t.arena.id(), "create")
        .args_json(json!({"duration": DURATION, "session_key": pubhex(&key(1)), "window_secs": WINDOW, "opponent": t.vex.id()}))
        .deposit(NearToken::from_yoctonear(stake_milli * MILLI))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.as_str().unwrap().parse()?;
    t.vex
        .call(t.vex.id(), "play_join")
        .args_json(json!({"id": id.to_string(), "session_key": pubhex(&key(2)), "stake": milli(stake_milli)}))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(id)
}

#[tokio::test]
async fn plays_through_the_vault_and_syncs() -> anyhow::Result<()> {
    let t = setup().await?;
    let start = u(&info(&t).await?["bankroll"]);
    let id = player_vs_vex(&t, 300).await?;
    let i = info(&t).await?;
    assert_eq!(i["in_play"][0][0], id.to_string(), "stake recorded as in play");
    // backing is refused while a stake is out
    let r = t.player.call(t.vex.id(), "back").deposit(NearToken::from_millinear(100)).transact().await?;
    assert!(r.is_failure());
    // the player claims Vex won; Vex confirms through its vault and is paid the pot
    t.player.call(t.arena.id(), "claim").args_json(json!({"id": id.to_string(), "winner": side::SECOND})).transact().await?.into_result()?;
    t.vex.call(t.vex.id(), "play_confirm").args_json(json!({"id": id.to_string()})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    let synced: Value = t.house.call(t.vex.id(), "sync").args_json(json!({"id": id.to_string()})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?.json()?;
    assert_eq!(synced, true);
    let i = info(&t).await?;
    assert_eq!(i["in_play"].as_array().unwrap().len(), 0);
    let now = u(&i["bankroll"]);
    assert!(now > start + 250 * MILLI, "won 0.3 NEAR (minus gas): {start} -> {now}");
    println!("vex bankroll {} -> {} milliNEAR", start / MILLI, now / MILLI);
    Ok(())
}

#[tokio::test]
async fn only_its_own_key_plays_and_stakes_are_capped() -> anyhow::Result<()> {
    let t = setup().await?;
    // someone else cannot make the fighter play
    let r = t.player.call(t.vex.id(), "play_claim").args_json(json!({"id": "0", "winner": 1})).transact().await?;
    assert!(r.is_failure());
    assert!(format!("{:?}", r.failures()).contains("only the fighter's own key"));
    // a stake above a tenth of the bankroll is refused before any money moves
    let id: Value = t
        .player
        .call(t.arena.id(), "create")
        .args_json(json!({"duration": DURATION, "session_key": pubhex(&key(1)), "window_secs": WINDOW, "opponent": t.vex.id()}))
        .deposit(NearToken::from_millinear(900))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let r = t.vex.call(t.vex.id(), "play_join").args_json(json!({"id": id, "session_key": pubhex(&key(2)), "stake": milli(900)})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?;
    assert!(r.is_failure());
    assert!(format!("{:?}", r.failures()).contains("stake above"));
    assert_eq!(info(&t).await?["in_play"].as_array().unwrap().len(), 0);
    Ok(())
}

#[tokio::test]
async fn shares_dividends_and_cash_out() -> anyhow::Result<()> {
    let t = setup().await?;
    let i0 = info(&t).await?;
    let price0 = u(&i0["price"]);
    // backing at the current price
    let s: Value = t.player.call(t.vex.id(), "back").deposit(NearToken::from_near(1)).transact().await?.into_result()?.json()?;
    let shares = u(&s);
    let expect = 1_000 * MILLI / price0;
    // the price moves a little between the view and the call (gas rewards land on the vault)
    assert!(shares.abs_diff(expect) * 100 <= expect, "{shares} vs {expect}");
    let price1 = u(&info(&t).await?["price"]);
    // backing does not dilute anyone: the price does not drop (gas rewards may nudge it up)
    assert!(price1 + price0 / 1000 >= price0 && price1.abs_diff(price0) * 100 < price0, "price after backing: {price0} -> {price1}");
    // the fighter grows rich (a win, here a plain transfer) and pays dividends
    t.house.transfer_near(t.vex.id(), NearToken::from_near(4)).await?.into_result()?;
    let paid: Value = t.house.call(t.vex.id(), "pay_dividends").transact().await?.into_result()?.json()?;
    let paid = u(&paid);
    let total = u(&info(&t).await?["total_shares"]);
    let before = t.player.view_account().await?.balance.as_yoctonear();
    t.house.call(t.vex.id(), "claim_dividend").args_json(json!({"account_id": t.player.id()})).transact().await?.into_result()?;
    let got = t.player.view_account().await?.balance.as_yoctonear() - before;
    let fair = paid * shares / total;
    assert!(got.abs_diff(fair) < MILLI, "dividend {got} vs pro rata {fair}");
    let i = info(&t).await?;
    assert!(u(&i["bankroll"]).abs_diff(4000 * MILLI) < 10 * MILLI, "kept div_keep: {} {}", i["bankroll"], i["owed_dividends"]);
    // cash out every share at the current price
    let value = shares * u(&i["price"]);
    let before = t.player.view_account().await?.balance.as_yoctonear();
    t.player.call(t.vex.id(), "cash_out").args_json(json!({"shares": shares.to_string()})).transact().await?.into_result()?;
    let got = t.player.view_account().await?.balance.as_yoctonear() - before;
    assert!(got + 5 * MILLI > value && got < value + MILLI, "cash out {got} vs {value}");
    let (left, _): (Value, Value) = t.vex.view(t.vex.id(), "shares_of").args_json(json!({"account_id": t.player.id()})).await?.json()?;
    assert_eq!(left, "0");
    println!("backed 1 NEAR -> {} shares, dividend {} milliNEAR, cashed out {} milliNEAR", shares, fair / MILLI, value / MILLI);
    Ok(())
}

#[tokio::test]
async fn vault_creates_and_overturns_a_lie_by_replay() -> anyhow::Result<()> {
    let t = setup().await?;
    // Vex opens the match from its vault (it is side A)
    let id: Value = t
        .vex
        .call(t.vex.id(), "play_create")
        .args_json(json!({"duration": DURATION, "session_key": pubhex(&key(1)), "window_secs": WINDOW, "opponent": t.player.id(), "stake": milli(200)}))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.as_str().unwrap().parse()?;
    t.player.call(t.arena.id(), "join").args_json(json!({"id": id.to_string(), "session_key": pubhex(&key(2))})).deposit(NearToken::from_millinear(200)).transact().await?.into_result()?;
    // A (Vex) won; the player countersigned the log, then lies
    let log = log_of(&a_wins_log());
    let last = DURATION - 1;
    let head = noref_rules::head_at(&log, DURATION, last).unwrap();
    let sig = key(2).sign(&sign_digest(id, last, &head)).to_bytes().to_vec();
    t.player.call(t.arena.id(), "claim").args_json(json!({"id": id.to_string(), "winner": side::SECOND})).transact().await?.into_result()?;
    let out = t
        .vex
        .call(t.vex.id(), "play_dispute")
        .args_json(json!({"id": id.to_string(), "log": b64(&log), "signed_tick": last, "signature": b64(&sig)}))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    println!("dispute through the vault: burnt {:.2} Tgas, logs {:?}", out.total_gas_burnt.as_gas() as f64 / 1e12, out.logs());
    let m: Value = t.arena.view("get_match").args_json(json!({"id": id.to_string()})).await?.json()?;
    assert_eq!(m["replayed"]["winner"], side::FIRST);
    tokio::time::sleep(std::time::Duration::from_secs(WINDOW + 2)).await;
    t.house.call(t.arena.id(), "finalize").args_json(json!({"id": id.to_string()})).transact().await?.into_result()?;
    t.house.call(t.vex.id(), "sync").args_json(json!({"id": id.to_string()})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    let i = info(&t).await?;
    assert_eq!(i["in_play"].as_array().unwrap().len(), 0);
    let _ = &t.w;
    Ok(())
}
