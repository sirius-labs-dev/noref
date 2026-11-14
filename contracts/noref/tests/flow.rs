//! End-to-end on a local sandbox. Build the wasm first:
//!   cargo near build non-reproducible-wasm --no-abi
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use noref_rules::{encode_record, replay, side, sign_digest};
use serde_json::{json, Value};

const DURATION: u32 = noref_rules::MATCH_TICKS; // 6 rounds
const R: u32 = noref_rules::ROUND_TICKS;
const WINDOW: u64 = 10;

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn pubhex(k: &SigningKey) -> String {
    k.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

/// log from (tick, [(ball, dvx, dvy)]) records
fn log_of(recs: &[(u32, Vec<(u32, i64, i64)>)]) -> Vec<u8> {
    let mut v = Vec::new();
    for (t, e) in recs {
        let mut buf = [0u8; 64];
        let n = encode_record(&mut buf, *t, e);
        v.extend_from_slice(&buf[..n]);
    }
    v
}

fn sign(k: &SigningKey, id: u64, log: &[u8], duration: u32, tick: u32) -> Vec<u8> {
    let head = noref_rules::head_at(log, duration, tick).unwrap();
    k.sign(&sign_digest(id, tick, &head)).to_bytes().to_vec()
}

const ONE: i64 = 1 << 32;

/// Flicks that make A (ball 0) win, found by searching a small grid natively.
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

async fn setup() -> anyhow::Result<(near_workspaces::Worker<near_workspaces::network::Sandbox>, Contract, Account, Account)> {
    let wasm = std::fs::read("../../target/near/noref_contract/noref_contract.wasm")?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;
    contract.call("new").transact().await?.into_result()?;
    let a = worker.dev_create_account().await?;
    let b = worker.dev_create_account().await?;
    Ok((worker, contract, a, b))
}

async fn open_match(c: &Contract, a: &Account, b: &Account, ka: &SigningKey, kb: &SigningKey, duration: u32) -> anyhow::Result<u64> {
    let id: Value = a
        .call(c.id(), "create")
        .args_json(json!({"duration": duration, "session_key": pubhex(ka), "window_secs": WINDOW, "opponent": b.id()}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let id: u64 = id.as_str().unwrap().parse()?;
    b.call(c.id(), "join")
        .args_json(json!({"id": id.to_string(), "session_key": pubhex(kb)}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    Ok(id)
}

async fn get(c: &Contract, id: u64) -> anyhow::Result<Value> {
    Ok(c.view("get_match").args_json(json!({"id": id.to_string()})).await?.json()?)
}

#[tokio::test]
async fn honest_match_confirm() -> anyhow::Result<()> {
    let (_w, c, a, b) = setup().await?;
    let (ka, kb) = (key(1), key(2));
    let id = open_match(&c, &a, &b, &ka, &kb, DURATION).await?;
    let before = a.view_account().await?.balance;
    b.call(c.id(), "claim").args_json(json!({"id": id.to_string(), "winner": side::FIRST})).transact().await?.into_result()?;
    a.call(c.id(), "confirm").args_json(json!({"id": id.to_string()})).transact().await?.into_result()?;
    let after = a.view_account().await?.balance;
    assert!(after.as_yoctonear() > before.as_yoctonear() + NearToken::from_millinear(1990).as_yoctonear());
    assert_eq!(get(&c, id).await?["result"], side::FIRST);
    println!("honest: claim + confirm, A paid the 2 NEAR pot");
    Ok(())
}

#[tokio::test]
async fn liar_claim_is_overturned_by_replay() -> anyhow::Result<()> {
    let (_w, c, a, b) = setup().await?;
    let (ka, kb) = (key(1), key(2));
    let id = open_match(&c, &a, &b, &ka, &kb, DURATION).await?;
    let log = log_of(&a_wins_log());
    let last = DURATION - 1;
    // B countersigned the log during play (its client signs what it saw)
    let sig_b = sign(&kb, id, &log, DURATION, last);

    // B lies: claims B won
    b.call(c.id(), "claim").args_json(json!({"id": id.to_string(), "winner": side::SECOND})).transact().await?.into_result()?;
    // A disputes with the log B signed
    let out = a
        .call(c.id(), "dispute")
        .args_json(json!({"id": id.to_string(), "log": b64(&log), "signed_tick": last, "signature": b64(&sig_b)}))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    println!("dispute logs: {:?} | burnt {:.2} Tgas", out.logs(), out.total_gas_burnt.as_gas() as f64 / 1e12);
    // B can no longer just confirm its own lie away; A cannot be cheated by confirm either
    let m = get(&c, id).await?;
    assert_eq!(m["replayed"]["winner"], side::FIRST);

    tokio::time::sleep(std::time::Duration::from_secs(WINDOW + 2)).await;
    let before = a.view_account().await?.balance;
    b.call(c.id(), "finalize").args_json(json!({"id": id.to_string()})).transact().await?.into_result()?;
    let after = a.view_account().await?.balance;
    assert!(after.as_yoctonear() >= before.as_yoctonear() + NearToken::from_near(2).as_yoctonear());
    assert_eq!(get(&c, id).await?["result"], side::FIRST);
    Ok(())
}

#[tokio::test]
async fn draw_pays_both_back() -> anyhow::Result<()> {
    let (_w, c, a, b) = setup().await?;
    let (ka, kb) = (key(1), key(2));
    let id = open_match(&c, &a, &b, &ka, &kb, DURATION).await?;
    let (a0, b0) = (a.view_account().await?.balance, b.view_account().await?.balance);
    b.call(c.id(), "claim").args_json(json!({"id": id.to_string(), "winner": side::DRAW})).transact().await?.into_result()?;
    let out = a.call(c.id(), "confirm").args_json(json!({"id": id.to_string()})).transact().await?;
    assert!(out.is_success(), "{:?}", out.failures());
    let (a1, b1) = (a.view_account().await?.balance, b.view_account().await?.balance);
    let back = NearToken::from_millinear(990).as_yoctonear();
    assert!(a1.as_yoctonear() > a0.as_yoctonear() + back, "A got its stake back");
    assert!(b1.as_yoctonear() > b0.as_yoctonear() + back - NearToken::from_millinear(10).as_yoctonear(), "B got its stake back");
    assert_eq!(get(&c, id).await?["result"], side::DRAW);
    Ok(())
}

#[tokio::test]
async fn lie_in_a_drawn_match_is_overturned() -> anyhow::Result<()> {
    let (_w, c, a, b) = setup().await?;
    let (ka, kb) = (key(1), key(2));
    let id = open_match(&c, &a, &b, &ka, &kb, DURATION).await?;
    // nobody flicked: the table never moved, the match is a draw
    let log: Vec<u8> = Vec::new();
    let last = DURATION - 1;
    let sig_b = sign(&kb, id, &log, DURATION, last);
    b.call(c.id(), "claim").args_json(json!({"id": id.to_string(), "winner": side::SECOND})).transact().await?.into_result()?;
    let out = a
        .call(c.id(), "dispute")
        .args_json(json!({"id": id.to_string(), "log": b64(&log), "signed_tick": last, "signature": b64(&sig_b)}))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    assert_eq!(get(&c, id).await?["replayed"]["winner"], side::DRAW);
    tokio::time::sleep(std::time::Duration::from_secs(WINDOW + 2)).await;
    let a0 = a.view_account().await?.balance;
    let out = b.call(c.id(), "finalize").args_json(json!({"id": id.to_string()})).transact().await?;
    assert!(out.is_success(), "{:?}", out.failures());
    assert!(a.view_account().await?.balance.as_yoctonear() >= a0.as_yoctonear() + NearToken::from_near(1).as_yoctonear());
    assert_eq!(get(&c, id).await?["result"], side::DRAW);
    Ok(())
}

#[tokio::test]
async fn self_signed_or_tampered_log_is_rejected() -> anyhow::Result<()> {
    let (_w, c, a, b) = setup().await?;
    let (ka, kb) = (key(1), key(2));
    let id = open_match(&c, &a, &b, &ka, &kb, DURATION).await?;
    let log = log_of(&a_wins_log());
    let last = DURATION - 1;
    b.call(c.id(), "claim").args_json(json!({"id": id.to_string(), "winner": side::SECOND})).transact().await?.into_result()?;

    // A signs its own log: not good enough
    let sig_a = sign(&ka, id, &log, DURATION, last);
    let r = a
        .call(c.id(), "dispute")
        .args_json(json!({"id": id.to_string(), "log": b64(&log), "signed_tick": last, "signature": b64(&sig_a)}))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure());

    // B signed an honest log where B wins; A edits one impulse after the fact
    let honest = log_of(&[(0, vec![(1, ONE, ONE)])]);
    let sig_b = sign(&kb, id, &honest, DURATION, last);
    let r = a
        .call(c.id(), "dispute")
        .args_json(json!({"id": id.to_string(), "log": b64(&log), "signed_tick": last, "signature": b64(&sig_b)}))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure());
    assert!(get(&c, id).await?["replayed"].is_null());
    Ok(())
}

#[tokio::test]
async fn longer_signed_log_beats_cherry_picked_prefix() -> anyhow::Result<()> {
    let (_w, c, a, b) = setup().await?;
    let (ka, kb) = (key(1), key(2));
    let id = open_match(&c, &a, &b, &ka, &kb, DURATION).await?;
    // A pushes to the center early; later B pushes ball 1 even closer.
    let mut recs = a_wins_log();
    let early_tick = recs.last().unwrap().0;
    // find a later B flick that flips the result
    let mut flip = None;
    'search: for round in 2..=4u32 {
        for v in 2..=24i64 {
            for dy in [-2i64, -1, 0, 1, 2] {
                let mut r2 = recs.clone();
                r2.push((round * R, vec![(1, -v * ONE / 2, dy * ONE / 2)]));
                if replay(&log_of(&r2), DURATION, DURATION - 1).unwrap().winner == side::SECOND {
                    flip = Some(r2);
                    break 'search;
                }
            }
        }
    }
    let full_recs = flip.expect("no flipping B move found");
    recs = full_recs.clone();
    let full = log_of(&recs);
    let prefix_tick = early_tick + R - 1; // B signed at the end of A's round
    let prefix: Vec<_> = recs.iter().filter(|(t, _)| *t <= prefix_tick).cloned().collect();
    let prefix = log_of(&prefix);
    assert_eq!(replay(&prefix, DURATION, prefix_tick).unwrap().winner, side::FIRST);
    assert_eq!(replay(&full, DURATION, DURATION - 1).unwrap().winner, side::SECOND);

    // both sides countersigned along the way
    let sig_b_early = sign(&kb, id, &prefix, DURATION, prefix_tick);
    let sig_a_full = sign(&ka, id, &full, DURATION, DURATION - 1);

    b.call(c.id(), "claim").args_json(json!({"id": id.to_string(), "winner": side::SECOND})).transact().await?.into_result()?;
    // A cherry-picks the early B signature, when A was ahead
    a.call(c.id(), "dispute")
        .args_json(json!({"id": id.to_string(), "log": b64(&prefix), "signed_tick": prefix_tick, "signature": b64(&sig_b_early)}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(get(&c, id).await?["replayed"]["winner"], side::FIRST);
    // B answers with the full log A signed at the end
    b.call(c.id(), "dispute")
        .args_json(json!({"id": id.to_string(), "log": b64(&full), "signed_tick": DURATION - 1, "signature": b64(&sig_a_full)}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(get(&c, id).await?["replayed"]["winner"], side::SECOND);
    // and A cannot go back to the shorter one
    let r = a
        .call(c.id(), "dispute")
        .args_json(json!({"id": id.to_string(), "log": b64(&prefix), "signed_tick": prefix_tick, "signature": b64(&sig_b_early)}))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure());
    Ok(())
}

#[tokio::test]
async fn longest_match_gas() -> anyhow::Result<()> {
    let (_w, c, a, b) = setup().await?;
    let (ka, kb) = (key(1), key(2));
    for d in [DURATION, noref_rules::MAX_DURATION] {
        let id = open_match(&c, &a, &b, &ka, &kb, d).await?;
        // both players flick every round, near full strength, random directions
        let mut recs = Vec::new();
        let mut rng = tick_core_rng(7);
        for t in (0..d).step_by(R as usize) {
            let mut e = Vec::new();
            for ball in 0..2u32 {
                let dx = (rng() % (16 * ONE as u64)) as i64 - 8 * ONE;
                let dy = (rng() % (16 * ONE as u64)) as i64 - 8 * ONE;
                e.push((ball, dx, dy));
            }
            recs.push((t, e));
        }
        let log = log_of(&recs);
        let sig_b = sign(&kb, id, &log, d, d - 1);
        b.call(c.id(), "claim").args_json(json!({"id": id.to_string(), "winner": side::SECOND})).transact().await?.into_result()?;
        let out = a
            .call(c.id(), "dispute")
            .args_json(json!({"id": id.to_string(), "log": b64(&log), "signed_tick": d - 1, "signature": b64(&sig_b)}))
            .max_gas()
            .transact()
            .await?;
        assert!(out.is_success(), "{:?}", out.failures());
        println!(
            "{} rounds ({} s): log {} B, dispute burnt {:.2} Tgas",
            d / R,
            d / 60,
            log.len(),
            out.total_gas_burnt.as_gas() as f64 / 1e12
        );
    }
    Ok(())
}

fn tick_core_rng(seed: u64) -> impl FnMut() -> u64 {
    let mut x = seed;
    move || {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
}
