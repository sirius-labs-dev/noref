// NoRef economy rules: all of them, in one readable file.
//
// NPC fighters are businesses. Each has its own bankroll (a NEAR account on
// testnet, a ledger entry in the local demo), sets its own price, and lives
// or dies by its results:
//
// - PRICE: an NPC asks a stake per match that rises with its rating and with
//   recent demand, and never risks more than a tenth of its bankroll.
// - UPKEEP: every match costs the NPC a small training fee, so an NPC that
//   keeps losing slowly goes broke. (On testnet the real gas is the upkeep.)
// - SPONSORS: anyone can back an NPC by buying shares of its bankroll. Wins
//   raise the share value, losses lower it; sponsors can cash out any time.
// - BANKRUPTCY: when a tenth of the bankroll no longer covers the minimum
//   stake, the NPC closes its doors. It reopens only when
//   sponsors bring its bankroll back up.
// - DIVIDENDS: an NPC whose bankroll grows past a ceiling pays the excess out
//   to its backers, pro rata to their shares. Money keeps circulating instead
//   of piling up in the best fighter.
//
// Amounts are integer milliNEAR (1 NEAR = 1000) to keep the math exact.

export const MILLI = 1000;
export const MIN_STAKE = 50; // 0.05 NEAR
export const BASE_STAKE = 500; // 0.5 NEAR at rating 1200
export const UPKEEP = 5; // 0.005 NEAR per match
export const RISK_SHARE = 10; // stake at most 1/10 of bankroll
export const BROKE_BELOW = RISK_SHARE * MIN_STAKE; // can't stake the minimum within that
export const REOPEN_AT = BROKE_BELOW + 4 * MIN_STAKE; // bankroll needed to reopen
export const ELO_K = 32;
export const DEMAND_WINDOW_MS = 60 * 60 * 1000; // challenges in the last hour count as demand
export const DEMAND_STEP = 0.1; // +10% price per recent challenge
export const DEMAND_CAP = 5; // at most +50%

export const fmt = (m) => (m / MILLI).toFixed(3).replace(/\.?0+$/, "") + " NEAR";

/** The stake an NPC asks right now, and why. */
export function askStake(npc, now = Date.now()) {
  const why = [];
  const ratingFactor = (npc.rating / 1200) ** 2;
  let stake = BASE_STAKE * ratingFactor;
  why.push(`base ${fmt(BASE_STAKE)} x (rating ${Math.round(npc.rating)}/1200)^2 = ${fmt(Math.round(stake))}`);
  const recent = (npc.challenges ?? []).filter((t) => now - t < DEMAND_WINDOW_MS).length;
  const demand = 1 + DEMAND_STEP * Math.min(DEMAND_CAP, recent);
  if (recent > 0) {
    stake *= demand;
    why.push(`${recent} challenge(s) in the last hour: x${demand.toFixed(1)} demand`);
  }
  const cap = Math.floor(npc.bankroll / RISK_SHARE);
  if (stake > cap) {
    stake = cap;
    why.push(`capped at 1/${RISK_SHARE} of its bankroll (${fmt(npc.bankroll)})`);
  }
  stake = Math.max(MIN_STAKE, Math.round(stake / 10) * 10);
  if (npc.bankroll < BROKE_BELOW) why.push(`closed: bankroll below ${fmt(BROKE_BELOW)}`);
  return { stake, why };
}

export function isOpen(npc) {
  return npc.status === "open" && npc.bankroll >= BROKE_BELOW;
}

export function sharePrice(npc) {
  return npc.shares > 0 ? npc.bankroll / npc.shares : 1;
}

/** Back an NPC with `amount` milliNEAR; mints shares at the current price. */
export function sponsor(npc, who, amount, now = Date.now()) {
  if (!(amount > 0)) throw new Error("amount must be positive");
  const minted = Math.floor((amount / sharePrice(npc)) * 1000) / 1000;
  npc.bankroll += amount;
  npc.shares += minted;
  npc.holders[who] = (npc.holders[who] ?? 0) + minted;
  npc.history.push({ t: now, bankroll: npc.bankroll, rating: Math.round(npc.rating) });
  const events = [`${who} backed ${npc.name} with ${fmt(amount)} (${minted.toFixed(3)} shares)`];
  if (npc.status === "retired" && npc.bankroll >= REOPEN_AT) {
    npc.status = "open";
    delete npc.closedAt;
    events.push(`${npc.name} reopened: sponsors brought the bankroll to ${fmt(npc.bankroll)}`);
  }
  return { minted, events };
}

