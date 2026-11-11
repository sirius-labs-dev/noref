// Local stand-in for the NoRef NEAR contract (contracts/noref). Same state
// machine, same checks, same replay code (engine.wasm is the rules crate the
// contract links). Used for local play; the testnet adapter replaces it with
// real transactions. Amounts are integer milliNEAR.

import { createPublicKey, verify } from "node:crypto";
import { Engine, hex, unhex, SIDE } from "../shared/engine.js";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519Verify(pubHex: string, message: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(unhex(pubHex))]), format: "der", type: "spki" });
  return verify(null, message, key, sig);
}

export type Phase = "open" | "live" | "settled" | "cancelled";

export type Match = {
  id: number;
  a: string;
  b: string | null;
  stake: number;
  duration: number;
  keyA: string;
  keyB: string | null;
  phase: Phase;
  windowSecs: number;
  startedMs: number;
  claim: { by: string; winner: number } | null;
  replayed: { signedTick: number; winner: number; by: string; finalRoot: string } | null;
  windowEndMs: number;
  result: number | null;
};

export type ChainEvent = { t: number; match: number; kind: string; text: string; data?: unknown };

export class LocalChain {
  engine: Engine;
  balances = new Map<string, number>();
  matches: Match[] = [];
  events: ChainEvent[] = [];
  onEvent: (e: ChainEvent) => void = () => {};

  constructor(engine: Engine) {
    this.engine = engine;
  }

  private emit(match: number, kind: string, text: string, data?: unknown) {
    const e = { t: Date.now(), match, kind, text, data };
    this.events.push(e);
    if (this.events.length > 500) this.events.shift();
    this.onEvent(e);
  }

  balance(who: string) {
    return this.balances.get(who) ?? 0;
  }
  credit(who: string, amount: number) {
    this.balances.set(who, this.balance(who) + amount);
  }
  private debit(who: string, amount: number) {
    if (this.balance(who) < amount) throw new Error(`${who}: insufficient balance`);
    this.balances.set(who, this.balance(who) - amount);
  }
  private get(id: number) {
    const m = this.matches[id];
    if (!m) throw new Error("no such match");
    return m;
  }
  private isPlayer(m: Match, who: string) {
    return who === m.a || who === m.b;
  }

  create(who: string, stake: number, duration: number, keyA: string, windowSecs: number): number {
    if (!(stake > 0)) throw new Error("attach a stake");
    if (duration <= 0 || duration > this.engine.MAX_DURATION || duration % this.engine.ROUND_TICKS) throw new Error("bad duration");
    if (!/^[0-9a-f]{64}$/.test(keyA)) throw new Error("bad key");
    this.debit(who, stake);
    const id = this.matches.length;
    this.matches.push({ id, a: who, b: null, stake, duration, keyA, keyB: null, phase: "open", windowSecs, startedMs: 0, claim: null, replayed: null, windowEndMs: 0, result: null });
    this.emit(id, "create", `${who} opened match #${id} and locked ${stake / 1000} NEAR`);
    return id;
  }

  /** Creator withdraws an open match nobody joined (mirrors the contract's `cancel`). */
  cancel(who: string, id: number) {
    const m = this.get(id);
    if (m.phase !== "open") throw new Error("not open");
    if (who !== m.a) throw new Error("only creator");
    m.phase = "settled" as any;
    this.credit(who, m.stake);
    this.emit(id, "cancel", `${who} cancelled match #${id}; ${m.stake / 1000} NEAR returned`);
  }

  join(who: string, id: number, keyB: string) {
    const m = this.get(id);
    if (m.phase !== "open") throw new Error("not open");
    if (who === m.a) throw new Error("cannot play yourself");
    if (!/^[0-9a-f]{64}$/.test(keyB)) throw new Error("bad key");
    this.debit(who, m.stake);
    m.b = who;
    m.keyB = keyB;
    m.phase = "live";
    m.startedMs = Date.now();
    this.emit(id, "join", `${who} joined and locked ${m.stake / 1000} NEAR. Pot: ${(2 * m.stake) / 1000} NEAR`);
  }

