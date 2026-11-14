// NoRef local server: static web client, game protocol, NPC fighters,
// economy and a local chain that mirrors the NEAR contract.
//
//   node server/main.ts            (Node 23.6+; no npm install needed)
//   PORT=8787 DATA=./data node server/main.ts
//   CHAIN=testnet node server/main.ts   (real NoRef contract on NEAR testnet;
//                                        needs ../.keys/<HOUSE>.json)
//
// API (JSON):
//   POST /api/login {name, key, bot?}          -> account, faucet balance (bot: true labels an agent)
//   GET  /api/state?me=                        -> roster, prices + reasons, balances, events
//   GET  /api/events?me=                       -> server-sent events
//   POST /api/challenge {me, npc, liar}        -> starts a match vs an NPC
//   POST /api/match/:id/commit {me, hash}
//   POST /api/match/:id/reveal {me, dvx, dvy, salt}
//   POST /api/match/:id/sign {me, tick, sig}
//   POST /api/match/:id/claim {me, winner}
//   POST /api/match/:id/confirm {me}
//   POST /api/match/:id/dispute {me, log, signedTick, sig}   (log/sig hex)
//   GET  /api/match/:id/evidence
//   GET  /api/leaderboard?me=                  -> Gauntlet progress + top players, from settled matches
//   POST /api/sponsor {me, npc, amount} | /api/cashout {me, npc, shares}
//   POST /api/fastforward {days}               -> runs the NPC ladder for simulated days

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { Engine, encodeLog, encodeEntries as encodeEntriesLocal, unhex, SIDE } from "../shared/engine.js";
import { chooseFlick, makeRng } from "../shared/npc.js";
import * as eco from "../shared/economy.js";
import { LocalChain } from "./chain-local.ts";
import { TestnetChain } from "./chain-testnet.ts";
import { Near } from "../shared/near.js";
import { LiveMatch, PvpMatch } from "./match.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST; // e.g. 127.0.0.1 behind a reverse proxy
// public demo: cap how many new funded testnet accounts the faucet makes
const FRESH_PER_IP = Number(process.env.FRESH_PER_IP ?? 3);
const FRESH_PER_DAY = Number(process.env.FRESH_PER_DAY ?? 25);
const freshLog: { ip: string; t: number }[] = [];
const DATA = process.env.DATA ?? join(ROOT, "data");
const CHAIN = process.env.CHAIN ?? "local";
const TESTNET = CHAIN === "testnet";
// the contract lives on a key-less account (nobody can redeploy it); the house
// account creates and funds player and NPC accounts and owns their names
const CONTRACT = process.env.CONTRACT ?? "arena.noref.testnet";
const HOUSE = process.env.HOUSE ?? "noref.testnet";
const RPC = process.env.RPC ?? "https://rpc.testnet.fastnear.com";
// the contract allows 10 s minimum; testnet blocks also need a moment
const WINDOW_SECS = Number(process.env.WINDOW_SECS ?? (TESTNET ? 15 : 8));
const FAUCET = TESTNET ? Number(process.env.PLAYER_FUND ?? 800) : 20 * eco.MILLI;
const LADDER_MS = Number(process.env.LADDER_MS ?? (TESTNET ? 15 * 60_000 : 25_000));
// testnet economy: NPC bankrolls are their real chain balances
const NPC_RESERVE = 300; // milliNEAR kept in each NPC account for gas and storage
const RESCUE_MS = Number(process.env.RESCUE_MS ?? 2 * 3600_000); // closed this long -> the house backs it again
const DIVIDEND_AT = Number(process.env.DIVIDEND_AT ?? 3000); // bankroll above this pays dividends...
const DIVIDEND_KEEP = Number(process.env.DIVIDEND_KEEP ?? 2000); // ...down to this
const HOUSE_FLOOR = Number(process.env.HOUSE_FLOOR ?? 3000); // the house keeps this much for new players
const HOUSE_LOCKED = 2100; // milliNEAR on the house held by the first deployment's storage, never spendable
// below this the site warns that the faucet is running low; below one more account it stops making them
const HOUSE_LOW = Number(process.env.HOUSE_LOW ?? 6000);

const engine = await Engine.load(readFileSync(join(ROOT, "web/engine.wasm")));
const chain: any = TESTNET ? new TestnetChain({ near: new Near(RPC), contract: CONTRACT, house: HOUSE, keysDir: new URL("../../.keys/", import.meta.url) }) : new LocalChain(engine);

// ---- persistent economy ----
type World = { roster: any[]; feed: { t: number; text: string }[]; players: Record<string, { key: string; bot?: boolean }>; balances: Record<string, number>; simDays: number; clockOffsetMs?: number };
mkdirSync(DATA, { recursive: true });
const FILE = join(DATA, "world.json");
const world: World = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { roster: eco.startingRoster(), feed: [], players: {}, balances: {}, simDays: 0 };
if (TESTNET) await chain.init(world.roster.map((n) => n.id));
else for (const [k, v] of Object.entries(world.balances)) chain.balances.set(k, v);
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!TESTNET) world.balances = Object.fromEntries(chain.balances);
    writeFileSync(FILE, JSON.stringify(world));
  }, 300);
}
const npcById = (id: string) => world.roster.find((n) => n.id === id);
/** World clock: real time plus whatever fast-forward has skipped ahead. */
const nowW = () => Date.now() + (world.clockOffsetMs ?? 0);

function feed(text: string, t = nowW(), url?: string) {
  const f: any = url ? { t, text, url } : { t, text };
  world.feed.push(f);
  if (world.feed.length > 300) world.feed.splice(0, world.feed.length - 300);
  broadcast("feed", f);
  persist();
}

