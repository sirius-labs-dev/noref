// The player's side of a NoRef match. Runs in the browser (and in the
// end-to-end test). It trusts nobody:
//
// - keeps its own copy of the table and of the input log,
// - checks the opponent's reveal against its commit every round,
// - checks the opponent's signature over the input-chain head every round
//   (an NPC's comes with the round; a person's arrives once they have signed),
// - countersigns the head itself with its own session key,
// - replays the whole match locally at the end, then confirms a true
//   claim or disputes a false one with the NPC's own signature.

import { encodeEntries, encodeLog, commitHash, flickToImpulse, hex, unhex, SIDE } from "./engine.js";

const subtle = globalThis.crypto.subtle;

export async function newSessionKey() {
  const kp = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  return { kp, pubHex: hex(pub) };
}

export async function exportSessionKey(k) {
  return { pubHex: k.pubHex, priv: await subtle.exportKey("jwk", k.kp.privateKey), pub: await subtle.exportKey("jwk", k.kp.publicKey) };
}

export async function importSessionKey(j) {
  const privateKey = await subtle.importKey("jwk", j.priv, { name: "Ed25519" }, true, ["sign"]);
  const publicKey = await subtle.importKey("jwk", j.pub, { name: "Ed25519" }, true, ["verify"]);
  return { kp: { privateKey, publicKey }, pubHex: j.pubHex };
}

async function verifyEd(pubHex, msg, sigHex) {
  const key = await subtle.importKey("raw", unhex(pubHex), { name: "Ed25519" }, false, ["verify"]);
  return subtle.verify({ name: "Ed25519" }, key, unhex(sigHex), msg);
}

export class MatchClient {
  /**
   * engine: Engine; api(path, body) -> json; me: account id; key: session key;
   * aim(engine, ctx) -> Promise<{angle, power} | null> picks this round's flick
   * (engine holds the round-start table); log(kind, text, data) for the UI.
   */
  constructor({ engine, api, me, key, info, aim, log, autoSettle = true, chain, claimer = false, claimDelayMs = 4000 }) {
    Object.assign(this, { engine, api, me, key, info, aim, log: log ?? (() => {}), autoSettle, claimer, claimDelayMs });
    // which seat we are in: 0 created the match (ball 0, contract side FIRST)
    this.side = info.side ?? 0;
    this.opp = 1 - this.side;
    this.mySide = this.side === 0 ? SIDE.FIRST : SIDE.SECOND;
    this.oppKey = info.oppKey ?? info.npcKey;
    this.claimSeen = false;
    // where claim/confirm/dispute go: the server's local chain by default, or
    // transactions this client signs itself (testnet)
    this.chain = chain ?? {
      claim: (winner) => api(`/api/match/${info.id}/claim`, { me, winner }),
      confirm: () => api(`/api/match/${info.id}/confirm`, { me }),
      dispute: (log, signedTick, sig) => api(`/api/match/${info.id}/dispute`, { me, log: hex(log), signedTick, sig }),
    };
    this.id = info.id;
    this.D = info.duration;
    this.R = info.roundTicks;
    engine.reset();
    this.table = engine.getState();
    this.roundStart = this.table;
    this.records = [];
    this.secret = null;
    this.npcSig = null;
    this.verdict = null;
    this.settled = false;
    this.problems = [];
  }

  /** Feed server events here; they are processed strictly in order. */
  handle(kind, d) {
    this.queue = (this.queue ?? Promise.resolve()).then(() => this.dispatch(kind, d)).catch((e) => this.problem(String(e.message ?? e)));
    return this.queue;
  }

  async dispatch(kind, d) {
    if (d.match !== this.id) return;
    if (kind === "round") return this.onRound(d);
    if (kind === "reveal") return this.onReveal();
    if (kind === "round_result") return this.onResult(d);
    if (kind === "final") return this.onFinal(d);
    if (kind === "oppsig") return this.onOppSig(d);
    if (kind === "chain") return this.onChain(d);
    if (kind === "note") this.log("note", d.text);
  }

  async onRound(d) {
    this.round = d.round;
    this.roundStart = this.table;
    this.engine.setState(this.table);
    let choice = await this.aim(this.engine, { round: d.round, deadline: d.deadline, rounds: this.info.rounds });
    this.engine.setState(this.table);
    // never let a whole match pass without a flick from us: a match where no
    // ball moves is a draw, which the deployed arena cannot pay out
    if (!(choice && choice.power > 0) && !this.flicked && d.round === this.info.rounds - 1) {
      choice = { angle: 0, power: 0.1 };
      this.log("note", "Last round and no flick yet: a small flick is made for you, so the match cannot end as a no-play draw.");
    }
    const imp = choice && choice.power > 0 ? flickToImpulse(this.engine, choice.angle, choice.power) : { dvx: 0n, dvy: 0n };
    if (imp.dvx !== 0n || imp.dvy !== 0n) this.flicked = true;
    const entry = { ball: this.side, dvx: imp.dvx, dvy: imp.dvy };
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const hash = await commitHash(this.id, d.round, entry, salt);
    this.secret = { entry, salt };
    await this.api(`/api/match/${this.id}/commit`, { me: this.me, hash });
    this.log("commit", `Round ${d.round + 1}: flick committed (hash ${hash.slice(0, 10)}…), hidden until both have committed`);
  }

  async onReveal() {
    const s = this.secret;
    if (!s) return;
    await this.api(`/api/match/${this.id}/reveal`, { me: this.me, dvx: String(s.entry.dvx), dvy: String(s.entry.dvy), salt: hex(s.salt) });
  }