  claim(who: string, id: number, winner: number) {
    const m = this.get(id);
    if (m.phase !== "live") throw new Error("not live");
    if (m.claim) throw new Error("already claimed");
    if (!this.isPlayer(m, who)) throw new Error("not a player");
    m.claim = { by: who, winner };
    m.windowEndMs = Date.now() + m.windowSecs * 1000;
    this.emit(id, "claim", `${who} claims: ${this.sideName(m, winner)}. Dispute window ${m.windowSecs}s`, { winner, by: who });
  }

  confirm(who: string, id: number) {
    const m = this.get(id);
    if (m.phase !== "live" || !m.claim) throw new Error("nothing to confirm");
    if (!this.isPlayer(m, who) || who === m.claim.by) throw new Error("only the other player");
    if (m.replayed && m.replayed.winner !== m.claim.winner) throw new Error("replay contradicts the claim");
    this.emit(id, "confirm", `${who} agrees`);
    this.settle(m, m.claim.winner);
  }

  /** Full-match replay of an opponent-signed log, exactly like the contract. */
  dispute(who: string, id: number, log: Uint8Array, signedTick: number, sig: Uint8Array): number {
    const m = this.get(id);
    if (m.phase !== "live") throw new Error("not live");
    if (!m.claim) throw new Error("nothing to dispute yet: claim first");
    if (Date.now() >= m.windowEndMs) throw new Error("window closed");
    if (!this.isPlayer(m, who)) throw new Error("not a player");
    if (m.replayed && signedTick <= m.replayed.signedTick) throw new Error("a longer signed log is already on record");
    const oppKey = who === m.a ? m.keyB! : m.keyA;
    const t0 = performance.now();
    const out = this.engine.replay(log, m.duration, signedTick); // throws on invalid log
    const ms = performance.now() - t0;
    const digest = this.engine.signDigest(id, signedTick, out.head);
    if (!ed25519Verify(oppKey, digest, sig)) {
      this.emit(id, "reject", `${who}'s dispute rejected: the opponent never signed this log`);
      throw new Error("opponent signature does not match this log");
    }
    m.replayed = { signedTick, winner: out.winner, by: who, finalRoot: hex(out.finalRoot) };
    m.windowEndMs = Date.now() + m.windowSecs * 1000;
    const verdict = this.sideName(m, out.winner);
    const overturned = out.winner !== m.claim.winner;
    this.emit(
      id,
      "replay",
      `${who} disputed. Chain replayed all ${m.duration} ticks (${ms.toFixed(1)} ms): ${verdict}.` + (overturned ? " The claim was false." : " The claim was right."),
      { winner: out.winner, overturned, finalRoot: hex(out.finalRoot), signedTick }
    );
    return out.winner;
  }

  finalize(id: number) {
    const m = this.get(id);
    if (m.phase !== "live" || !m.claim) throw new Error("nothing to finalize");
    if (Date.now() < m.windowEndMs) throw new Error("window still open");
    this.settle(m, m.replayed ? m.replayed.winner : m.claim.winner);
  }

  /** Called periodically: settle matches whose window has closed. */
  tick() {
    for (const m of this.matches) {
      if (m.phase === "live" && m.claim && Date.now() >= m.windowEndMs) this.finalize(m.id);
    }
  }

  sideName(m: Match, winner: number) {
    if (winner === SIDE.FIRST) return `${m.a} won`;
    if (winner === SIDE.SECOND) return `${m.b} won`;
    return "draw";
  }

  private settle(m: Match, winner: number) {
    m.phase = "settled";
    m.result = winner;
    if (winner === SIDE.FIRST) this.credit(m.a, 2 * m.stake);
    else if (winner === SIDE.SECOND) this.credit(m.b!, 2 * m.stake);
    else {
      this.credit(m.a, m.stake);
      this.credit(m.b!, m.stake);
    }
    this.emit(m.id, "settle", winner === SIDE.DRAW ? `Draw: both refunded` : `Paid ${(2 * m.stake) / 1000} NEAR to ${winner === SIDE.FIRST ? m.a : m.b}`, { winner });
  }
}
