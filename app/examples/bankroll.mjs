// Bankroll rules for an agent that bets: what its owner allows it to risk.
// Plain functions, no I/O, so they can be tested and read on their own.
//
// Amounts are milliNEAR. Which rule is enforced by whom:
// - budget: on testnet the bot trims its own account down to budget + RESERVE
//   before it plays, so NEAR itself stops it from losing more than that
//   (it holds no other key). Against a local server it is only checked here.
// - maxStake, stopLoss, matches: checked here, by the bot's own code.

export const RESERVE = 50; // kept for gas and account storage, never staked
const n = (m) => (m / 1000).toFixed(3) + " NEAR";

/**
 * How much to send back before playing so the account holds budget + RESERVE.
 * Returns 0 when there is nothing to trim (or no budget was set).
 */
export function trim(balance, budget) {
  if (budget == null) return 0;
  return Math.max(0, balance - budget - RESERVE);
}

/**
 * May the bot stake this much now? Returns { ok, why }.
 * start: balance when it began playing (after trimming).
 */
export function allowStake(stake, { balance, start, maxStake, stopLoss }) {
  const lost = start - balance;
  if (stopLoss != null && lost >= stopLoss) return { ok: false, why: `stop-loss: down ${n(lost)} of ${n(stopLoss)} allowed`, stop: true };
  if (maxStake != null && stake > maxStake) return { ok: false, why: `over max-stake ${n(maxStake)}` };
  if (stake > balance / 5) return { ok: false, why: "over a fifth of the balance" };
  if (balance - stake < RESERVE) return { ok: false, why: "would eat the gas reserve" };
  if (stopLoss != null && lost + stake > stopLoss) return { ok: false, why: `losing it would pass the stop-loss (${n(stopLoss - lost)} left)` };
  return { ok: true, why: "within limits" };
}

/**
 * At the end: what goes to the owner and what goes back to the house.
 * The owner gets only the profit; the stake money it started with came from
 * the house faucet and goes back there.
 */
export function payout(end, start) {
  return { toOwner: Math.max(0, end - start) };
}