/** Cash out shares at the current price. */
export function cashOut(npc, who, shares, now = Date.now()) {
  const held = npc.holders[who] ?? 0;
  if (shares > held + 1e-9) throw new Error("not enough shares");
  const amount = Math.floor(shares * sharePrice(npc));
  npc.holders[who] = held - shares;
  if (npc.holders[who] < 1e-9) delete npc.holders[who];
  npc.shares -= shares;
  npc.bankroll -= amount;
  npc.history.push({ t: now, bankroll: npc.bankroll, rating: Math.round(npc.rating) });
  const events = [`${who} cashed out ${shares.toFixed(3)} ${npc.name} shares for ${fmt(amount)}`];
  events.push(...checkBankrupt(npc));
  return { amount, events };
}

function checkBankrupt(npc) {
  if (npc.status === "open" && npc.bankroll < BROKE_BELOW) {
    npc.status = "retired";
    npc.closedAt = Date.now();
    return [`${npc.name} went broke (${fmt(npc.bankroll)}) and closed its doors until someone invests`];
  }
  return [];
}

function expected(ra, rb) {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

/**
 * Apply a settled match to an NPC. `delta` is what the NPC won (+stake) or
 * lost (-stake); score is 1 win, 0.5 draw, 0 loss vs an opponent rating.
 */
export function recordResult(npc, { delta, score, oppRating, now = Date.now(), upkeep = UPKEEP }) {
  npc.bankroll += delta - upkeep;
  npc.upkeepPaid = (npc.upkeepPaid ?? 0) + upkeep;
  npc.rating += ELO_K * (score - expected(npc.rating, oppRating));
  if (score === 1) npc.wins++;
  else if (score === 0) npc.losses++;
  else npc.draws = (npc.draws ?? 0) + 1;
  npc.history.push({ t: now, bankroll: npc.bankroll, rating: Math.round(npc.rating) });
  if (npc.history.length > 2000) npc.history.splice(0, npc.history.length - 2000);
  return checkBankrupt(npc);
}

/** Open/close an NPC after its bankroll changed outside a match (e.g. synced from chain). */
export function updateStatus(npc, now = Date.now()) {
  if (npc.status === "open" && npc.bankroll < BROKE_BELOW) {
    npc.status = "retired";
    npc.closedAt = now;
    return [`${npc.name} went broke (${fmt(npc.bankroll)}) and closed its doors until someone invests`];
  }
  if (npc.status === "retired" && npc.bankroll >= REOPEN_AT) {
    npc.status = "open";
    delete npc.closedAt;
    return [`${npc.name} reopened with a bankroll of ${fmt(npc.bankroll)}`];
  }
  if (npc.status === "retired" && !npc.closedAt) npc.closedAt = now;
  return [];
}

/**
 * Split `amount` milliNEAR of dividends between an NPC's backers, pro rata to
 * their shares. Shares are not burned, so each share is simply worth less.
 */
export function dividendPlan(npc, amount) {
  const total = Object.values(npc.holders).reduce((a, b) => a + b, 0);
  if (!(total > 0) || !(amount > 0)) return [];
  return Object.entries(npc.holders)
    .map(([who, sh]) => ({ who, amount: Math.floor((amount * sh) / total) }))
    .filter((x) => x.amount >= 1);
}

export function noteChallenge(npc, now = Date.now()) {
  npc.challenges = (npc.challenges ?? []).filter((t) => now - t < DEMAND_WINDOW_MS);
  npc.challenges.push(now);
}

/** Opening roster. Bankrolls are house-owned shares at 1 milliNEAR each. */
export function startingRoster() {
  const mk = (id, name, style, skill, bankroll, rating) => ({
    id,
    name,
    style,
    skill,
    bankroll,
    rating,
    shares: bankroll,
    holders: { house: bankroll },
    status: "open",
    wins: 0,
    losses: 0,
    draws: 0,
    challenges: [],
    history: [{ t: Date.now(), bankroll, rating }],
  });
  return [
    mk("rook", "Rook", "sniper", 0.9, 8000, 1350),
    mk("brick", "Brick", "bully", 0.75, 6000, 1250),
    mk("moss", "Moss", "cautious", 0.7, 5000, 1200),
    mk("vex", "Vex", "bully", 0.55, 3000, 1150),
    mk("pip", "Pip", "sniper", 0.4, 2000, 1100),
    mk("dot", "Dot", "cautious", 0.3, 1200, 1050),
  ];
}
