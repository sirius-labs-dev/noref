// Cross-check: the JS-loaded wasm engine must match native Rust bit for bit.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import { Engine, encodeLog, encodeEntries, hex, ONE } from "../shared/engine.js";

const native = execSync("cargo run -q -p noref-rules --example vector", { cwd: new URL("../..", import.meta.url) }).toString().trim().split(" ");
const eng = await Engine.load(readFileSync(new URL("../web/engine.wasm", import.meta.url)));
const r = (n, d = 1n) => (ONE * BigInt(n)) / d;
const recs = [
  { tick: 0, entries: [{ ball: 0, dvx: r(5), dvy: r(1, 3n) }, { ball: 1, dvx: r(-4), dvy: -(ONE / 7n) }] },
  { tick: 180, entries: [{ ball: 0, dvx: r(-2), dvy: r(3) }] },
  { tick: 360, entries: [{ ball: 1, dvx: r(-11), dvy: r(1) }] },
  { tick: 900, entries: [{ ball: 0, dvx: r(7), dvy: r(-5) }, { ball: 1, dvx: r(3), dvy: r(2) }] },
];
const log = encodeLog(recs);
const o = eng.replay(log, eng.MATCH_TICKS, eng.MATCH_TICKS - 1);
assert.equal(String(o.winner), native[0], "winner");
assert.equal(hex(o.head), native[1], "head");
assert.equal(hex(o.finalRoot), native[2], "final root");
assert.equal(hex(eng.signDigest(7, eng.MATCH_TICKS - 1, o.head)), native[3], "sign digest");

// tick-by-tick in JS reaches the same verdict as the one-shot replay
eng.reset();
for (let t = 0; t < eng.MATCH_TICKS; t++) {
  const rec = recs.find((x) => x.tick === t);
  eng.tick(rec ? encodeEntries(rec.entries) : new Uint8Array(0), t);
}
assert.equal(eng.verdict(), o.winner);
console.log("ok: js engine == native rust (winner", o.winner + ", root", hex(o.finalRoot).slice(0, 16) + "…)");
