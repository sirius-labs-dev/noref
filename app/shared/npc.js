// NPC fighter brains. Each NPC is a real player in the protocol: it commits,
// reveals and signs like a human. Its brain only chooses a flick.
//
// How a brain thinks: flicks are simultaneous and committed blind, so it
// first guesses the opponent's most dangerous flick, then searches a grid of
// angles x powers (refined around the best line) simulating the rest of the
// round with the real engine against that guess, scores the resting table by
// its style, and plays the best line with skill-dependent aim noise.

import { encodeEntries, flickToImpulse } from "./engine.js";

/** Styles: how a brain scores a simulated table. Lower is better. */
export const STYLES = {
  // park as close to the center as possible
  sniper: (me, opp) => me,
  // knock the opponent away even at some cost to own position
  bully: (me, opp) => me - 1.4 * opp,
  // keep a margin over the opponent, avoid wild shots
  cautious: (me, opp) => me - 0.6 * opp,
};

export const STYLE_INFO = {
  sniper: "Aims straight for the center.",
  bully: "Shoots to knock your ball off the center.",
  cautious: "Plays safe, keeps a lead.",
};

/**
 * Pick a flick. `engine` must hold the table at the start of the round.
 * Returns {angle, power, dvx, dvy}. Leaves the engine state unchanged.
 */
function search(engine, ball, score, { angles, powers, refine, against }) {
  const opp = 1 - ball;
  const sim = (angle, power) => {
    engine.restore();
    const { dvx, dvy } = flickToImpulse(engine, angle, power);
    const entries = [{ ball, dvx, dvy }];
    if (against) entries.push(against);
    entries.sort((x, y) => x.ball - y.ball);
    engine.tick(encodeEntries(entries), 0);
    engine.runTicks(engine.ROUND_TICKS - 1, 1);
    return score(engine.dist2(ball), engine.dist2(opp));
  };
  let best = { s: Infinity, angle: 0, power: 0 };
  for (let i = 0; i < angles; i++) {
    const angle = (360 * i) / angles;
    for (const power of powers) {
      const s = sim(angle, power);
      if (s < best.s) best = { s, angle, power };
    }
  }
  let da = 360 / angles / 2;
  let dp = 0.1;
  for (let it = 0; it < refine; it++) {
    for (const a of [-da, 0, da]) {
      for (const p of [-dp, 0, dp]) {
        if (!a && !p) continue;
        const power = Math.max(0.05, Math.min(1, best.power + p));
        const s = sim(best.angle + a, power);
        if (s < best.s) best = { s, angle: best.angle + a, power };
      }
    }
    da /= 2;
    dp /= 2;
  }
  // staying put is also a move
  engine.restore();
  if (against) {
    engine.tick(encodeEntries([against]), 0);
    engine.runTicks(engine.ROUND_TICKS - 1, 1);
  }
  const still = score(engine.dist2(ball), engine.dist2(opp));
  engine.restore();
  return still <= best.s ? { ...best, pass: true } : best;
}

/**
 * `force`: never pass. A match where neither ball ever moves is a draw, and the
 * deployed arena cannot pay out a draw (README, "Known issue: draws"); a side
 * that always flicks at least once means no match it plays can end that way.
 */
export function chooseFlick(engine, { ball, style, skill, rng, fast = false, force = false }) {
  const opp = 1 - ball;
  const score = STYLES[style] ?? STYLES.sniper;
  engine.save();
  // 1. guess the opponent's most dangerous flick (flicks are simultaneous, so
  //    the best we can do is anticipate, never react)
  const g = search(engine, opp, STYLES.bully, { angles: 16, powers: [0.3, 0.6, 1], refine: 0, against: null });
  const guess = g.pass ? null : { ball: opp, ...flickToImpulse(engine, g.angle, g.power) };
  // 2. our best flick assuming that guess
  const best = search(engine, ball, score, {
    angles: fast ? 24 : 48,
    powers: fast ? [0.2, 0.4, 0.6, 0.8, 1] : [0.1, 0.2, 0.3, 0.45, 0.6, 0.75, 0.9, 1],
    refine: fast ? 3 : 5,
    against: guess && { ball: guess.ball, dvx: guess.dvx, dvy: guess.dvy },
  });
  engine.restore();
  if (best.pass && !force) return { angle: 0, power: 0, dvx: 0n, dvy: 0n, pass: true };
  if (best.pass) return { angle: best.angle, power: 0.1, ...flickToImpulse(engine, best.angle, 0.1) };
  // skill 0..1: aim noise up to +-10 degrees and +-20% power at skill 0
  const angle = best.angle + (1 - skill) * 10 * (2 * rng() - 1);
  const power = Math.max(0.05, Math.min(1, best.power + (1 - skill) * 0.2 * (2 * rng() - 1)));
  return { angle, power, ...flickToImpulse(engine, angle, power) };
}

/** Small deterministic PRNG for brains and simulations (mulberry32). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
