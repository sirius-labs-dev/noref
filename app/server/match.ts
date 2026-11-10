// A live match between a human (browser) and an NPC fighter.
//
// Per round: both commit a hash of their flick, then both reveal, the
// server checks the reveals against the commits, the joint record is
// appended to the log, and BOTH sides sign the input-chain head at the end
// of the round. The NPC follows exactly the same protocol as a human; the
// server never gets to see the human's flick before the NPC has committed.
//
// After the last round the NPC claims a result: the true one, or, if it is
// a liar, its own win. The human's client replays the log locally and
// either confirms or disputes on-chain with the NPC's signature.

import { generateKeyPairSync, sign as edSign, randomBytes } from "node:crypto";
import { Engine, encodeEntries, encodeLog, commitHash, hex, unhex, SIDE } from "../shared/engine.js";
import { chooseFlick, makeRng } from "../shared/npc.js";
import { ed25519Verify } from "./chain-local.ts";

export const COMMIT_MS = 20_000;
export const REVEAL_MS = 10_000;
export const ROUND_GAP_MS = 3_400; // client animates the round meanwhile

type Entry = { ball: number; dvx: bigint; dvy: bigint };
type Rec = { tick: number; entries: Entry[] };

export class NpcKey {
  pub: string;
  private priv: ReturnType<typeof generateKeyPairSync>["privateKey"];
  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    this.pub = hex(der.subarray(der.length - 32));
    this.priv = privateKey;
  }
  sign(msg: Uint8Array): Uint8Array {
    return new Uint8Array(edSign(null, msg, this.priv));
  }
}

export class LiveMatch {
  id: number;
  human: string;
  humanKey: string;
  npc: any;
  npcKey = new NpcKey();
  liar: boolean;
  engine: Engine;
  chain: any; // LocalChain or TestnetChain
  send: (kind: string, data: unknown) => void;
  onDone: (m: LiveMatch) => void;
  claimDelayMs = 2500;

  round = 0;
  rounds: number;
  phase: "commit" | "reveal" | "gap" | "claim" | "done" = "commit";
  table: Uint8Array;
  records: Rec[] = [];
  commits: (string | null)[] = [null, null];
  reveals: (Entry | null)[] = [null, null];
  npcSecret: { entry: Entry | null; salt: Uint8Array } | null = null;
  humanSig: { tick: number; sig: string } | null = null;
  npcSig: { tick: number; sig: string } | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;
  rng: () => number;

  constructor(o: { id: number; human: string; humanKey: string; npc: any; liar: boolean; engine: Engine; chain: any; send: (k: string, d: unknown) => void; onDone: (m: LiveMatch) => void; claimDelayMs?: number }) {
    Object.assign(this, o);
    this.engine = o.engine;
    this.rounds = this.engine.MATCH_TICKS / this.engine.ROUND_TICKS;
    this.engine.reset();
    this.table = this.engine.getState();
    this.rng = makeRng(o.id * 7919 + 17);
  }

  get R() {
    return this.engine.ROUND_TICKS;
  }
  get D() {
    return this.engine.MATCH_TICKS;
  }
  info() {
    return { id: this.id, human: this.human, npc: { id: this.npc.id, name: this.npc.name, style: this.npc.style }, npcKey: this.npcKey.pub, rounds: this.rounds, roundTicks: this.R, duration: this.D, liar: this.liar };
  }

