// On-chain proof on testnet: two players, B lies about the result, A
// disputes with B's own signature, the contract replays the whole match.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Near, keyFromSecret, newKey, action, NEAR, TGAS } from "./shared/near.js";
import { Engine, encodeEntries, encodeLog, hex, b64, SIDE } from "./shared/engine.js";
import { chooseFlick, makeRng } from "./shared/npc.js";

const C = "noref.testnet";
const near = new Near();
const keyFile = (id) => new URL(`../.keys/${id}.json`, import.meta.url);
const load = async (id) => keyFromSecret(JSON.parse(readFileSync(keyFile(id))).private_key);
const owner = await load(C);

async function ensureSub(name, fund) {
  const id = `${name}.${C}`;
  if (await near.account(id)) return { id, key: await load(id) };
  const k = await newKey();
  writeFileSync(keyFile(id), JSON.stringify({ account_id: id, public_key: k.publicKey, private_key: k.secretKey }), { mode: 0o600 });
  const r = await near.send(C, owner, id, [action.createAccount(), action.transfer(fund), action.addFullKey(k.publicKey)]);
  console.log(`created ${id}: ${near.explorer(r.hash)}`);
  return { id, key: k };
}

const A = await ensureSub("alice", NEAR);
const B = await ensureSub("bob", NEAR);
const sessA = await newKey();
const sessB = await newKey();
const pubHex = (k) => hex(k.pub);
const sessSign = async (k, digest) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k.priv, digest));

const engine = await Engine.load(readFileSync(new URL("./web/engine.wasm", import.meta.url)));
const D = engine.MATCH_TICKS;
const R = engine.ROUND_TICKS;
const stake = NEAR / 10n;
const bal = async (id) => Number(BigInt((await near.account(id)).amount) / 10n ** 21n) / 1000;

// 1. A opens, B joins
let r = await near.send(A.id, A.key, C, [action.call("create", { duration: D, session_key: pubHex(sessA), window_secs: 10, opponent: B.id }, 30n * TGAS, stake)]);
const id = Number(r.result);
console.log(`match #${id} created by ${A.id}: ${near.explorer(r.hash)}`);
r = await near.send(B.id, B.key, C, [action.call("join", { id: String(id), session_key: pubHex(sessB) }, 30n * TGAS, stake)]);
console.log(`${B.id} joined: ${near.explorer(r.hash)}`);

// 2. Play six rounds off-chain: A plays with a strong brain, B with a weak one
const rng = makeRng(11);
engine.reset();
const records = [];
for (let round = 0; round < D / R; round++) {
  const table = engine.getState();
  const fa = chooseFlick(engine, { ball: 0, style: "sniper", skill: 1, rng });
  engine.setState(table);
  const fb = chooseFlick(engine, { ball: 1, style: "cautious", skill: 0.1, rng });
  engine.setState(table);
  const e = [];
  if (!fa.pass) e.push({ ball: 0, dvx: fa.dvx, dvy: fa.dvy });
  if (!fb.pass) e.push({ ball: 1, dvx: fb.dvx, dvy: fb.dvy });
  if (e.length) records.push({ tick: round * R, entries: e });
  engine.tick(encodeEntries(e), round * R);
  engine.runTicks(R - 1, round * R + 1);
}
const log = encodeLog(records);
const truth = engine.replay(log, D, D - 1).winner;
console.log(`off-chain truth: ${truth === SIDE.FIRST ? "A won" : truth === SIDE.SECOND ? "B won" : "draw"} (${records.length} records, ${log.length} bytes)`);
// both sides countersigned the final head during play
const head = engine.headAt(log, D, D - 1);
const digest = engine.signDigest(id, D - 1, head);
const sigB = await sessSign(sessB, digest);

// 3. The loser lies
const loser = truth === SIDE.FIRST ? B : A;
const winner = truth === SIDE.FIRST ? A : B;
const lie = truth === SIDE.FIRST ? SIDE.SECOND : SIDE.FIRST;
const sigOfLoser = truth === SIDE.FIRST ? sigB : await sessSign(sessA, digest);
r = await near.send(loser.id, loser.key, C, [action.call("claim", { id: String(id), winner: lie }, 30n * TGAS)]);
console.log(`${loser.id} falsely claims side ${lie}: ${near.explorer(r.hash)}`);

// 4. The winner disputes with the liar's own signature: full replay on-chain
r = await near.send(winner.id, winner.key, C, [action.call("dispute", { id: String(id), log: b64(log), signed_tick: D - 1, signature: b64(sigOfLoser) }, 300n * TGAS)]);
console.log(`${winner.id} disputes: ${near.explorer(r.hash)}`);
console.log(`  on-chain replay verdict = ${r.result}, gas burnt ${(Number(r.gasBurnt) / 1e12).toFixed(2)} Tgas`);
console.log(`  logs: ${r.logs.join(" | ")}`);

// 5. After the window, finalize: money follows the replay
await new Promise((ok) => setTimeout(ok, 12_000));
const before = await bal(winner.id);
r = await near.send(loser.id, loser.key, C, [action.call("finalize", { id: String(id) }, 30n * TGAS)]);
console.log(`finalized: ${near.explorer(r.hash)}`);
await new Promise((ok) => setTimeout(ok, 3_000));
const m = await near.view(C, "get_match", { id: String(id) });
console.log(`result on-chain: side ${m.result}; ${winner.id} balance ${before} -> ${await bal(winner.id)} NEAR`);