// ---- server-sent events ----
const clients = new Map<string, Set<any>>();
function sendTo(me: string, kind: string, data: unknown) {
  for (const res of clients.get(me) ?? []) res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(kind: string, data: unknown) {
  for (const set of clients.values()) for (const res of set) res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---- matches ----
const live = new Map<number, LiveMatch>();
const escrow = new Map<number, { npc: string; stake: number; oppRating?: number }>();
const pendingOpen = new Map<string, { npc: string; stake: number; liar: boolean; t: number; oppRating: number }>();
// person vs person: open invites by match id, and testnet creates waiting for their tx
const invites = new Map<number, { host: string; stake: number; t: number }>();
const pendingPvp = new Map<string, { stake: number; t: number }>();
const inMatch = (me: string) => [...live.values()].some((m: any) => (m.pvp ? m.players.includes(me) : m.human === me));
const usedTx = new Set<string>();

// ---- a player's public form, read from settled matches on the contract ----
const formCache = new Map<string, { t: number; v: any }>();
/** {rating, wins, losses, draws, liesCaught}; NPCs price their bets with this. */
async function form(me: string) {
  const hit = formCache.get(me);
  if (hit && Date.now() - hit.t < 60_000) return hit.v;
  const rec = await (chain as any).record(TESTNET ? chain.acct(me) : me);
  const v = { ...rec, rating: eco.formRating(rec) };
  formCache.set(me, { t: Date.now(), v });
  return v;
}
// ---- Gauntlet + leaderboard: who has beaten which fighters, from the contract ----
let boardCache: { t: number; v: any[] } | null = null;
async function board() {
  if (boardCache && Date.now() - boardCache.t < 30_000) return boardCache.v;
  const npcs = new Map<string, string>(world.roster.map((n: any) => [TESTNET ? chain.acct(n.id) : n.id, n.name]));
  const rows = eco.standings(await chain.finals(), npcs, [HOUSE]).map((r: any) => ({ ...r, bot: !!world.players[r.account]?.bot }));
  boardCache = { t: Date.now(), v: rows };
  return rows;
}

const tag = (me: string) => (world.players[me]?.bot ? `${me} (bot)` : me);

chain.onEvent = (e) => {
  const m = chain.matches[e.match];
  if (m) {
    sendTo(m.a, "chain", e);
    if (m.b && !npcById(m.b)) sendTo(m.b, "chain", e);
  }
  if (e.kind === "settle") {
    boardCache = null;
    onSettled(e.match);
  }
  persist();
};

function onSettled(id: number) {
  const m = chain.matches[id];
  const lm: any = live.get(id);
  if (lm?.pvp) {
    const [a, b] = lm.players.map((x: string) => PvpMatch.short(x) + (world.players[x]?.bot ? " (bot)" : ""));
    lm.players.forEach((x: string) => formCache.delete(x));
    boardCache = null;
    const r = m.replayed ? (m.replayed.winner !== m.claim?.winner ? " after a replay overturned a false claim" : " after a replay confirmed the claim") : "";
    feed(`${a} vs ${b}: ${m.result === SIDE.DRAW ? "draw" : (m.result === SIDE.FIRST ? a : b) + " won"} ${eco.fmt(2 * m.stake)} pot${r}`);
    live.delete(id);
    persist();
    return;
  }
  const esc = escrow.get(id);
  if (!esc) return;
  escrow.delete(id);
  const npc = npcById(esc.npc);
  const npcSide = m.b === npc.id ? SIDE.SECOND : SIDE.FIRST;
  // NPC's payout comes back from its chain account into its bankroll
  const payout = m.result === SIDE.DRAW ? esc.stake : m.result === npcSide ? 2 * esc.stake : 0;
  if (!TESTNET) chain.balances.set(npc.id, 0);
  const score = m.result === SIDE.DRAW ? 0.5 : m.result === npcSide ? 1 : 0;
  npc.bankroll += esc.stake; // un-escrow, then book the result
  const events = eco.recordResult(npc, { delta: payout - esc.stake, score, oppRating: esc.oppRating ?? 1200, now: nowW(), upkeep: TESTNET ? 0 : eco.UPKEEP });
  const humanId = m.a === npc.id ? m.b : m.a;
  formCache.delete(humanId);
  boardCache = null;
  const human = tag(humanId);
  const replayNote = m.replayed ? (m.replayed.winner !== m.claim?.winner ? " after a replay overturned a false claim" : " after a replay confirmed the claim") : "";
  feed(`${human} vs ${npc.name}: ${m.result === SIDE.DRAW ? "draw" : score === 1 ? npc.name + " won" : human + " won"} ${eco.fmt(2 * m.stake)} pot${replayNote}`);
  events.forEach((t) => feed(t));
  live.delete(id);
}

setInterval(() => {
  try {
    chain.tick();
  } catch (e) {
    console.error(e);
  }
}, 500);

// ---- NPC vs NPC ladder (also used by fast-forward) ----
function simulateNpcMatch(a: any, b: any, rng: () => number, now: number, book = true) {
  // each NPC prices the other from its public record; either one may refuse
  const asOpp = (n: any) => ({ rating: n.rating, wins: n.wins, losses: n.losses, draws: n.draws ?? 0, liesCaught: 0 });
  const qa = eco.askStake(a, now, asOpp(b));
  const qb = eco.askStake(b, now, asOpp(a));
  if (qa.declined || qb.declined) return null;
  const stake = Math.min(qa.stake, qb.stake);
  if (stake < eco.MIN_STAKE) return null;
  engine.reset();
  const R = engine.ROUND_TICKS;
  const records: any[] = [];
  for (let round = 0; round < engine.MATCH_TICKS / R; round++) {
    const table = engine.getState();
    const fa = chooseFlick(engine, { ball: 0, style: a.style, skill: a.skill, rng, fast: true });
    engine.setState(table);
    const fb = chooseFlick(engine, { ball: 1, style: b.style, skill: b.skill, rng, fast: true });
    engine.setState(table);
    const entries = [];
    if (!fa.pass) entries.push({ ball: 0, dvx: fa.dvx, dvy: fa.dvy });
    if (!fb.pass) entries.push({ ball: 1, dvx: fb.dvx, dvy: fb.dvy });
    if (entries.length) records.push({ tick: round * R, entries });
    engine.setState(table);
    engine.tick(entries.length ? encodeEntriesLocal(entries) : new Uint8Array(0), round * R);
    engine.runTicks(R - 1, round * R + 1);
  }
  // the verdict always comes from the full replay, same as the contract
  const winner = engine.replay(encodeLog(records), engine.MATCH_TICKS, engine.MATCH_TICKS - 1).winner;
  const sa = winner === SIDE.DRAW ? 0.5 : winner === SIDE.FIRST ? 1 : 0;
  const ra = a.rating;
  const rb = b.rating;
  // on testnet (book = false) the money moves on-chain; only ratings and records change here
  const k = book ? 1 : 0;
  const up = book ? eco.UPKEEP : 0;
  const ev = [
    ...eco.recordResult(a, { delta: k * (sa === 1 ? stake : sa === 0 ? -stake : 0), score: sa, oppRating: rb, now, upkeep: up }),
    ...eco.recordResult(b, { delta: k * (sa === 0 ? stake : sa === 1 ? -stake : 0), score: 1 - sa, oppRating: ra, now, upkeep: up }),
  ];
  return { winner, stake, events: ev };
}

function ladderOnce(rng: () => number, now: number, quiet = false) {
  const open = world.roster.filter((n) => eco.isOpen(n));
  if (open.length < 2) return;
  const i = Math.floor(rng() * open.length);
  let j = Math.floor(rng() * (open.length - 1));
  if (j >= i) j++;
  const [a, b] = [open[i], open[j]];
  eco.noteChallenge(a, now);
  const r = simulateNpcMatch(a, b, rng, now);
  if (!r) return;
  if (!quiet) feed(`Ladder: ${a.name} vs ${b.name} for ${eco.fmt(2 * r.stake)}: ${r.winner === SIDE.DRAW ? "draw" : (r.winner === SIDE.FIRST ? a.name : b.name) + " won"}`, now);
  r.events.forEach((t) => feed(t, now));
}

const ladderRng = makeRng(Date.now() & 0xffffffff);
if (!TESTNET)
  setInterval(() => {
    if (live.size === 0) ladderOnce(ladderRng, nowW());
    persist();
  }, LADDER_MS);

// ---- the house: funds every new player, so the demo stops when it runs dry ----
/** ok | low (warn) | empty (no new accounts). Spendable = balance minus locked storage. */
function houseState() {
  if (!TESTNET) return "ok";
  const spendable = chain.balance(HOUSE) - HOUSE_LOCKED;
  return spendable < FAUCET + 300 ? "empty" : spendable < HOUSE_LOW ? "low" : "ok";
}
let houseWas = "ok";
/** Log every change of state, so `journalctl -u noref | grep house` shows when to refill. */
function watchHouse() {
  const now = houseState();
  if (now === houseWas) return;
  const line = `house ${HOUSE}: ${eco.fmt(chain.balance(HOUSE))} -> ${now}${now === "ok" ? "" : " (refill: node scripts-refill.mjs)"}`;
  (now === "ok" ? console.log : console.warn)(line);
  houseWas = now;
}

// ---- testnet economy: the chain is the ledger ----
/** Bankroll = the NPC account's real balance minus its gas reserve; then open/close, rescue, dividends. */
async function syncNpcs() {
  await chain.refreshBalance(HOUSE);
  watchHouse();
  const busy = new Set([...live.values()].filter((m: any) => !m.pvp).map((m: any) => m.npc.id));
  for (const n of world.roster) {
    if (busy.has(n.id)) continue; // its stake is locked in a live match; settle first
    if (chain.isVault(n.id)) {
      await syncVault(n);
      continue;
    }
    const bal = (await chain.hasAccount(n.id)) ? await chain.refreshBalance(n.id) : 0;
    n.bankroll = Math.max(0, bal - NPC_RESERVE);
    eco.updateStatus(n, nowW()).forEach((t) => feed(t));
    // sponsor of last resort: after a while closed, the house backs it again
    if (n.status === "retired" && n.closedAt && nowW() - n.closedAt > RESCUE_MS) {
      const amount = eco.REOPEN_AT + 100 - n.bankroll;
      if (chain.balance(HOUSE) - amount > HOUSE_FLOOR + HOUSE_LOCKED) {
        const hash = await chain.houseBack(n.id, amount);
        eco.sponsor(n, "house", amount, nowW()).events.forEach((t) => feed(t, nowW(), chain.explorer(hash)));
      }
    }
    // dividends: a fighter that grows too rich pays its backers
    if (n.bankroll > DIVIDEND_AT) {
      const plan = eco.dividendPlan(n, n.bankroll - DIVIDEND_KEEP);
      let paid = 0;
      let last = "";
      for (const d of plan) {
        const to = d.who === "house" ? HOUSE : d.who;
        try {
          last = await chain.pay(n.id, to, d.amount);
          paid += d.amount;
        } catch (e: any) {
          console.error(`dividend ${n.id} -> ${to}:`, e.message);
        }
      }
      if (paid) {
        n.bankroll -= paid;
        feed(`${n.name} paid ${eco.fmt(paid)} in dividends to its ${plan.length} backer(s)`, nowW(), last ? chain.explorer(last) : undefined);
      }
    }
  }
  persist();
}

/**
 * A fighter with a vault: its bankroll, shares and holders are read from its
 * contract; dividends and rescues are calls to it. The server only mirrors.
 */
async function syncVault(n: any) {
  await chain.vaultUnstick(n.id, (id: number) => live.has(id) || invites.has(id)).catch((e: any) => console.error(`unstick ${n.id}:`, e.message));
  if ((await chain.vaultSyncAll(n.id)) > 0) await new Promise((ok) => setTimeout(ok, 1500));
  const v = await chain.vaultInfo(n.id);
  const holders = await chain.vaultHolders(n.id);
  n.vault = true;
  n.bankroll = Math.floor(Number(BigInt(v.bankroll) / 10n ** 21n));
  n.shares = Number(v.total_shares);
  n.holders = Object.fromEntries(holders.map(([who, sh]) => [who === HOUSE ? "house" : who, Number(sh)]));
  n.divAt = Math.floor(Number(BigInt(v.div_at) / 10n ** 21n));
  n.vaultMax = Math.floor(Number(BigInt(v.max_stake) / 10n ** 21n));
  eco.updateStatus(n, nowW()).forEach((t) => feed(t));
  // sponsor of last resort: after a while closed, the house backs it, buying shares like anyone
  if (n.status === "retired" && n.closedAt && nowW() - n.closedAt > RESCUE_MS) {
    const amount = eco.REOPEN_AT + 100 - n.bankroll;
    if (chain.balance(HOUSE) - amount > HOUSE_FLOOR + HOUSE_LOCKED) {
      const hash = await chain.houseBack(n.id, amount);
      feed(`The house backed ${n.name} with ${eco.fmt(amount)}: shares bought from its vault`, nowW(), chain.explorer(hash));
      return syncVault(n);
    }
  }
  // dividends: the vault sets the excess aside and pays every holder pro rata
  if (n.bankroll > n.divAt) {
    try {
      const d = await chain.vaultDividends(n.id);
      feed(`${n.name}'s vault paid ${eco.fmt(d.total)} in dividends to ${d.paid.length} holder(s)`, nowW(), chain.explorer(d.hash));
      for (const p of d.paid) if (p.who !== HOUSE) feed(`${p.who} received ${eco.fmt(p.milli)} from ${n.name}`, nowW(), chain.explorer(p.hash));
      return syncVault(n);
    } catch (e: any) {
      console.error(`dividends ${n.id}:`, e.message);
    }
  }
}

let ladderBusy = false;
let ladderPair = "";
async function ladderOnchain() {
  if (ladderBusy || live.size > 0) return;
  ladderBusy = true;
  try {
    await syncNpcs();
    ladderPair = "";
    // a vault that cannot stake the minimum is closed by its contract
    const open = world.roster.filter((n) => eco.isOpen(n) && !(n.vault && Math.min(n.vaultMax * 0.9, n.vaultMax - 8) < eco.MIN_STAKE));
    if (open.length < 2) return;
    const i = Math.floor(ladderRng() * open.length);
    let j = Math.floor(ladderRng() * (open.length - 1));
    if (j >= i) j++;
    const [a, b] = [open[i], open[j]];
    const now = nowW();
    eco.noteChallenge(a, now);
    const r = simulateNpcMatch(a, b, ladderRng, now, false);
    if (!r) return;
    // the vaults check the stake against their bankroll at call time: read
    // their limits now and stay under both, with room for the call's gas
    let limit = Infinity;
    for (const n of [a, b]) if (n.vault) limit = Math.min(limit, Math.floor(Number(BigInt((await chain.vaultInfo(n.id)).max_stake) / 10n ** 21n)));
    const room = Math.min(limit * 0.9, limit - 8); // same spare as eco.askStake
    if (r.stake > room) r.stake = Math.floor(room / 10) * 10;
    if (r.stake < eco.MIN_STAKE) return;
    ladderPair = `${a.id} vs ${b.id} stake ${r.stake} (vault limit ${limit})`;
    const tx = await chain.ladderMatch(a.id, b.id, r.stake, r.winner, engine.MATCH_TICKS);
    const who = r.winner === SIDE.DRAW ? "draw" : (r.winner === SIDE.FIRST ? a.name : b.name) + " won";
    feed(`Ladder match #${tx.id} on-chain: ${a.name} vs ${b.name} for ${eco.fmt(2 * r.stake)}: ${who}`, now, chain.explorer(tx.settle));
    r.events.forEach((t) => feed(t, now));
    await syncNpcs();
  } catch (e: any) {
    console.error("ladder:", ladderPair, e.message);
  } finally {
    ladderBusy = false;
  }
}
if (TESTNET) {
  setTimeout(() => syncNpcs().catch((e) => console.error("sync:", e.message)), 3000);
  setInterval(() => syncNpcs().catch((e) => console.error("sync:", e.message)), 60_000);
  setInterval(() => ladderOnchain(), LADDER_MS);
}

// ---- views ----
/** Evenly thin a series to at most `max` points, always keeping the last. */
function sample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(xs[Math.floor((i * (xs.length - 1)) / (max - 1))]);
  out.push(xs[xs.length - 1]);
  return out;
}
function rosterView(now = nowW(), opp: any = null) {
  return world.roster.map((n) => {
    const p = eco.askStake(n, now, opp);
    return {
      id: n.id,
      account: TESTNET ? chain.acct(n.id) : null,
      name: n.name,
      style: n.style,
      skill: n.skill,
      bankroll: n.bankroll,
      rating: Math.round(n.rating),
      wins: n.wins,
      losses: n.losses,
      draws: n.draws ?? 0,
      status: eco.isOpen(n) ? "open" : "retired",
      stake: p.stake,
      why: p.why,
      declined: p.declined,
      sharePrice: eco.sharePrice(n),
      vault: !!n.vault,
      shares: n.shares,
      holders: n.holders,
      history: sample(n.history, 240),
    };
  });
}

// ---- http ----
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".json": "application/json" };

