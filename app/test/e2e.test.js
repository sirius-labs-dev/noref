// End-to-end: real server process, real protocol, headless client using the
// same MatchClient the browser uses. Covers an honest NPC, a lying NPC
// (overturned by on-chain replay) and a lying human (overturned by the NPC).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, SIDE } from "../shared/engine.js";
import { MatchClient, newSessionKey } from "../shared/client.js";
import { chooseFlick, makeRng } from "../shared/npc.js";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let srv;

before(async () => {
  const DATA = mkdtempSync(join(tmpdir(), "noref-"));
  srv = spawn(process.execPath, ["server/main.ts"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, PORT: String(PORT), DATA, WINDOW_SECS: "3", LADDER_MS: "999999999" }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok) => srv.stdout.on("data", (b) => String(b).includes("NoRef local") && ok()));
});
after(() => srv.kill());

async function api(path, body) {
  const r = await fetch(BASE + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error}`);
  return j;
}

/** minimal SSE reader */
async function listen(me, onEvent, signal) {
  const r = await fetch(`${BASE}/api/events?me=${me}`, { signal });
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
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
    } catch {}
  })();
}

async function play({ name, npc, liar, humanLies }) {
  const engine = await Engine.load(readFileSync(new URL("../web/engine.wasm", import.meta.url)));
  const key = await newSessionKey();
  const { me } = await api("/api/login", { name, key: key.pubHex });
  const ac = new AbortController();
  const lines = [];
  let client;
  const pending = [];
  await listen(me, (k, d) => (client ? client.handle(k, d) : pending.push([k, d])), ac.signal);
  const { match } = await api("/api/challenge", { me, npc, liar });
  const rng = makeRng(5);
  client = new MatchClient({
    engine,
    api,
    me,
    key,
    info: match,
    autoSettle: !humanLies,
    log: (kind, text) => lines.push(`[${kind}] ${text}`),
    // the test player uses a strong brain to pick its flicks
    aim: async (eng) => {
      const f = chooseFlick(eng, { ball: 0, style: "sniper", skill: 1, rng });
      return f.pass ? null : { angle: f.angle, power: f.power };
    },
  });
  pending.forEach(([k, d]) => client.handle(k, d));
  if (humanLies) {
    // claim a win as soon as the last round is in, before the NPC claims
    const t = setInterval(async () => {
      if (client.verdict != null) {
        clearInterval(t);
        await client.falseClaim().catch((e) => lines.push("claim failed " + e.message));
      }
    }, 100);
  }
  const deadline = Date.now() + 90_000;
  while (!client.settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  await client.queue;
  ac.abort();
  const m = (await api("/api/state?me=" + me)).chainEvents.filter((e) => e.match === match.id);
  return { client, lines, events: m, me };
}

test("honest NPC: claim matches replay, client confirms", { timeout: 120_000 }, async () => {
  const { client, events, lines } = await play({ name: "honest", npc: "rook", liar: false });
  assert.equal(client.problems.length, 0, client.problems.join("; "));
  const settle = events.find((e) => e.kind === "settle");
  assert.ok(settle, lines.join("\n"));
  assert.equal(settle.data.winner, client.verdict);
  assert.ok(!events.some((e) => e.kind === "replay"));
});

test("lying NPC: replay overturns a false claim", { timeout: 120_000 }, async () => {
  const { client, events, lines } = await play({ name: "victim", npc: "dot", liar: true });
  assert.equal(client.problems.length, 0, client.problems.join("; "));
  const settle = events.find((e) => e.kind === "settle");
  assert.ok(settle, lines.join("\n"));
  assert.equal(settle.data.winner, client.verdict, "money follows the replay, not the claim");
  if (client.verdict !== SIDE.SECOND) {
    const rep = events.find((e) => e.kind === "replay");
    assert.ok(rep && rep.data.overturned, "the false claim must be overturned:\n" + lines.join("\n"));
  }
  console.log(lines.slice(-5).join("\n"));
});

test("lying human: NPC disputes with the human's own signature", { timeout: 120_000 }, async () => {
  const { client, events, lines } = await play({ name: "cheater", npc: "rook", humanLies: true });
  const settle = events.find((e) => e.kind === "settle");
  assert.ok(settle, lines.join("\n"));
  assert.equal(settle.data.winner, client.verdict);
  if (client.verdict !== SIDE.FIRST) assert.ok(events.find((e) => e.kind === "replay")?.data.overturned);
});

/** Two people by invite link. The loser claims a win it did not earn. */
async function playPvp({ loserLies }) {
  const engine = [await Engine.load(readFileSync(new URL("../web/engine.wasm", import.meta.url))), await Engine.load(readFileSync(new URL("../web/engine.wasm", import.meta.url)))];
  const seats = [];
  for (const [i, name] of ["host" + Date.now().toString(36).slice(-4), "guest" + Date.now().toString(36).slice(-4)].entries()) {
    const key = await newSessionKey();
    const { me } = await api("/api/login", { name, key: key.pubHex });
    const ac = new AbortController();
    const seat = { key, me, ac, pending: [], lines: [], client: null };
    await listen(me, (k, d) => {
      if (k === "pvp_start") seat.start = d;
      seat.client ? seat.client.handle(k, d) : seat.pending.push([k, d]);
    }, ac.signal);
    seats.push(seat);
  }
  const [host, guest] = seats;
  const inv = await api("/api/pvp/create", { me: host.me, amount: 0.5 });
  const look = await api(`/api/pvp/invite?id=${inv.id}`);
  assert.equal(look.open, true);
  const joined = await api("/api/pvp/join", { me: guest.me, id: inv.id });
  while (!host.start) await new Promise((r) => setTimeout(r, 50));
  const rngs = [makeRng(11), makeRng(12)];
  for (const [i, seat] of seats.entries()) {
    const info = i === 0 ? host.start.info : joined.match;
    seat.client = new MatchClient({
      engine: engine[i],
      api,
      me: seat.me,
      key: seat.key,
      info,
      claimer: i === 0,
      claimDelayMs: 1500,
      log: (kind, text) => seat.lines.push(`[${kind}] ${text}`),
      aim: async (eng) => {
        const f = chooseFlick(eng, { ball: i, style: "sniper", skill: i === 0 ? 1 : 0.2, rng: rngs[i] });
        return f.pass ? null : { angle: f.angle, power: f.power };
      },
    });
    seat.pending.forEach(([k, d]) => seat.client.handle(k, d));
  }
  if (loserLies) {
    // whoever lost claims the win right away, before the creator's honest claim
    const t = setInterval(async () => {
      const loser = seats.find((s) => s.client.verdict != null && s.client.verdict !== s.client.mySide && s.client.verdict !== SIDE.DRAW);
      if (seats.every((s) => s.client.verdict != null)) clearInterval(t);
      if (loser) {
        clearInterval(t);
        await loser.client.falseClaim().catch((e) => loser.lines.push("claim failed " + e.message));
      }
    }, 50);
  }
  const deadline = Date.now() + 90_000;
  while (!seats.every((s) => s.client.settled) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  await Promise.all(seats.map((s) => s.client.queue));
  seats.forEach((s) => s.ac.abort());
  const events = (await api("/api/state?me=" + host.me)).chainEvents.filter((e) => e.match === inv.id);
  return { seats, events };
}

test("two people: both replays agree, the creator's claim is confirmed", { timeout: 120_000 }, async () => {
  const { seats, events } = await playPvp({ loserLies: false });
  for (const s of seats) assert.deepEqual(s.client.problems, [], s.lines.join("\n"));
  assert.equal(seats[0].client.verdict, seats[1].client.verdict);
  const settle = events.find((e) => e.kind === "settle");
  assert.equal(settle.data.winner, seats[0].client.verdict);
  assert.ok(!events.some((e) => e.kind === "replay"), "no dispute needed");
});

test("two people: the loser's false claim is overturned by the winner's dispute", { timeout: 120_000 }, async () => {
  const { seats, events } = await playPvp({ loserLies: true });
  const truth = seats[0].client.verdict;
  if (truth === SIDE.DRAW) return; // nobody to lie
  for (const s of seats) assert.deepEqual(s.client.problems, [], s.lines.join("\n"));
  const claim = events.find((e) => e.kind === "claim");
  assert.notEqual(claim.data.winner, truth, "the loser claimed first");
  const replay = events.find((e) => e.kind === "replay");
  assert.ok(replay, "the winner disputed");
  assert.equal(events.find((e) => e.kind === "settle").data.winner, truth);
});
