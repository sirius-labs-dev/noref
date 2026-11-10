// Full NoRef flow against the real contract on NEAR testnet, through the
// server, with a headless player that signs its own transactions exactly
// like the browser does. Costs a little testnet NEAR.
//
//   node scripts-testnet-e2e.mjs [npc] [--liar] [--human-lies]
//   --url=https://host  play against an already running server instead of spawning one
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, SIDE } from "./shared/engine.js";
import { MatchClient, newSessionKey } from "./shared/client.js";
import { PlayerChain, accountKey } from "./shared/player-chain.js";
import { action } from "./shared/near.js";
import { chooseFlick, makeRng } from "./shared/npc.js";

const args = process.argv.slice(2);
const npc = args.find((a) => !a.startsWith("--")) ?? "dot";
const liar = args.includes("--liar");
const humanLies = args.includes("--human-lies");
const URL_ARG = args.find((a) => a.startsWith("--url="))?.slice(6).replace(/\/$/, "");
const PORT = 18900 + Math.floor(Math.random() * 90);
const BASE = URL_ARG ?? `http://127.0.0.1:${PORT}`;
let srv = null;
if (!URL_ARG) {
  const DATA = mkdtempSync(join(tmpdir(), "noref-tn-"));
  srv = spawn(process.execPath, ["server/main.ts"], { cwd: new URL(".", import.meta.url).pathname, env: { ...process.env, CHAIN: "testnet", PORT: String(PORT), DATA, LADDER_MS: "999999999" }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok) => srv.stdout.on("data", (b) => String(b).includes("NoRef local") && ok()));
}
const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}`);

async function api(path, body) {
  const r = await fetch(BASE + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error}`);
  return j;
}
async function listen(me, onEvent) {
  const r = await fetch(`${BASE}/api/events?me=${me}`);
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev && data) onEvent(ev, JSON.parse(data));
      }
    }
  })().catch(() => {});
}

let cleanup = async () => {};
try {
  const engine = await Engine.load(readFileSync(new URL("./web/engine.wasm", import.meta.url)));
  // keep the test account's key on disk (gitignored .keys/) until cleanup, so a
  // crashed run never strands testnet NEAR
  const keyPath = new URL(`../.keys/e2e-${Date.now()}.secret`, import.meta.url);
  const acct = await accountKey({ get: () => null, set: (_, v) => writeFileSync(keyPath, v, { mode: 0o600 }) });
  const session = await newSessionKey();
  const name = "e2e" + Date.now().toString(36).slice(-5);
  const login = await api("/api/login", { name, key: session.pubHex, account: acct.publicKey });
  const me = login.me;
  log(`player ${me} created with its own key, balance ${login.balance / 1000} NEAR`);
  const pc = new PlayerChain({ rpc: BASE + "/api/rpc", contract: login.chain.contract, accountId: me, key: acct, api, log: (k, t, r) => log(`${t}: ${r.hash}`) });
  // the test account's key only lives in this process: hand its balance back
  let openId = null;
  cleanup = async () => {
    if (openId != null) {
      const m = await pc.near.view(login.chain.contract, "get_match", { id: String(openId) });
      if (m?.phase === "Open") log(`cancelled open match #${openId}: ${(await pc.call("cancel", { id: String(openId) })).hash}`);
    }
    const r = await pc.near.send(me, acct, me, [action.deleteAccount(login.chain.contract)]);
    log(`deleted ${me}, balance returned to ${login.chain.contract}: ${r.hash}`);
    rmSync(keyPath);
  };

  let client;
  const pending = [];
  const done = new Promise((ok) => {
    listen(me, (k, d) => {
      if (k === "chain") log(`[chain] ${d.text}${d.url ? "  " + d.url : ""}`);
      if (k === "chain" && d.kind === "settle") setTimeout(() => ok(d), 500);
      client ? client.handle(k, d) : pending.push([k, d]);
    });
  });

  const ch = await api("/api/challenge", { me, npc, liar });
  log(`challenge ${npc}: stake ${ch.stake / 1000} NEAR; signing create…`);
  const opened = await pc.open(ch.open);
  log(`create signed by player: #${opened.id} ${opened.hash}`);
  openId = opened.id;
  const { match } = await api("/api/opened", { me, id: opened.id, tx: opened.hash });
  const rng = makeRng(5);
  client = new MatchClient({
    engine,
    api,
    me,
    key: session,
    info: match,
    chain: pc.opsFor(match.id),
    autoSettle: !humanLies,
    log: (kind, text) => ["round", "final", "you", "problem"].includes(kind) && log(`[${kind}] ${text}`),
    aim: async (eng) => {
      const f = chooseFlick(eng, { ball: 0, style: "sniper", skill: 1, rng, fast: true });
      return f.pass ? null : { angle: f.angle, power: f.power };
    },
  });
  pending.forEach(([k, d]) => client.handle(k, d));
  if (humanLies) {
    const t = setInterval(async () => {
      if (client.verdict == null) return;
      clearInterval(t);
      log("player lies: claims a win");
      await client.falseClaim().catch((e) => log("false claim failed: " + e.message));
    }, 300);
  }
  const settle = await done;
  const m = (await api(`/api/state?me=${me}`)).me;
  log(`settled: winner side ${settle.data.winner}, our replay said ${client.verdict}; problems: ${client.problems.length}; player balance ${m.balance / 1000} NEAR`);
  if (client.problems.length) console.log(client.problems);
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  srv?.kill();
  process.exit();
}