function body(req: any): Promise<any> {
  return new Promise((ok, fail) => {
    let s = "";
    req.on("data", (c: Buffer) => {
      s += c;
      if (s.length > 1e6) fail(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        ok(s ? JSON.parse(s) : {});
      } catch (e) {
        fail(e);
      }
    });
  });
}

function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw Object.assign(new Error(msg), { status: 400 });
}

function player(me: string) {
  need(typeof me === "string" && world.players[me], "unknown player: log in first");
  return world.players[me];
}

async function api(req: any, url: URL): Promise<unknown> {
  const p = url.pathname;
  const q = req.method === "POST" ? await body(req) : Object.fromEntries(url.searchParams);

  if (p === "/api/login") {
    need(/^[a-z0-9_-]{2,20}$/.test(q.name ?? ""), "name: 2-20 chars, a-z 0-9 _ -");
    need(/^[0-9a-f]{64}$/.test(q.key ?? ""), "key: 64 hex chars");
    need(!npcById(q.name), "that name belongs to an NPC");
    if (TESTNET) {
      // the browser holds the account key; we only ever see its public half
      need(/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(q.account ?? ""), "account: ed25519 public key");
      const ip = String(req.headers["x-forwarded-for"] ?? "").split(",").pop()!.trim() || req.socket.remoteAddress || "?";
      const known = !!world.players[chain.playerAccount(q.name)];
      if (!known) {
        const day = Date.now() - 86_400_000;
        while (freshLog.length && freshLog[0].t < day) freshLog.shift();
        need(freshLog.filter((f) => f.ip === ip).length < FRESH_PER_IP, "too many new accounts from your network today; log in with an existing name");
        need(freshLog.length < FRESH_PER_DAY, "the demo faucet is resting for today; try again tomorrow");
        await chain.refreshBalance(HOUSE);
        watchHouse();
        need(houseState() !== "empty", "the demo faucet is empty right now, so new names get no test NEAR; watch the recorded match, or come back later");
      }
      const r = await chain.ensurePlayer(q.name, q.account, FAUCET);
      if (r.fresh) {
        freshLog.push({ ip, t: Date.now() });
        await chain.refreshBalance(HOUSE).catch(() => {});
        watchHouse();
      }
      world.players[r.id] = { key: q.key, ...(q.bot ? { bot: true } : {}) };
      if (r.fresh && q.bot) feed(`${r.id} joined as a bot: an agent with its own NEAR account`);
      persist();
      return { me: r.id, balance: chain.balance(r.id), fresh: r.fresh, tx: r.hash, chain: chainInfo() };
    }
    const me = `${q.name}.local`;
    const fresh = !world.players[me];
    world.players[me] = { key: q.key, ...(q.bot ? { bot: true } : {}) };
    if (fresh && q.bot) feed(`${me} joined as a bot: an agent with its own account`);
    if (fresh) chain.credit(me, FAUCET);
    persist();
    return { me, balance: chain.balance(me), fresh, chain: chainInfo() };
  }

  // health for the team: is the faucet able to make new players?
  if (p === "/api/health") {
    return { ok: true, house: HOUSE, balance: TESTNET ? chain.balance(HOUSE) : null, faucet: houseState(), newToday: freshLog.length, live: live.size };
  }

  // the player's own matches that still hold their stake, and what they can sign to get it back
  if (p === "/api/stuck") {
    if (!TESTNET || !q.me || !world.players[q.me]) return { stuck: [] };
    const busy = (id: number) => live.has(id) || invites.has(id);
    const now = Date.now();
    const stuck = [];
    for (const c of await chain.unsettled(q.me)) {
      if (busy(c.id)) continue; // still being played or waiting on an invite this server knows about
      const base = { id: c.id, stake: Number(BigInt(c.stake) / 10n ** 21n), opponent: c.a === q.me ? c.b : c.a };
      if (c.phase === "Open") {
        if (c.a === q.me) stuck.push({ ...base, action: "cancel", why: "nobody joined" });
        continue;
      }
      if (c.claim) {
        const at = Number(BigInt(c.window_end_ns) / 1_000_000n);
        stuck.push({ ...base, action: "finalize", why: "claimed, never paid out", readyAt: at });
        continue;
      }
      const end = Number(BigInt(c.started_ns) / 1_000_000n) + (c.duration / 60) * 1000;
      // the contract's refund cannot pay a draw on the deployed arena (see the
      // README's known issue), so the player claims the match: the other side
      // can still dispute it with the log it signed, then anyone finalizes
      stuck.push({ ...base, action: "claim", args: { winner: c.a === q.me ? 1 : 2 }, why: "the other side stopped: claim the pot (it can still dispute with the log it signed)", readyAt: end + 2 * 60_000 });
    }
    return { stuck, now };
  }

  if (p === "/api/leaderboard") {
    const rows = await board();
    return { fighters: world.roster.map((n: any) => n.name), top: rows.slice(0, 10), me: q.me ? rows.find((r: any) => r.account === q.me) ?? null : null, players: rows.length, from: "settled matches on " + (TESTNET ? CONTRACT : "the local chain") };
  }

  if (p === "/api/state") {
    return {
      roster: rosterView(nowW(), q.me && world.players[q.me] ? await form(q.me).catch(() => null) : null),
      feed: world.feed.slice(-60),
      me: q.me && world.players[q.me] ? { id: q.me, balance: TESTNET ? await chain.refreshBalance(q.me).catch(() => chain.balance(q.me)) : chain.balance(q.me) } : null,
      chainEvents: chain.events.slice(-40),
      simDays: world.simDays,
      rules: { minStake: eco.MIN_STAKE, upkeep: eco.UPKEEP, reopenAt: eco.REOPEN_AT, brokeBelow: eco.BROKE_BELOW, baseStake: eco.BASE_STAKE },
      clock: nowW(),
      chain: chainInfo(),
    };
  }

  if (p === "/api/challenge") {
    const me = q.me;
    const pl = player(me);
    const npc = npcById(q.npc);
    need(npc && eco.isOpen(npc), "that NPC is closed");
    need(!inMatch(me), "finish your current match first");
    const opp = await form(me);
    // a vault checks the stake against its bankroll right now: quote from it
    if (TESTNET && npc.vault) await syncVault(npc);
    const quote = eco.askStake(npc, nowW(), opp);
    need(!quote.declined, `${npc.name} won't play you: ${quote.why[quote.why.length - 1]}`);
    const { stake } = quote;
    if (TESTNET) await chain.refreshBalance(me);
    need(chain.balance(me) >= stake + (TESTNET ? 20 : 0), `you need ${eco.fmt(stake)}`);
    eco.noteChallenge(npc, nowW());
    if (TESTNET) {
      // step 1 of 2: the browser signs `create` itself, then calls /api/opened
      await chain.ensureNpc(npc.id, stake);
      pendingOpen.set(me, { npc: npc.id, stake, liar: !!q.liar, t: Date.now(), oppRating: opp.rating });
      return { open: { contract: CONTRACT, method: "create", args: { duration: engine.MATCH_TICKS, session_key: pl.key, window_secs: WINDOW_SECS, opponent: chain.acct(npc.id) }, deposit: String(BigInt(stake) * 10n ** 21n) }, stake };
    }
    // human opens (side A, ball 0), NPC joins (side B, ball 1)
    const id = chain.create(me, stake, engine.MATCH_TICKS, pl.key, WINDOW_SECS);
    return startLive(id, me, pl, npc, stake, !!q.liar, opp.rating);
  }

  // ---- person vs person, by invite link ----
  if (p === "/api/pvp/create") {
    const me = q.me;
    const pl = player(me);
    need(!inMatch(me), "finish your current match first");
    const stake = Math.round(Number(q.amount) * eco.MILLI);
    need(stake >= eco.MIN_STAKE && stake <= 5 * eco.MILLI, `stake: ${eco.fmt(eco.MIN_STAKE)} to 5 NEAR`);
    if (TESTNET) await chain.refreshBalance(me);
    need(chain.balance(me) >= stake + (TESTNET ? 20 : 0), `you need ${eco.fmt(stake)}`);
    if (TESTNET) {
      pendingPvp.set(me, { stake, t: Date.now() });
      return { open: { contract: CONTRACT, method: "create", args: { duration: engine.MATCH_TICKS, session_key: pl.key, window_secs: WINDOW_SECS, opponent: null }, deposit: String(BigInt(stake) * 10n ** 21n) }, stake };
    }
    const id = chain.create(me, stake, engine.MATCH_TICKS, pl.key, WINDOW_SECS);
    invites.set(id, { host: me, stake, t: Date.now() });
    return { id, stake };
  }

  if (p === "/api/pvp/opened") {
    need(TESTNET, "testnet only");
    const me = q.me;
    const pl = player(me);
    const o = pendingPvp.get(me);
    need(o, "create an invite first");
    const id = Number(q.id);
    need(Number.isInteger(id) && id >= 0 && !live.has(id), "bad match id");
    if (q.tx) chain.hint(id, "create", String(q.tx));
    const m: any = await chain.track(id);
    need(m.a === me && m.phase === "open" && m.keyA === pl.key && !m.invited && m.duration === engine.MATCH_TICKS && m.stake === o.stake, "on-chain match does not match the invite");
    pendingPvp.delete(me);
    invites.set(id, { host: me, stake: o.stake, t: Date.now() });
    return { id, stake: o.stake };
  }

  if (p === "/api/pvp/invite") {
    const id = Number(q.id);
    const inv = invites.get(id);
    const m: any = TESTNET && inv ? await chain.track(id).catch(() => null) : chain.matches[id];
    return { id, host: inv?.host ?? m?.a ?? null, stake: inv?.stake ?? m?.stake ?? null, open: !!inv && m?.phase === "open" };
  }

  if (p === "/api/pvp/join") {
    const me = q.me;
    const pl = player(me);
    const id = Number(q.id);
    const inv = invites.get(id);
    need(inv, "this invite is gone (already played or cancelled)");
    need(inv.host !== me, "that is your own invite: send the link to a friend");
    need(!inMatch(me), "finish your current match first");
    if (TESTNET) await chain.refreshBalance(me);
    need(chain.balance(me) >= inv.stake + (TESTNET ? 20 : 0), `you need ${eco.fmt(inv.stake)}`);
    if (TESTNET) return { call: { contract: CONTRACT, method: "join", args: { id: String(id), session_key: pl.key }, deposit: String(BigInt(inv.stake) * 10n ** 21n) }, stake: inv.stake };
    chain.join(me, id, pl.key);
    return startPvp(id, me);
  }

  if (p === "/api/pvp/joined") {
    need(TESTNET, "testnet only");
    const me = q.me;
    const pl = player(me);
    const id = Number(q.id);
    need(invites.has(id), "this invite is gone");
    if (q.tx) chain.hint(id, "join", String(q.tx));
    let m: any = null;
    for (let i = 0; i < 6; i++) {
      await chain.refresh(id);
      m = chain.matches[id];
      if (m?.phase === "live") break;
      await new Promise((ok) => setTimeout(ok, 800));
    }
    need(m && m.b === me && m.phase === "live" && m.keyB === pl.key, "the join is not on-chain yet");
    return startPvp(id, me);
  }

  if (p === "/api/pvp/cancel") {
    const me = q.me;
    player(me);
    const id = Number(q.id);
    const inv = invites.get(id);
    need(inv && inv.host === me, "not your invite");
    if (!TESTNET) chain.cancel(me, id); // on testnet the host signs `cancel` in the browser
    invites.delete(id);
    return { ok: true };
  }

  if (p === "/api/opened") {
    need(TESTNET, "testnet only");
    const me = q.me;
    const pl = player(me);
    const o = pendingOpen.get(me);
    need(o, "challenge first");
    const id = Number(q.id);
    need(Number.isInteger(id) && id >= 0 && !live.has(id), "bad match id");
    if (q.tx) chain.hint(id, "create", String(q.tx));
    const m = await chain.track(id);
    const npc = npcById(o.npc);
    // verify what the player actually put on-chain
    need(m.a === me && m.phase === "open" && m.keyA === pl.key && (m as any).invited === npc.id && m.duration === engine.MATCH_TICKS && m.stake === o.stake, "on-chain match does not match the challenge");
    pendingOpen.delete(me);
    return startLive(id, me, pl, npc, o.stake, o.liar, o.oppRating);
  }  function startPvp(id: number, me: string) {
    const m: any = chain.matches[id];
    const inv = invites.get(id)!;
    invites.delete(id);
    const pm = new PvpMatch({
      id,
      players: [m.a, m.b],
      keys: [m.keyA, m.keyB],
      engine,
      send: (who, k, d) => sendTo(who, k, { match: id, ...(d as object) }),
      onDone: () => persist(),
    });
    live.set(id, pm as any);
    // the joiner gets its match in the reply; the host is told over its event stream
    sendTo(m.a, "pvp_start", { match: id, info: pm.info(0), stake: inv.stake });
    feed(`${PvpMatch.short(m.a)} vs ${PvpMatch.short(m.b)}: a match between two people for ${eco.fmt(2 * inv.stake)}`);
    setTimeout(() => pm.start(), 1800);
    return { match: pm.info(pm.sideOf(me)), stake: inv.stake };
  }

  async function startLive(id: number, me: string, pl: any, npc: any, stake: number, liar: boolean, oppRating = 1200) {
    const lm = new LiveMatch({
      id,
      human: me,
      humanKey: pl.key,
      npc,
      liar,
      engine,
      chain,
      send: (k, d) => sendTo(me, k, { match: id, ...(d as object) }),
      claimDelayMs: TESTNET ? 7000 : 2500,
      onDone: () => persist(),
    });
    npc.bankroll -= stake; // escrow from bankroll into its chain account
    if (!TESTNET) chain.credit(npc.id, stake);
    escrow.set(id, { npc: npc.id, stake, oppRating });
    live.set(id, lm);
    try {
      await chain.join(npc.id, id, lm.npcKey.pub);
    } catch (e) {
      live.delete(id);
      escrow.delete(id);
      npc.bankroll += stake;
      throw e;
    }
    setTimeout(() => lm.start(), 600);
    return { match: lm.info(), stake };
  }

  const mm = p.match(/^\/api\/match\/(\d+)\/(\w+)$/);
  if (mm) {
    const id = Number(mm[1]);
    const action = mm[2];
    const lm = live.get(id);
    if (action === "evidence") {
      need(lm, "no live match");
      return lm.evidence();
    }
    const me = q.me;
    player(me);
    const m = chain.matches[id];
    need(m && (m.a === me || m.b === me), "not your match");
    if (action === "commit") {
      need(lm, "match over");
      need(/^[0-9a-f]{64}$/.test(q.hash ?? ""), "hash");
      if ((lm as any).pvp) (lm as any).commit((lm as any).sideOf(me), q.hash);
      else lm.commit(q.hash);
      return { ok: true };
    }
    if (action === "reveal") {
      need(lm, "match over");
      const r = { dvx: String(q.dvx), dvy: String(q.dvy), salt: String(q.salt) };
      if ((lm as any).pvp) await (lm as any).reveal((lm as any).sideOf(me), r);
      else await lm.reveal(r);
      return { ok: true };
    }
    if (action === "sign") {
      need(lm, "match over");
      if ((lm as any).pvp) (lm as any).sign((lm as any).sideOf(me), Number(q.tick), String(q.sig));
      else lm.humanSign(Number(q.tick), String(q.sig));
      return { ok: true };
    }
    if (action === "tx") {
      // testnet: the browser signed claim/confirm/dispute itself; this is only
      // a hint so the server can link the tx and re-read the match sooner
      need(TESTNET && /^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(q.hash ?? ""), "hash");
      chain.hint(id, String(q.kind), q.hash, q.gas ? String(q.gas) : undefined);
      await chain.refresh(id);
      return { ok: true };
    }
    need(!TESTNET, "on testnet, sign this transaction in the browser");
    if (action === "claim") {
      chain.claim(me, id, Number(q.winner));
      return { ok: true };
    }
    if (action === "confirm") {
      chain.confirm(me, id);
      return { ok: true };
    }
    if (action === "dispute") {
      const winner = chain.dispute(me, id, unhex(q.log || ""), Number(q.signedTick), unhex(q.sig));
      return { winner };
    }
    need(false, "unknown action");
  }

  if (p === "/api/sponsor" || p === "/api/cashout") {
    const me = q.me;
    player(me);
    const npc = npcById(q.npc);
    need(npc, "no such NPC");
    if (TESTNET && chain.isVault(npc.id)) {
      // the player called the vault directly (back / cash_out); check it and mirror
      need(typeof q.tx === "string" && !usedTx.has(q.tx), "tx missing or already used");
      const back = p === "/api/sponsor";
      const amount = back ? Math.round(Number(q.amount) * eco.MILLI) : undefined;
      const v = await chain.verifyVaultCall(q.tx, me, npc.id, back ? "back" : "cash_out", amount);
      usedTx.add(q.tx);
      await syncVault(npc);
      feed(back ? `${tag(me)} backed ${npc.name} with ${eco.fmt(amount!)}: ${v} shares from its vault` : `${tag(me)} cashed out ${q.shares} ${npc.name} shares; the vault paid`, nowW(), chain.explorer(q.tx));
      persist();
      return { minted: back ? Number(v) : undefined, balance: await chain.refreshBalance(me) };
    }
    if (p === "/api/sponsor") {
      const amount = Math.round(Number(q.amount) * eco.MILLI);
      if (TESTNET) {
        // the player sent a real transfer to the NPC's account; check it
        need(typeof q.tx === "string" && !usedTx.has(q.tx), "transfer tx missing or already used");
        await chain.verifyTransfer(q.tx, me, npc.id, amount);
        usedTx.add(q.tx);
      } else {
        need(amount >= 10 && chain.balance(me) >= amount, "not enough balance");
        chain.balances.set(me, chain.balance(me) - amount);
      }
      const r = eco.sponsor(npc, me, amount, nowW());
      r.events.forEach((t) => feed(t));
      return { minted: r.minted, balance: chain.balance(me) };
    }
    const r = eco.cashOut(npc, me, Number(q.shares), nowW());
    let tx;
    if (TESTNET) tx = await chain.pay(npc.id, me, r.amount);
    else chain.credit(me, r.amount);
    r.events.forEach((t) => feed(t));
    return { amount: r.amount, balance: chain.balance(me), tx };
  }

  if (p === "/api/fastforward") {
    need(!TESTNET, "fast-forward runs in the local build only: on testnet the ladder plays real matches on-chain");
    const days = Math.min(14, Math.max(1, Number(q.days ?? 7)));
    need(live.size === 0, "wait until live matches finish");
    const perDay = 24; // one ladder match per simulated hour
    const rng = makeRng(Date.now() & 0xffffffff);
    const t0 = Date.now();
    const start = nowW();
    const before = world.roster.map((n) => ({ id: n.id, bankroll: n.bankroll, status: eco.isOpen(n) }));
    let played = 0;
    for (let k = 0; k < days * perDay; k++) {
      const now = start + Math.round((k / perDay) * 86_400_000);
      ladderOnce(rng, now, true);
      played++;
    }
    world.simDays += days;
    world.clockOffsetMs = (world.clockOffsetMs ?? 0) + days * 86_400_000;
    const closed = world.roster.filter((n, i) => before[i].status && !eco.isOpen(n)).map((n) => n.name);
    feed(`Fast-forward: ${days} simulated days, ${played} ladder matches in ${((Date.now() - t0) / 1000).toFixed(1)} s` + (closed.length ? `. Went broke: ${closed.join(", ")}` : ""));
    persist();
    return { days, played, seconds: (Date.now() - t0) / 1000, roster: rosterView() };
  }

  need(false, "not found");
}

