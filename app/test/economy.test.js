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

test("dividends split pro rata between backers", () => {
  const n = eco.startingRoster().find((x) => x.id === "rook");
  eco.sponsor(n, "alice", 2000, 0); // house 8000 shares at 1.0, alice buys 2000
  const plan = eco.dividendPlan(n, 1000);
  const by = Object.fromEntries(plan.map((p) => [p.who, p.amount]));
  assert.equal(by.house, 800);
  assert.equal(by.alice, 200);
  assert.deepEqual(eco.dividendPlan(n, 0), []);
});

test("a chain-synced bankroll closes and reopens a fighter", () => {
  const n = eco.startingRoster().find((x) => x.id === "dot");
  n.bankroll = eco.BROKE_BELOW - 1;
  assert.match(eco.updateStatus(n, 5)[0], /went broke/);
  assert.equal(n.status, "retired");
  assert.equal(n.closedAt, 5);
  n.bankroll = eco.REOPEN_AT;
  assert.match(eco.updateStatus(n, 9)[0], /reopened/);
  assert.equal(n.status, "open");
  assert.equal(n.closedAt, undefined);
});

test("an NPC prices the opponent from its public record", () => {
  const n = npc();
  n.bankroll = 100_000;
  const fresh = { wins: 0, losses: 0, draws: 0, liesCaught: 0 };
  const strong = { wins: 16, losses: 0, draws: 0, liesCaught: 0 };
  const weak = { wins: 0, losses: 8, draws: 0, liesCaught: 0 };
  const q = (r) => eco.askStake(n, 0, { ...r, rating: eco.formRating(r) });
  assert.ok(q(weak).stake > q(fresh).stake, "bets more against a weaker record");
  assert.ok(q(strong).stake < q(fresh).stake, "bets less against a stronger one");
  assert.ok(q({ ...fresh, liesCaught: 1 }).stake > q(fresh).stake, "a caught liar pays a premium");
  assert.equal(q(fresh).declined, false);
  const champ = { wins: 40, losses: 0, draws: 0, liesCaught: 0 };
  assert.equal(q(champ).declined, true, "refuses a match it expects to lose");
});

test("tally reads wins, losses and overturned claims", () => {
  const f = (a, b, result, claimBy = null, claimWinner = null) => ({ a, b, settled: true, result, claimBy, claimWinner });
  const r = eco.tally("me", [f("me", "x", 1), f("x", "me", 1, "me", 2), f("me", "y", 0), { ...f("me", null, null), settled: false }]);
  assert.deepEqual(r, { wins: 1, losses: 1, draws: 1, liesCaught: 1 });
});
