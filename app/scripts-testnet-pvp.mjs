// Two people on NEAR testnet, through a running server: the host creates an
// invite (signing `create` itself), the guest joins by id (signing `join`
// itself), both play with the same MatchClient the browser uses. With --lie
// the loser claims a win and the winner's client disputes it. Both test
// accounts are deleted at the end and their balance returned to the house.
//
//   node scripts-testnet-pvp.mjs --url=https://noref.63-183-239-145.sslip.io:80 [--lie]
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { Engine, SIDE } from "./shared/engine.js";
import { MatchClient, newSessionKey } from "./shared/client.js";
import { PlayerChain, accountKey } from "./shared/player-chain.js";
import { action } from "./shared/near.js";
import { chooseFlick, makeRng } from "./shared/npc.js";

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith("--url="))?.slice(6).replace(/\/$/, "");
const lie = args.includes("--lie");
if (!BASE) throw new Error("usage: node scripts-testnet-pvp.mjs --url=https://host [--lie]");
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

const seats = [];
try {
  for (const role of ["host", "guest"]) {
    const keyPath = new URL(`../.keys/pvp-${role}-${Date.now()}.secret`, import.meta.url);
    const acct = await accountKey({ get: () => null, set: (_, v) => writeFileSync(keyPath, v, { mode: 0o600 }) });
    const session = await newSessionKey();
    const name = role.slice(0, 1) + Date.now().toString(36).slice(-6);
    const login = await api("/api/login", { name, key: session.pubHex, account: acct.publicKey });
    const seat = { role, me: login.me, acct, keyPath, session, login, pending: [], client: null, start: null, events: [] };
    seat.pc = new PlayerChain({ rpc: BASE + "/api/rpc", contract: login.chain.contract, accountId: seat.me, key: acct, api, log: (k, t, r) => log(`${role}: ${t} ${r.hash}`) });
    await listen(seat.me, (k, d) => {
      if (k === "pvp_start") seat.start = d;
      if (k === "chain" && seat.role === "host") log(`[chain] ${d.text}${d.url ? "  " + d.url : ""}`);
      if (k === "chain") seat.events.push(d);
      seat.client ? seat.client.handle(k, d) : seat.pending.push([k, d]);
    });
    seats.push(seat);
    log(`${role} ${seat.me} created, ${login.balance / 1000} NEAR`);
  }
  const [host, guest] = seats;
  let inv = await api("/api/pvp/create", { me: host.me, amount: 0.1 });
  const o = await host.pc.open(inv.open);
  log(`host signed create: #${o.id} ${o.hash}`);
  inv = await api("/api/pvp/opened", { me: host.me, id: o.id, tx: o.hash });
  const j = await api("/api/pvp/join", { me: guest.me, id: inv.id });
  const t = await guest.pc.call(j.call.method, j.call.args, 30n, j.call.deposit);
  log(`guest signed join: ${t.hash}`);
  const joined = await api("/api/pvp/joined", { me: guest.me, id: inv.id, tx: t.hash });
  while (!host.start) await new Promise((r) => setTimeout(r, 100));
  const engine = await Engine.load(readFileSync(new URL("./web/engine.wasm", import.meta.url)));
  const engine2 = await Engine.load(readFileSync(new URL("./web/engine.wasm", import.meta.url)));
  const rngs = [makeRng(21), makeRng(22)];
  for (const [i, seat] of seats.entries()) {
    seat.client = new MatchClient({
      engine: i === 0 ? engine : engine2,
      api,
      me: seat.me,
      key: seat.session,
      info: i === 0 ? host.start.info : joined.match,
      chain: seat.pc.opsFor(inv.id),
      claimer: i === 0,
      claimDelayMs: 6000,
      log: (kind, text) => ["final", "you", "problem"].includes(kind) && log(`[${seat.role} ${kind}] ${text}`),
      aim: async (eng) => {
        const f = chooseFlick(eng, { ball: i, style: "sniper", skill: i === 0 ? 1 : 0.3, rng: rngs[i], fast: true });
        return f.pass ? null : { angle: f.angle, power: f.power };
      },
    });
    seat.pending.forEach(([k, d]) => seat.client.handle(k, d));
  }
  if (lie) {
    const iv = setInterval(async () => {
      const loser = seats.find((s) => s.client.verdict != null && s.client.verdict !== s.client.mySide && s.client.verdict !== SIDE.DRAW);
      if (seats.every((s) => s.client.verdict != null) && !loser) clearInterval(iv);
      if (loser) {
        clearInterval(iv);
        log(`${loser.role} lost and claims a win anyway`);
        await loser.client.falseClaim().catch((e) => log("false claim failed: " + e.message));
      }
    }, 200);
  }
  const deadline = Date.now() + 180_000;
  while (!seats.every((s) => s.client.settled) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  const settle = host.events.find((e) => e.kind === "settle");
  log(`settled: winner side ${settle?.data?.winner}, both replays said ${host.client.verdict}/${guest.client.verdict}; problems ${host.client.problems.length + guest.client.problems.length}`);
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
} finally {
  for (const s of seats) {
    try {
      const r = await s.pc.near.send(s.me, s.acct, s.me, [action.deleteAccount(s.login.chain.contract)]);
      log(`deleted ${s.me}: ${r.hash}`);
      rmSync(s.keyPath);
    } catch (e) {
      console.error(`cleanup ${s.me}:`, e.message);
    }
  }
  process.exit();
}
