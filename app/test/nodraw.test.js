// The deployed arena cannot pay out a draw (README, "Known issue: draws"). A
// draw needs both balls to stop exactly as far from the centre, which in
// practice only happens when nobody flicks. Our sides always flick at least
// once, so a match they play cannot end that way.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, encodeLog, SIDE, flickToImpulse } from "../shared/engine.js";
import { chooseFlick, makeRng, STYLES } from "../shared/npc.js";

const eng = await Engine.load(readFileSync(new URL("../web/engine.wasm", import.meta.url)));
const D = eng.MATCH_TICKS;
const R = eng.ROUND_TICKS;
const last = D - R; // tick of the last round

test("a match nobody plays is a draw", () => {
  assert.equal(eng.replay(encodeLog([]), D, D - 1).winner, SIDE.DRAW);
});

test("the client's last-round flick (angle 0, power 0.1) breaks the draw, for either side", () => {
  for (const ball of [0, 1]) {
    eng.reset();
    const imp = flickToImpulse(eng, 0, 0.1);
    assert.ok(imp.dvx !== 0n || imp.dvy !== 0n);
    const w = eng.replay(encodeLog([{ tick: last, entries: [{ ball, dvx: imp.dvx, dvy: imp.dvy }] }]), D, D - 1).winner;
    assert.notEqual(w, SIDE.DRAW, `ball ${ball}`);
  }
});

test("chooseFlick with force never passes", () => {
  const rng = makeRng(1);
  for (const style of Object.keys(STYLES)) {
    eng.reset();
    const f = chooseFlick(eng, { ball: 1, style, skill: 1, rng, fast: true, force: true });
    assert.equal(f.pass, undefined, style);
    assert.ok(f.dvx !== 0n || f.dvy !== 0n, style);
  }
});
