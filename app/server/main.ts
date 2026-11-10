// NoRef local server: static web client, game protocol, NPC fighters,
// economy and a local chain that mirrors the NEAR contract.
//
//   node server/main.ts            (Node 23.6+; no npm install needed)
//   PORT=8787 DATA=./data node server/main.ts
//   CHAIN=testnet node server/main.ts   (real NoRef contract on NEAR testnet;
//                                        needs ../.keys/<CONTRACT>.json)
//
// API (JSON):
//   POST /api/login {name, key}                -> account, faucet balance
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
import { LiveMatch } from "./match.ts";

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
const CONTRACT = process.env.CONTRACT ?? "noref.testnet";
const RPC = process.env.RPC ?? "https://rpc.testnet.fastnear.com";
// the contract allows 10 s minimum; testnet blocks also need a moment
const WINDOW_SECS = Number(process.env.WINDOW_SECS ?? (TESTNET ? 15 : 8));
const FAUCET = TESTNET ? Number(process.env.PLAYER_FUND ?? 800) : 20 * eco.MILLI;
const LADDER_MS = Number(process.env.LADDER_MS ?? 25_000);

const engine = await Engine.load(readFileSync(join(ROOT, "web/engine.wasm")));
const chain: any = TESTNET ? new TestnetChain({ near: new Near(RPC), contract: CONTRACT, keysDir: new URL("../../.keys/", import.meta.url) }) : new LocalChain(engine);

// ---- persistent economy ----
type World = { roster: any[]; feed: { t: number; text: string }[]; players: Record<string, { key: string }>; balances: Record<string, number>; simDays: number; clockOffsetMs?: number };
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

function feed(text: string, t = nowW()) {
  world.feed.push({ t, text });
  if (world.feed.length > 300) world.feed.splice(0, world.feed.length - 300);
  broadcast("feed", { t, text });
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
const escrow = new Map<number, { npc: string; stake: number }>();
const pendingOpen = new Map<string, { npc: string; stake: number; liar: boolean; t: number }>();
const usedTx = new Set<string>();

chain.onEvent = (e) => {
  const m = chain.matches[e.match];
  if (m) {
    sendTo(m.a, "chain", e);
    if (m.b && !npcById(m.b)) sendTo(m.b, "chain", e);
  }
  if (e.kind === "settle") onSettled(e.match);
  persist();
};

function onSettled(id: number) {
  const m = chain.matches[id];
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
  const events = eco.recordResult(npc, { delta: payout - esc.stake, score, oppRating: 1200, now: nowW() });
  const human = m.a === npc.id ? m.b : m.a;
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
function simulateNpcMatch(a: any, b: any, rng: () => number, now: number) {
  const pa = eco.askStake(a, now).stake;
  const pb = eco.askStake(b, now).stake;
  const stake = Math.min(pa, pb);
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
  const ev = [
    ...eco.recordResult(a, { delta: sa === 1 ? stake : sa === 0 ? -stake : 0, score: sa, oppRating: rb, now }),
    ...eco.recordResult(b, { delta: sa === 0 ? stake : sa === 1 ? -stake : 0, score: 1 - sa, oppRating: ra, now }),
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
setInterval(() => {
  if (live.size === 0) ladderOnce(ladderRng, nowW());
  persist();
}, LADDER_MS);

// ---- views ----
/** Evenly thin a series to at most `max` points, always keeping the last. */
function sample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(xs[Math.floor((i * (xs.length - 1)) / (max - 1))]);
  out.push(xs[xs.length - 1]);
  return out;
}
function rosterView(now = nowW()) {
  return world.roster.map((n) => {
    const p = eco.askStake(n, now);
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
      sharePrice: eco.sharePrice(n),
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
      }
      const r = await chain.ensurePlayer(q.name, q.account, FAUCET);
      if (r.fresh) freshLog.push({ ip, t: Date.now() });
      world.players[r.id] = { key: q.key };
      persist();
      return { me: r.id, balance: chain.balance(r.id), fresh: r.fresh, tx: r.hash, chain: chainInfo() };
    }
    const me = `${q.name}.local`;
    const fresh = !world.players[me];
    world.players[me] = { key: q.key };
    if (fresh) chain.credit(me, FAUCET);
    persist();
    return { me, balance: chain.balance(me), fresh, chain: chainInfo() };
  }

  if (p === "/api/state") {
    return {
      roster: rosterView(),
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
    need(![...live.values()].some((m) => m.human === me), "finish your current match first");
    const { stake } = eco.askStake(npc, nowW());
    if (TESTNET) await chain.refreshBalance(me);
    need(chain.balance(me) >= stake + (TESTNET ? 20 : 0), `you need ${eco.fmt(stake)}`);
    eco.noteChallenge(npc, nowW());
    if (TESTNET) {
      // step 1 of 2: the browser signs `create` itself, then calls /api/opened
      await chain.ensureNpc(npc.id, stake);
      pendingOpen.set(me, { npc: npc.id, stake, liar: !!q.liar, t: Date.now() });
      return { open: { contract: CONTRACT, method: "create", args: { duration: engine.MATCH_TICKS, session_key: pl.key, window_secs: WINDOW_SECS, opponent: chain.acct(npc.id) }, deposit: String(BigInt(stake) * 10n ** 21n) }, stake };
    }
    // human opens (side A, ball 0), NPC joins (side B, ball 1)
    const id = chain.create(me, stake, engine.MATCH_TICKS, pl.key, WINDOW_SECS);
    return startLive(id, me, pl, npc, stake, !!q.liar);
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
    return startLive(id, me, pl, npc, o.stake, o.liar);
  }  async function startLive(id: number, me: string, pl: any, npc: any, stake: number, liar: boolean) {
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
    escrow.set(id, { npc: npc.id, stake });
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
      lm.commit(q.hash);
      return { ok: true };
    }
    if (action === "reveal") {
      need(lm, "match over");
      await lm.reveal({ dvx: String(q.dvx), dvy: String(q.dvy), salt: String(q.salt) });
      return { ok: true };
    }
    if (action === "sign") {
      need(lm, "match over");
      lm.humanSign(Number(q.tick), String(q.sig));
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
  return TESTNET ? { kind: "testnet", contract: CONTRACT, explorer: "https://testnet.nearblocks.io", windowSecs: WINDOW_SECS } : { kind: "local", windowSecs: WINDOW_SECS };
}

/** Browser -> NEAR RPC relay (read + broadcast only; it cannot alter a signed tx). */
async function rpcProxy(req: any, res: any) {
  const q = await body(req);
  need(["query", "send_tx", "tx", "block"].includes(q.method), "rpc method not allowed");
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q) });
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(await r.text());
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
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
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch (e: any) {
    res.writeHead(e.status ?? 400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message ?? e) }));
  }
});

server.listen(PORT, HOST ?? "::", () => console.log(`NoRef local: http://localhost:${PORT}  (chain: ${TESTNET ? CONTRACT + " on NEAR testnet" : "local mirror of contracts/noref"}, window ${WINDOW_SECS}s)`));
