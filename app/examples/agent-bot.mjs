// Bring your own agent: a bot that plays NoRef for money with its own NEAR
// account, using the same public API and the same MatchClient as the browser.
//
// It is an economic agent, not a script that clicks "fight":
// - it reads every NPC's price, quoted for *its* on-chain record,
// - estimates its chance against each one (Elo: its own form vs the NPC's
//   rating), and only takes a bet with positive expected value,
// - never stakes more than a fifth of its balance, and stops at a stop-loss.
// The contract does not know or care that it is a bot: it still has to
// countersign every round, and a false claim from either side is replayed
// and overturned on-chain. It labels itself `bot: true` so people can see it.
//
//   node examples/agent-bot.mjs --url=https://noref.63-183-239-145.sslip.io:80 [--matches=3] [--name=mybot]
//   options: --skill=0..1 (aim quality, default 0.8)  --stop-loss=NEAR (default 0.2)
//            --cleanup (delete the account at the end, balance back to the house)
//
// Testnet: the account key is created here and kept in .keys/bot-<name>.secret
// (gitignored); the server never sees it. Against a local server (npm start)
// it plays on the local chain and needs no key.
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { Engine } from "../shared/engine.js";
import { MatchClient, newSessionKey, exportSessionKey, importSessionKey } from "../shared/client.js";
import { PlayerChain, accountKey } from "../shared/player-chain.js";
import { action } from "../shared/near.js";
import { chooseFlick, makeRng } from "../shared/npc.js";

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const BASE = arg("url", "http://127.0.0.1:8787").replace(/\/$/, "");
const NAME = arg("name", "bot" + Date.now().toString(36).slice(-5));
const MATCHES = Number(arg("matches", 3));
const SKILL = Number(arg("skill", 0.8));
const STOP_LOSS = Math.round(Number(arg("stop-loss", 0.2)) * 1000); // milliNEAR
const CLEANUP = process.argv.includes("--cleanup");
const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}`);
const fmt = (m) => (m / 1000).toFixed(3) + " NEAR";

async function api(path, body) {
  const r = await fetch(BASE + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error}`);
  return j;
}
function listen(me, onEvent) {
  const ctl = new AbortController();
  fetch(`${BASE}/api/events?me=${me}`, { signal: ctl.signal })
    .then(async (r) => {
      const dec = new TextDecoder();
      let buf = "";
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
    })
    .catch(() => {});
  return () => ctl.abort();
}

/** Elo win chance, the same formula the NPCs use to price us. */
const winChance = (mine, theirs) => 1 / (1 + 10 ** ((theirs - mine) / 400));

/**
 * The agent's decision: which NPC to fight, if any. Each quote is the NPC's
 * price for us; the NPC's last "why" line carries our form rating.
 * EV of an even-stakes bet = (2p - 1) * stake.
 */
function pick(roster, balance) {
  const options = [];
  for (const n of roster) {
    if (n.status !== "open" || n.declined) continue;
    const form = Number(n.why.find((w) => w.startsWith("vs form "))?.match(/vs form (\d+)/)?.[1] ?? 1200);
    // our aim skill shifts our real strength away from the public form rating
    const mine = form + 400 * (SKILL - 0.6);
    const p = winChance(mine, n.rating);
    const ev = (2 * p - 1) * n.stake;
    const affordable = n.stake <= balance / 5 && balance - n.stake >= STOP_LOSS;
    options.push({ n, p, ev, affordable });
  }
  options.sort((a, b) => b.ev - a.ev);
  for (const o of options) log(`  ${o.n.name.padEnd(6)} asks ${fmt(o.n.stake)}  p(win)=${(100 * o.p).toFixed(0)}%  EV ${o.ev >= 0 ? "+" : ""}${fmt(Math.round(o.ev))}${o.affordable ? "" : "  (too big for the bankroll)"}`);
  return options.find((o) => o.ev > 0 && o.affordable) ?? null;
}

