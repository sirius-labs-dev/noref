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