  start() {
    this.startRound();
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async startRound() {
    this.phase = "commit";
    this.commits = [null, null];
    this.reveals = [null, null];
    // NPC thinks on the table as it stands, blind to the human's flick
    this.engine.setState(this.table);
    const f = chooseFlick(this.engine, { ball: 1, style: this.npc.style, skill: this.npc.skill, rng: this.rng });
    const entry = f.pass ? null : { ball: 1, dvx: f.dvx, dvy: f.dvy };
    const salt = new Uint8Array(randomBytes(16));
    this.npcSecret = { entry, salt };
    this.commits[1] = await commitHash(this.id, this.round, entry ?? { ball: 1, dvx: 0n, dvy: 0n }, salt);
    this.send("round", { round: this.round, deadline: Date.now() + COMMIT_MS });
    this.send("committed", { side: 1 });
    this.clear();
    this.timer = setTimeout(() => this.commit(null), COMMIT_MS);
  }

  /** Human commit (null = timed out, plays no flick this round). */
  commit(hash: string | null) {
    if (this.phase !== "commit") throw new Error("not accepting commits");
    this.commits[0] = hash ?? "pass";
    this.send("committed", { side: 0 });
    this.phase = "reveal";
    this.send("reveal", { round: this.round, deadline: Date.now() + REVEAL_MS });
    this.clear();
    this.timer = setTimeout(() => this.reveal(null), REVEAL_MS);
  }

  /** Human reveal. Must match the commit or the flick is void. */
  async reveal(r: { dvx: string; dvy: string; salt: string } | null) {
    if (this.phase !== "reveal") throw new Error("not accepting reveals");
    this.clear();
    let human: Entry | null = null;
    if (r && this.commits[0] !== "pass") {
      const e = { ball: 0, dvx: BigInt(r.dvx), dvy: BigInt(r.dvy) };
      const h = await commitHash(this.id, this.round, e, unhex(r.salt));
      if (h !== this.commits[0]) this.send("note", { text: "Your reveal did not match your commit: no flick this round." });
      else if (e.dvx !== 0n || e.dvy !== 0n) human = e;
    }
    const npc = this.npcSecret!.entry;
    const entries = [human, npc].filter(Boolean) as Entry[];
    const tick = this.round * this.R;
    if (entries.length) this.records.push({ tick, entries });
    // advance the authoritative table copy
    this.engine.setState(this.table);
    this.engine.tick(encodeEntries(entries), tick);
    for (let t = tick + 1; t < tick + this.R; t++) this.engine.tick(new Uint8Array(0), t);
    this.table = this.engine.getState();
    // NPC signs the joint log up to the end of this round
    const signedTick = tick + this.R - 1;
    const log = encodeLog(this.records);
    const head = this.engine.headAt(log, this.D, signedTick);
    const npcSig = hex(this.npcKey.sign(this.engine.signDigest(this.id, signedTick, head)));
    this.npcSig = { tick: signedTick, sig: npcSig };
    this.send("round_result", {
      round: this.round,
      tick,
      entries: entries.map((e) => ({ ball: e.ball, dvx: String(e.dvx), dvy: String(e.dvy) })),
      npcSalt: hex(this.npcSecret!.salt),
      npcCommit: this.commits[1],
      signedTick,
      head: hex(head),
      npcSig,
    });
    this.phase = "gap";
    this.round++;
    this.timer = setTimeout(() => (this.round < this.rounds ? this.startRound() : this.endMatch()), ROUND_GAP_MS);
  }

  /** Human countersignature for the head at `tick`; verified before it is kept. */
  humanSign(tick: number, sigHex: string) {
    const log = encodeLog(this.records.filter((r) => r.tick <= tick));
    const head = this.engine.headAt(log, this.D, tick);
    const ok = ed25519Verify(this.humanKey, this.engine.signDigest(this.id, tick, head), unhex(sigHex));
    if (!ok) throw new Error("signature does not match the log");
    if (!this.humanSig || tick > this.humanSig.tick) this.humanSig = { tick, sig: sigHex };
  }

  private endMatch() {
    this.phase = "claim";
    const log = encodeLog(this.records);
    const truth = this.engine.replay(log, this.D, this.D - 1).winner;
    this.send("final", { truth });
    // give the human a moment to claim first (the "you lie" demo)
    this.timer = setTimeout(() => this.npcClaims(truth), this.claimDelayMs);
  }

  /**
   * The NPC's move after the last round. On testnet the human's claim may be
   * a few seconds in flight, so re-read the match and retry once if our own
   * claim loses the race.
   */
  private async npcClaims(truth: number) {
    const me = this.npc.id;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.chain.refresh?.(this.id);
        const m = this.chain.matches[this.id];
        if (m.phase !== "live") break;
        if (m.claim) {
          // human claimed first: check it against the replay
          if (m.claim.winner === truth) await this.chain.confirm(me, this.id);
          else await this.npcDispute();
        } else {
          const npcWins = SIDE.SECOND;
          const claim = this.liar && truth !== npcWins ? npcWins : truth;
          await this.chain.claim(me, this.id, claim);
        }
        break;
      } catch (e: any) {
        console.error(`npc #${this.id}:`, e.message);
        await new Promise((ok) => setTimeout(ok, 2500));
      }
    }
    this.phase = "done";
    this.onDone(this);
  }

  /** NPC proves a false human claim wrong with the human's own signature. */
  async npcDispute() {
    if (!this.humanSig) {
      this.send("note", { text: "You never countersigned, so the NPC cannot prove anything: your claim stands unless the log says otherwise." });
      return;
    }
    const log = encodeLog(this.records.filter((r) => r.tick <= this.humanSig!.tick));
    await this.chain.dispute(this.npc.id, this.id, log, this.humanSig.tick, unhex(this.humanSig.sig));
  }

  /** Everything a client needs to dispute: full log + NPC's latest signature. */
  evidence() {
    return {
      log: Array.from(encodeLog(this.records.filter((r) => r.tick <= (this.npcSig?.tick ?? -1)))),
      signedTick: this.npcSig?.tick ?? null,
      npcSig: this.npcSig?.sig ?? null,
    };
  }
}
