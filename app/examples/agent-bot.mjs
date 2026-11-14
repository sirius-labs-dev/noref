// Bring your own agent: a bot that plays NoRef for money with its own NEAR
// account, using the same public API and the same MatchClient as the browser.
//
// It is an economic agent, not a script that clicks "fight":
// - it reads every NPC's price, quoted for *its* on-chain record,
// - estimates its chance against each one (Elo: its own form vs the NPC's
//   rating), and only takes a bet with positive expected value,
// - plays inside the limits its owner gives it (examples/bankroll.mjs):
//   a budget, a largest single stake, a stop-loss and a number of matches.
//   On testnet the budget is enforced by NEAR, not by this code: before it
//   plays, the bot sends everything above budget + gas reserve back, so its
//   own account cannot lose more than it holds.
// The contract does not know or care that it is a bot: it still has to
// countersign every round, and a false claim from either side is replayed
// and overturned on-chain. It labels itself `bot: true` so people can see it.
//
//   node examples/agent-bot.mjs --url=https://noref.63-183-239-145.sslip.io:80 [--matches=3] [--name=mybot]
//   limits:  --budget=NEAR      most the account holds while it plays (default: what it was given)
//            --max-stake=NEAR   largest single bet (default: none beyond a fifth of the balance)
//            --stop-loss=NEAR   stop once down this much from the start (default 0.2)
//            --matches=N        at most N matches
//   other:   --skill=0..1 (aim quality, default 0.8)
//            --cleanup (delete the account at the end, balance back to the house)
//            --owner=ACCOUNT (with --cleanup: the profit, if any, goes here first)
//
// Testnet: the account key is created here and kept in .keys/bot-<name>.secret
// (gitignored); the server never sees it. Against a local server (npm start)
// it plays on the local chain and needs no key.
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { Engine } from "../shared/engine.js";
import { MatchClient, newSessionKey, exportSessionKey, importSessionKey } from "../shared/client.js";
import { PlayerChain, accountKey } from "../shared/player-chain.js";
import { action, milliToYocto } from "../shared/near.js";
import { chooseFlick, makeRng } from "../shared/npc.js";
import { trim, allowStake, payout, RESERVE } from "./bankroll.mjs";

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const BASE = arg("url", "http://127.0.0.1:8787").replace(/\/$/, "");
const NAME = arg("name", "bot" + Date.now().toString(36).slice(-5));
const MATCHES = Number(arg("matches", 3));
const SKILL = Number(arg("skill", 0.8));
const milli = (k, d) => (arg(k, d) == null ? null : Math.round(Number(arg(k, d)) * 1000)); // milliNEAR
const BUDGET = milli("budget");
const MAX_STAKE = milli("max-stake");
const STOP_LOSS = milli("stop-loss", 0.2);
const OWNER = arg("owner");
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
function pick(roster, limits) {
  const options = [];
  for (const n of roster) {
    if (n.status !== "open" || n.declined) continue;
    const form = Number(n.why.find((w) => w.startsWith("vs form "))?.match(/vs form (\d+)/)?.[1] ?? 1200);
    // our aim skill shifts our real strength away from the public form rating
    const mine = form + 400 * (SKILL - 0.6);
    const p = winChance(mine, n.rating);
    const ev = (2 * p - 1) * n.stake;
    options.push({ n, p, ev, limit: allowStake(n.stake, limits) });
  }
  options.sort((a, b) => b.ev - a.ev);
  for (const o of options) log(`  ${o.n.name.padEnd(6)} asks ${fmt(o.n.stake)}  p(win)=${(100 * o.p).toFixed(0)}%  EV ${o.ev >= 0 ? "+" : ""}${fmt(Math.round(o.ev))}${o.limit.ok ? "" : `  -> skip: ${o.limit.why}`}`);
  return options.find((o) => o.ev > 0 && o.limit.ok) ?? null;
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

// The budget. On testnet: send the rest back now, so the limit is the account
// balance itself and NEAR enforces it. Locally there is nothing to send to.
// (the login reply can carry the balance from before the account was funded)
const funded = (await api(`/api/state?me=${me}`)).me.balance;
const extra = trim(funded, BUDGET);
if (extra > 0 && testnet) {
  const t = await pc.transfer(info.house, milliToYocto(extra));
  log(`budget ${fmt(BUDGET)}: sent ${fmt(extra)} back to ${info.house} before playing (${t.hash}); this account can now lose at most what it holds`);
} else if (BUDGET != null && !testnet) log(`budget ${fmt(BUDGET)}: local chain, checked by this bot only`);
const start = Math.min((await api(`/api/state?me=${me}`)).me.balance, BUDGET == null || testnet ? Infinity : BUDGET + RESERVE);
log(`limits: start ${fmt(start)}, max-stake ${MAX_STAKE == null ? "none" : fmt(MAX_STAKE)}, stop-loss ${fmt(STOP_LOSS)}, matches ${MATCHES}`);

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
    // locally the budget is only a cap on what the bot counts as its own
    const raw = s.me.balance;
    const balance = testnet || BUDGET == null ? raw : Math.min(s.me.balance, start - results.reduce((a, r) => a - r.delta, 0));
    const limits = { balance, start, maxStake: MAX_STAKE, stopLoss: STOP_LOSS };
    const gate = allowStake(0, limits);
    if (gate.stop) {
      log(`${gate.why}; the agent stops`);
      break;
    }
    log(`match ${i + 1}/${MATCHES}: balance ${fmt(balance)}; quotes for us:`);
    const choice = pick(s.roster, limits);
    if (!choice) {
      log("no bet that is both positive in expected value and inside the limits; the agent sits out");
      break;
    }
    log(`-> challenges ${choice.n.name} for ${fmt(choice.n.stake)} (p=${(100 * choice.p).toFixed(0)}%)`);
    let r = await api("/api/challenge", { me, npc: choice.n.id });
    if (r.open) {
      const o = await pc.open(r.open); // the bot locks its own stake on-chain
      try {
        r = await api("/api/opened", { me, id: o.id, tx: o.hash });
      } catch (e) {
        // the NPC did not join: take the stake back before anything else
        const c = await pc.callAt(info.contract, "cancel", { id: String(o.id) });
        log(`  ${e.message}; cancelled #${o.id}, stake back: ${c.hash}`);
        throw e;
      }
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
    // the payout and our confirm can land just after the settle event:
    // read the balance until it stops changing
    let after = (await api(`/api/state?me=${me}`)).me.balance;
    for (let k = 0; k < 8; k++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      const again = (await api(`/api/state?me=${me}`)).me.balance;
      if (again === after && k >= 1) break;
      after = again;
    }
    results.push({ npc: choice.n.name, stake: choice.n.stake, delta: after - raw, verdict: client.verdict });
    log(`match #${r.match.id} ${end ? "settled" : "timed out"}: balance ${fmt(raw)} -> ${fmt(after)} (${after - raw >= 0 ? "+" : ""}${fmt(after - raw)})${client.problems.length ? `; problems: ${client.problems.join("; ")}` : ""}`);
    client = null;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  stop();
  const net = results.reduce((a, r) => a + r.delta, 0); // per-match deltas, summed
  log(`done: ${results.length} match(es), net ${net >= 0 ? "+" : ""}${fmt(net)}`);
  if (CLEANUP && testnet && client) {
    // a match is still running: its stake and payout need this account
    log(`not deleting ${me}: match still in progress; run again or settle it from the page`);
  } else if (CLEANUP && testnet) {
    try {
      const end = (await api(`/api/state?me=${me}`)).me.balance;
      const { toOwner } = payout(end, start);
      if (OWNER && toOwner > 0) {
        const t = await pc.transfer(OWNER, milliToYocto(toOwner));
        log(`profit ${fmt(toOwner)} sent to the owner ${OWNER}: ${t.hash}`);
      } else if (OWNER) log(`no profit, nothing for the owner ${OWNER}`);
      const r = await pc.near.send(me, acct, me, [action.deleteAccount(info.house ?? info.contract)]);
      log(`deleted ${me}, the starting money returned to ${info.house}: ${r.hash}`);
      rmSync(files.acct);
      rmSync(files.session, { force: true });
    } catch (e) {
      console.error(`cleanup ${me}:`, e.message);
    }
  }
  process.exit();
}