function chainInfo() {
  return TESTNET ? { kind: "testnet", contract: CONTRACT, house: HOUSE, faucet: houseState(), explorer: "https://testnet.nearblocks.io", windowSecs: WINDOW_SECS, ladderMin: Math.round(LADDER_MS / 60_000) } : { kind: "local", windowSecs: WINDOW_SECS };
}

/** Browser -> NEAR RPC relay (read + broadcast only; it cannot alter a signed tx). */
async function rpcProxy(req: any, res: any) {
  const q = await body(req);
  need(["query", "send_tx", "tx", "block"].includes(q.method), "rpc method not allowed");
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q) });
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(await r.text());
}

// The web client may also be served from Vercel (static only); it then calls
// this server's /api cross-origin. No cookies are used, so this only decides
// which pages may talk to the API from a browser.
const CORS = new RegExp(process.env.CORS_ORIGIN ?? "^https://noref(-[a-z0-9-]+)?\\.vercel\\.app$");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const origin = String(req.headers.origin ?? "");
  if (origin && CORS.test(origin) && url.pathname.startsWith("/api/")) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" });
      res.end();
      return;
    }
  }
  try {
    if (url.pathname === "/api/events") {
      const me = url.searchParams.get("me") ?? "anon";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hi\n\n");
      if (!clients.has(me)) clients.set(me, new Set());
      clients.get(me)!.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        clients.get(me)?.delete(res);
      });
      return;
    }
    if (url.pathname === "/api/rpc" && TESTNET) return await rpcProxy(req, res);
    if (url.pathname.startsWith("/api/")) {
      const out = await api(req, url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
      return;
    }
    // static: /shared/* from app/shared, everything else from app/web
    let rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const base = rel.startsWith("/shared/") ? ROOT : join(ROOT, "web");
    const file = normalize(join(base, rel));
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    // revalidate every time, so a redeploy reaches open browsers on reload
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(readFileSync(file));
  } catch (e: any) {
    res.writeHead(e.status ?? 400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message ?? e) }));
  }
});

server.listen(PORT, HOST ?? "::", () => console.log(`NoRef local: http://localhost:${PORT}  (chain: ${TESTNET ? CONTRACT + " on NEAR testnet" : "local mirror of contracts/noref"}, window ${WINDOW_SECS}s)`));
