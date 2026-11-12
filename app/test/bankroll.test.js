import { test } from "node:test";
import assert from "node:assert/strict";
import { trim, allowStake, payout, RESERVE } from "../examples/bankroll.mjs";

test("budget: trim leaves exactly budget + gas reserve in the account", () => {
  assert.equal(trim(800, 300), 800 - 300 - RESERVE);
  assert.equal(trim(800, null), 0); // no budget given: keep everything
  assert.equal(trim(200, 300), 0); // already under budget: nothing to send
});

test("stakes: max-stake, a fifth of the balance, the reserve and the stop-loss", () => {
  const base = { balance: 600, start: 600, maxStake: 100, stopLoss: 200 };
  assert.equal(allowStake(100, base).ok, true);
  assert.match(allowStake(110, base).why, /max-stake/);
  assert.match(allowStake(110, { ...base, maxStake: null, balance: 500 }).why, /fifth/);
  // down 150 of 200: a 60 bet could take it past the stop-loss
  assert.match(allowStake(60, { ...base, balance: 450 }).why, /pass the stop-loss/);
  assert.equal(allowStake(40, { ...base, balance: 450 }).ok, true);
  // down 200: stop, whatever the bet
  const s = allowStake(0, { ...base, balance: 400 });
  assert.equal(s.ok, false);
  assert.equal(s.stop, true);
});

test("payout: the owner gets only the profit", () => {
  assert.deepEqual(payout(450, 300), { toOwner: 150 });
  assert.deepEqual(payout(250, 300), { toOwner: 0 });
});
