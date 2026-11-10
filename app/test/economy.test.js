import { test } from "node:test";
import assert from "node:assert/strict";
import * as eco from "../shared/economy.js";

const npc = () => eco.startingRoster().find((n) => n.id === "moss");

test("price rises with rating and demand, capped by bankroll", () => {
  const n = npc();
  n.bankroll = 100_000;
  const base = eco.askStake(n, 0).stake;
  n.rating = 1400;
  const rated = eco.askStake(n, 0).stake;
  assert.ok(rated > base);
  for (let i = 0; i < 3; i++) eco.noteChallenge(n, 1000 + i);
  const demanded = eco.askStake(n, 2000);
  assert.ok(demanded.stake > rated);
  assert.ok(demanded.why.some((l) => l.includes("demand")));
  n.bankroll = 3000;
  assert.equal(eco.askStake(n, 2000).stake, 3000 / eco.RISK_SHARE);
});

test("losing streak bankrupts, sponsors reopen", () => {
  const n = npc();
  let events = [];
  while (eco.isOpen(n)) events = eco.recordResult(n, { delta: -eco.askStake(n, 0).stake, score: 0, oppRating: 1200, now: 0 });
  assert.equal(n.status, "retired");
  assert.ok(events.some((e) => e.includes("closed its doors")));
  const r = eco.sponsor(n, "alice", eco.REOPEN_AT);
  assert.equal(n.status, "open");
  assert.ok(r.events.some((e) => e.includes("reopened")));
});

test("shares track the bankroll", () => {
  const n = npc();
  const { minted } = eco.sponsor(n, "bob", 1000);
  eco.recordResult(n, { delta: 3000, score: 1, oppRating: 1200, now: 0 });
  const { amount } = eco.cashOut(n, "bob", minted);
  assert.ok(amount > 1000, "a winning NPC pays its sponsors back more");
});