const engine = await Engine.load(readFileSync(new URL("../web/engine.wasm", import.meta.url)));
const files = { acct: new URL(`../../.keys/bot-${NAME}.secret`, import.meta.url), session: new URL(`../../.keys/bot-${NAME}.session.json`, import.meta.url) };
const session = existsSync(files.session) ? await importSessionKey(JSON.parse(readFileSync(files.session, "utf8"))) : await newSessionKey();
const info = await api("/api/state").then((s) => s.chain);
const testnet = info.kind === "testnet";
let acct = null;
if (testnet) acct = await accountKey({ get: () => (existsSync(files.acct) ? readFileSync(files.acct, "utf8") : null), set: (_, v) => writeFileSync(files.acct, v, { mode: 0o600 }) });
const login = await api("/api/login", { name: NAME, key: session.pubHex, bot: true, ...(acct ? { account: acct.publicKey } : {}) });
if (testnet) writeFileSync(files.session, JSON.stringify(await exportSessionKey(session)), { mode: 0o600 });
const me = login.me;
log(`${me} (bot) on ${info.kind}${testnet ? ` / ${info.contract}` : ""}, balance ${fmt(login.balance)}`);
const pc = testnet ? new PlayerChain({ rpc: BASE + "/api/rpc", contract: info.contract, accountId: me, key: acct, api, log: (k, t, r) => log(`  ${t}: ${r.hash}`) }) : null;

let client = null;
let pending = [];
let settled = null;
const stop = listen(me, (k, d) => {
  if (k === "chain" && ["create", "join", "claim", "replay", "settle"].includes(d.kind)) log(`  [chain] ${d.text}`);
  if (k === "chain" && d.kind === "settle") settled?.(d);
  client ? client.handle(k, d) : pending.push([k, d]);
});

const rng = makeRng(Date.now() & 0xffff);
const results = [];
try {
  for (let i = 0; i < MATCHES; i++) {
    const s = await api(`/api/state?me=${me}`);
    const balance = s.me.balance;
    log(`match ${i + 1}/${MATCHES}: balance ${fmt(balance)}; quotes for us:`);
    if (balance < STOP_LOSS) {
      log(`stop-loss: balance under ${fmt(STOP_LOSS)}, the agent stops`);
      break;
    }
    const choice = pick(s.roster, balance);
    if (!choice) {
      log("no bet with positive expected value right now; the agent sits out");
      break;
    }
    log(`-> challenges ${choice.n.name} for ${fmt(choice.n.stake)} (p=${(100 * choice.p).toFixed(0)}%)`);
    let r = await api("/api/challenge", { me, npc: choice.n.id });
    if (r.open) {
      const o = await pc.open(r.open); // the bot locks its own stake on-chain
      r = await api("/api/opened", { me, id: o.id, tx: o.hash });
    }
    const done = new Promise((ok) => (settled = ok));
    client = new MatchClient({
      engine,
      api,
      me,
      key: session,
      info: r.match,
      chain: pc?.opsFor(r.match.id),
      claimDelayMs: testnet ? 6000 : 3000,
      log: (kind, text) => ["final", "problem"].includes(kind) && log(`  [${kind}] ${text}`),
      aim: async (eng) => {
        const f = chooseFlick(eng, { ball: 0, style: "sniper", skill: SKILL, rng, fast: true });
        return f.pass ? null : { angle: f.angle, power: f.power };
      },
    });
    pending.splice(0).forEach(([k, d]) => client.handle(k, d));
    const end = await Promise.race([done, new Promise((ok) => setTimeout(() => ok(null), 240_000))]);
    const after = (await api(`/api/state?me=${me}`)).me.balance;
    results.push({ npc: choice.n.name, stake: choice.n.stake, delta: after - balance, verdict: client.verdict });
    log(`match #${r.match.id} ${end ? "settled" : "timed out"}: balance ${fmt(balance)} -> ${fmt(after)} (${after - balance >= 0 ? "+" : ""}${fmt(after - balance)})${client.problems.length ? `; problems: ${client.problems.join("; ")}` : ""}`);
    client = null;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  stop();
  const net = results.reduce((a, r) => a + r.delta, 0);
  log(`done: ${results.length} match(es), net ${net >= 0 ? "+" : ""}${fmt(net)}`);
  if (CLEANUP && testnet) {
    try {
      const r = await pc.near.send(me, acct, me, [action.deleteAccount(info.house ?? info.contract)]);
      log(`deleted ${me}, balance returned to ${info.house}: ${r.hash}`);
      rmSync(files.acct);
      rmSync(files.session, { force: true });
    } catch (e) {
      console.error(`cleanup ${me}:`, e.message);
    }
  }
  process.exit();
}