  async onResult(d) {
    const entries = d.entries.map((e) => ({ ball: e.ball, dvx: BigInt(e.dvx), dvy: BigInt(e.dvy) }));
    // 1. the opponent's flick must be the one it committed to before seeing ours
    const oppEntry = entries.find((e) => e.ball === this.opp) ?? { ball: this.opp, dvx: 0n, dvy: 0n };
    const oppCommit = d.commits ? d.commits[this.opp] : d.npcCommit;
    const oppSalt = d.salts ? d.salts[this.opp] : d.npcSalt;
    if (oppCommit && oppCommit !== "pass" && oppSalt) {
      const okCommit = (await commitHash(this.id, d.round, oppEntry, unhex(oppSalt))) === oppCommit;
      if (!okCommit) this.problem(`Round ${d.round + 1}: ${this.info.npc.name}'s reveal does not match its commit`);
    } else if (entries.some((e) => e.ball === this.opp)) this.problem(`Round ${d.round + 1}: a flick for ${this.info.npc.name} without a commit`);
    // 2. our own flick must be in the record exactly as we sent it
    const mine = entries.find((e) => e.ball === this.side);
    const sent = this.secret?.entry;
    if (sent && (sent.dvx !== 0n || sent.dvy !== 0n) && !(mine && mine.dvx === sent.dvx && mine.dvy === sent.dvy)) this.problem(`Round ${d.round + 1}: our flick was dropped or altered`);
    // 3. extend our own log and table
    if (entries.length) this.records.push({ tick: d.tick, entries });
    this.engine.setState(this.table);
    this.engine.tick(encodeEntries(entries), d.tick);
    this.engine.runTicks(this.R - 1, d.tick + 1);
    this.table = this.engine.getState();
    // 4. the NPC's signature must cover OUR view of the log
    const log = encodeLog(this.records);
    const head = this.engine.headAt(log, this.D, d.signedTick);
    if (hex(head) !== d.head) this.problem(`Round ${d.round + 1}: server's log head differs from ours`);
    const digest = this.engine.signDigest(this.id, d.signedTick, head);
    if (d.npcSig) {
      if (await verifyEd(this.oppKey, digest, d.npcSig)) this.npcSig = { tick: d.signedTick, sig: d.npcSig };
      else this.problem(`Round ${d.round + 1}: NPC signature invalid`);
    }
    // 5. countersign
    const sig = new Uint8Array(await subtle.sign({ name: "Ed25519" }, this.key.kp.privateKey, digest));
    await this.api(`/api/match/${this.id}/sign`, { me: this.me, tick: d.signedTick, sig: hex(sig) });
    this.log("round", `Round ${d.round + 1} recorded. Both signed the log up to tick ${d.signedTick}.`, { entries, roundStart: this.roundStart, tick: d.tick });
  }

  /** A person's signature over the head at `tick`, checked against OUR log. */
  async onOppSig(d) {
    const log = encodeLog(this.records.filter((r) => r.tick <= d.tick));
    const head = this.engine.headAt(log, this.D, d.tick);
    if (await verifyEd(this.oppKey, this.engine.signDigest(this.id, d.tick, head), d.sig)) {
      if (!this.npcSig || d.tick > this.npcSig.tick) this.npcSig = { tick: d.tick, sig: d.sig };
    } else this.problem(`${this.info.npc.name}'s signature for tick ${d.tick} is invalid`);
  }

  onFinal() {
    if (this.verdict != null) return;
    const log = encodeLog(this.records);
    this.verdict = this.engine.replay(log, this.D, this.D - 1).winner;
    this.log("final", `Our own replay of all ${this.D} ticks: ${this.sideText(this.verdict)}`, { verdict: this.verdict });
    // between two people the creator claims the true result, after a pause in
    // which the loser may try to claim a win instead (and get disputed)
    if (this.claimer)
      setTimeout(async () => {
        if (this.claimSeen || this.settled) return;
        try {
          await this.chain.claim(this.verdict);
        } catch (e) {
          if (!/already claimed|not live/.test(String(e.message))) this.problem(String(e.message ?? e));
        }
      }, this.claimDelayMs);
  }

  sideText(w) {
    return w === this.mySide ? "you won" : w === SIDE.DRAW ? "draw" : `${this.info.npc.name} won`;
  }

  async onChain(e) {
    this.log("chain", e.text, e);
    if (e.kind === "settle") this.settled = true;
    if (e.kind === "claim") this.claimSeen = true;
    if (!this.autoSettle || e.kind !== "claim") return;
    if (e.data.by === this.me) return;
    if (this.verdict == null) this.onFinal();
    if (e.data.winner === this.verdict) {
      await this.chain.confirm();
      this.log("you", "The claim matches our replay: confirmed.");
    } else {
      await this.dispute();
    }
  }

  async dispute() {
    if (!this.npcSig) throw new Error(`no signature from ${this.info.npc.name} to dispute with`);
    const log = encodeLog(this.records.filter((r) => r.tick <= this.npcSig.tick));
    this.log("you", `The claim contradicts our replay: disputing on-chain with ${this.info.pvp ? this.info.npc.name + "'s" : "the NPC's"} own signature (tick ${this.npcSig.tick}).`);
    return this.chain.dispute(log, this.npcSig.tick, this.npcSig.sig);
  }

  /** The "be the liar" demo: claim a win you did not earn. */
  async falseClaim() {
    return this.chain.claim(this.mySide);
  }

  problem(text) {
    this.problems.push(text);
    this.log("problem", text);
  }
}
