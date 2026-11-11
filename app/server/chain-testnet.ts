// Testnet adapter: same interface as LocalChain, backed by the deployed
// NoRef contract. Amounts in the interface stay integer milliNEAR.
//
// - NPC fighters are real accounts (npc-<id>.<contract>), keys in .keys/,
//   signed here. Players sign their own transactions in the browser with a
//   key the server never sees; the server only watches the contract.
// - The mirror in `matches` is refreshed from `get_match`; every change is
//   turned into the same events the local chain emits, plus the tx hash
//   when we know it.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Near, keyFromSecret, newKey, action, TGAS, NEAR, milliToYocto, yoctoToMilli } from "../shared/near.js";
import { SIDE } from "../shared/engine.js";
import type { Match, ChainEvent } from "./chain-local.ts";

const PHASE: Record<string, Match["phase"]> = { Open: "open", Live: "live", Settled: "settled", Cancelled: "cancelled" };

export class TestnetChain {
  kind = "testnet";
  near: Near;
  contract: string;
  keysDir: URL;
  owner: any;
  matches: Record<number, Match> = {};
  events: ChainEvent[] = [];
  onEvent: (e: ChainEvent) => void = () => {};
  npcIds = new Set<string>();
  private keys = new Map<string, any>();
  private bal = new Map<string, number>();
  private hints = new Map<string, { hash: string; gas?: string }>();
  private busy = new Set<number>();
  private inflight = new Set<number>();
  private polling = false;

  constructor(o: { near?: Near; contract: string; keysDir: URL }) {
    this.near = o.near ?? new Near();
    this.contract = o.contract;
    this.keysDir = o.keysDir;
  }

  async init(npcIds: string[]) {
    npcIds.forEach((i) => this.npcIds.add(i));
    this.owner = await this.loadKey(this.contract);
    if (!this.owner) throw new Error(`no key for ${this.contract} in .keys/`);
    await this.refreshBalance(this.contract);
    setInterval(() => this.pollAll().catch((e) => console.error("poll:", e.message)), 1500);
  }

  // ---- accounts ----
  /** logical id (NPC id or player account) -> chain account */
  acct(who: string) {
    return this.npcIds.has(who) ? `npc-${who}.${this.contract}` : who;
  }
  logical(account: string | null) {
    if (!account) return null;
    const m = account.match(new RegExp(`^npc-([a-z0-9]+)\\.${this.contract.replace(/\./g, "\\.")}$`));
    return m && this.npcIds.has(m[1]) ? m[1] : account;
  }
  playerAccount(name: string) {
    return `${name}.${this.contract}`;
  }
  explorer(hash: string) {
    return this.near.explorer(hash);
  }
  explorerAccount(who: string) {
    return `https://testnet.nearblocks.io/address/${this.acct(who)}`;
  }

  private keyFile(account: string) {
    return new URL(`${account}.json`, this.keysDir);
  }
  private async loadKey(account: string) {
    if (this.keys.has(account)) return this.keys.get(account);
    if (!existsSync(this.keyFile(account))) return null;
    const k = await keyFromSecret(JSON.parse(readFileSync(this.keyFile(account), "utf8")).private_key);
    this.keys.set(account, k);
    return k;
  }

  balance(who: string) {
    return this.bal.get(this.acct(who)) ?? 0;
  }
  async refreshBalance(who: string) {
    const a = await this.near.account(this.acct(who));
    const v = a ? yoctoToMilli(a.amount) : 0;
    this.bal.set(this.acct(who), v);
    return v;
  }

  /**
   * Player account <name>.<contract> with the browser's public key as its only
   * full-access key. Existing accounts are only accepted if they already carry
   * that key: the server never adds a key to an account it did not just make.
   */
  async ensurePlayer(name: string, publicKey: string, fundMilli: number) {
    const id = this.playerAccount(name);
    if (await this.near.account(id)) {
      if (!(await this.near.hasKey(id, publicKey))) throw new Error(`${id} exists and is not yours (different key)`);
      await this.refreshBalance(id);
      return { id, fresh: false };
    }
    const r = await this.near.send(this.contract, this.owner, id, [action.createAccount(), action.transfer(milliToYocto(fundMilli)), action.addFullKey(publicKey)]);
    await this.refreshBalance(id);
    this.refreshBalance(this.contract).catch(() => {});
    return { id, fresh: true, hash: r.hash };
  }

  /** Make sure the NPC's chain account exists and can cover `needMilli` plus gas. */
  async ensureNpc(npcId: string, needMilli: number) {
    const id = this.acct(npcId);
    const reserve = 300; // gas + storage
    let k = await this.loadKey(id);
    const a = await this.near.account(id);
    if (!a) {
      k = await newKey();
      writeFileSync(this.keyFile(id), JSON.stringify({ account_id: id, public_key: k.publicKey, private_key: k.secretKey }), { mode: 0o600 });
      this.keys.set(id, k);
      await this.near.send(this.contract, this.owner, id, [action.createAccount(), action.transfer(milliToYocto(needMilli + reserve + 200)), action.addFullKey(k.publicKey)]);
    } else {
      if (!k) throw new Error(`no key for ${id}`);
      const have = yoctoToMilli(a.amount);
      if (have < needMilli + reserve) await this.near.send(this.contract, this.owner, id, [action.transfer(milliToYocto(needMilli + reserve + 200 - have))]);
    }
    await this.refreshBalance(id);
    this.refreshBalance(this.contract).catch(() => {});
    return id;
  }

  /** NPC pays someone out of its own account (cash-out, dividends). Never topped up by the house. */
  async pay(npcId: string, to: string, milli: number) {
    const id = this.acct(npcId);
    await this.loadKey(id);
    if ((await this.refreshBalance(npcId)) < milli + 100) throw new Error(`${id} cannot cover ${milli / 1000} NEAR`);
    const r = await this.near.send(this.acct(npcId), this.keys.get(this.acct(npcId)), to, [action.transfer(milliToYocto(milli))]);
    this.refreshBalance(to).catch(() => {});
    this.refreshBalance(npcId).catch(() => {});
    return r.hash;
  }

  /** Does the NPC have a chain account yet? */
  async hasAccount(npcId: string) {
    return !!(await this.near.account(this.acct(npcId)));
  }

  /** The house backs an NPC with a real transfer (sponsor of last resort). */
  async houseBack(npcId: string, milli: number) {
    const r = await this.near.send(this.contract, this.owner, this.acct(npcId), [action.transfer(milliToYocto(milli))]);
    this.refreshBalance(npcId).catch(() => {});
    this.refreshBalance(this.contract).catch(() => {});
    return r.hash;
  }

  /**
   * NPC vs NPC ladder match, played for real on the contract: A creates and
   * stakes, B joins with the same stake, A claims the result both servers
   * computed, B confirms, and the contract pays the pot. Both NPCs are ours,
   * so nothing here is disputed; the money still moves on-chain.
   */
  async ladderMatch(aId: string, bId: string, stakeMilli: number, winner: number, duration: number) {
    const A = this.acct(aId);
    const B = this.acct(bId);
    const ka = await this.loadKey(A);
    const kb = await this.loadKey(B);
    if (!ka || !kb) throw new Error("missing NPC key");
    const sk = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, "0")).join("");
    const dep = milliToYocto(stakeMilli);
    const call = (who: string, key: any, method: string, args: any, deposit = 0n) => this.near.send(who, key, this.contract, [action.call(method, args, 30n * TGAS, deposit)]);
    const c = await call(A, ka, "create", { duration, session_key: sk(), window_secs: 10, opponent: B }, dep);
    const id = Number(c.result);
    try {
      await call(B, kb, "join", { id: String(id), session_key: sk() }, dep);
    } catch (e) {
      await call(A, ka, "cancel", { id: String(id) }).catch(() => {});
      throw e;
    }
    await call(A, ka, "claim", { id: String(id), winner });
    const f = await call(B, kb, "confirm", { id: String(id) });
    this.refreshBalance(aId).catch(() => {});
    this.refreshBalance(bId).catch(() => {});
    return { id, create: c.hash, settle: f.hash };
  }

  /** Check a transfer the player signed in the browser. */
  async verifyTransfer(hash: string, from: string, toNpc: string, milli: number) {
    const t = await this.near.tx(hash, from);
    if (t.status?.Failure) throw new Error("transfer failed");
    const tx = t.transaction;
    const dep = tx.actions?.find((a: any) => a.Transfer)?.Transfer?.deposit;
    if (tx.signer_id !== from || tx.receiver_id !== this.acct(toNpc) || !dep || BigInt(dep) !== milliToYocto(milli)) throw new Error("transaction is not that transfer");
    this.refreshBalance(from).catch(() => {});
    this.refreshBalance(toNpc).catch(() => {});
  }

  // ---- contract calls signed by NPCs / the house ----
  private async npcCall(npcId: string, id: number, kind: string, method: string, args: any, gas = 30n, deposit = 0n) {
    const account = this.acct(npcId);
    const key = await this.loadKey(account);
    this.inflight.add(id); // so the poller does not report it before we know the hash
    let r;
    try {
      r = await this.near.send(account, key, this.contract, [action.call(method, args, gas * TGAS, deposit)]);
    } finally {
      this.inflight.delete(id);
    }
    const gasLog = r.logs.find((l: string) => l.startsWith("noref:replay"))?.match(/gas_used=(\d+)/)?.[1];
    this.hint(id, kind, r.hash, gasLog);
    await this.refresh(id);
    return r;
  }

  hint(id: number, kind: string, hash: string, gas?: string) {
    this.hints.set(`${id}:${kind}`, { hash, gas });
  }

  /** Register a match the player just created; verifies it on-chain. */
  async track(id: number) {
    await this.refresh(id, true);
    return this.matches[id];
  }

  async join(npcId: string, id: number, keyB: string) {
    const m = this.matches[id];
    await this.npcCall(npcId, id, "join", "join", { id: String(id), session_key: keyB }, 30n, milliToYocto(m.stake));
  }
  async claim(who: string, id: number, winner: number) {
    await this.npcCall(who, id, "claim", "claim", { id: String(id), winner });
  }
  async confirm(who: string, id: number) {
    await this.npcCall(who, id, "settle", "confirm", { id: String(id) });
  }
  async dispute(who: string, id: number, log: Uint8Array, signedTick: number, sig: Uint8Array) {
    try {
      const r = await this.npcCall(who, id, "replay", "dispute", { id: String(id), log: Buffer.from(log).toString("base64"), signed_tick: signedTick, signature: Buffer.from(sig).toString("base64") }, 300n);
      return Number(r.result);
    } catch (e: any) {
      this.emit(id, "reject", `${who}'s dispute was rejected by the contract: ${String(e.message).slice(0, 160)}`, undefined, e.outcome?.hash);
      throw e;
    }
  }
  async finalize(id: number) {
    this.inflight.add(id);
    let r;
    try {
      r = await this.near.send(this.contract, this.owner, this.contract, [action.call("finalize", { id: String(id) }, 30n * TGAS)]);
    } finally {
      this.inflight.delete(id);
    }
    this.hint(id, "settle", r.hash);
    this.hint(id, "finalize", r.hash);
    await this.refresh(id);
  }

  /** Settle claimed matches once their window is over (anyone may call finalize). */
  tick() {
    for (const m of Object.values(this.matches)) {
      if (m.phase !== "live" || !m.claim || Date.now() < m.windowEndMs + 2500 || this.busy.has(m.id)) continue;
      this.busy.add(m.id);
      this.finalize(m.id)
        .catch((e) => {
          if (!/window still open/.test(e.message)) console.error(`finalize #${m.id}:`, e.message);
        })
        .finally(() => this.busy.delete(m.id));
    }
  }

  // ---- mirror ----
  private async pollAll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const m of Object.values(this.matches)) if ((m.phase === "live" || m.phase === "open") && !this.inflight.has(m.id)) await this.refresh(m.id);
    } finally {
      this.polling = false;
    }
  }

  /** Read the match from the contract and emit events for whatever changed. */
  async refresh(id: number, first = false) {
    let c = await this.near.view(this.contract, "get_match", { id: String(id) });
    // a match created a moment ago may not be visible on every RPC node yet
    for (let i = 0; !c && first && i < 8; i++) {
      await new Promise((ok) => setTimeout(ok, 700));
      c = await this.near.view(this.contract, "get_match", { id: String(id) });
    }
    if (!c) throw new Error(`match #${id} not on-chain`);
    const prev = this.matches[id];
    const m: Match = {
      id,
      a: this.logical(c.a)!,
      b: this.logical(c.b),
      stake: yoctoToMilli(c.stake),
      duration: c.duration,
      keyA: c.key_a,
      keyB: c.key_b,
      phase: PHASE[c.phase],
      windowSecs: Number(c.window_secs),
      startedMs: Number(BigInt(c.started_ns) / 1_000_000n),
      claim: c.claim ? { by: this.logical(c.claim.by)!, winner: c.claim.winner } : null,
      replayed: c.replayed ? { signedTick: c.replayed.signed_tick, winner: c.replayed.winner, by: this.logical(c.replayed.by)!, finalRoot: c.replayed.final_root } : null,
      windowEndMs: Number(BigInt(c.window_end_ns) / 1_000_000n),
      result: c.result ?? null,
    };
    (m as any).invited = this.logical(c.invited);
    this.matches[id] = m;
    const pot = (2 * m.stake) / 1000;
    if (first || !prev) this.emit(id, "create", `${m.a} opened match #${id} on ${this.contract} and locked ${m.stake / 1000} NEAR`);
    if (m.b && !prev?.b) this.emit(id, "join", `${m.b} joined and locked ${m.stake / 1000} NEAR. Pot on-chain: ${pot} NEAR`);
    if (m.claim && !prev?.claim) this.emit(id, "claim", `${m.claim.by} claims: ${this.sideName(m, m.claim.winner)}. Dispute window ${m.windowSecs}s`, { winner: m.claim.winner, by: m.claim.by });
    if (m.replayed && m.replayed.signedTick !== prev?.replayed?.signedTick) {
      const overturned = m.replayed.winner !== m.claim!.winner;
      const gas = this.hints.get(`${id}:replay`)?.gas;
      this.emit(
        id,
        "replay",
        `${m.replayed.by} disputed. The contract replayed all ${m.duration} ticks on NEAR${gas ? ` (${(Number(gas) / 1e12).toFixed(1)} Tgas)` : ""}: ${this.sideName(m, m.replayed.winner)}.` + (overturned ? " The claim was false." : " The claim was right."),
        { winner: m.replayed.winner, overturned, finalRoot: m.replayed.finalRoot, signedTick: m.replayed.signedTick }
      );
    }
    if (m.phase === "settled" && prev?.phase !== "settled") {
      const w = m.result!;
      const other = m.claim && (m.claim.by === m.a ? m.b : m.a);
      if (m.claim && !this.hints.has(`${id}:finalize`)) this.emit(id, "confirm", `${other} agrees with the claim`);
      else if (m.claim) this.emit(id, "finalize", `Dispute window closed; anyone may finalize`);
      this.emit(id, "settle", w === SIDE.DRAW ? `Draw: both refunded on-chain` : `Contract paid ${pot} NEAR to ${w === SIDE.FIRST ? m.a : m.b}`, { winner: w });
      [m.a, m.b].forEach((x) => x && this.refreshBalance(x).catch(() => {}));
    }
    return m;
  }

  private emit(match: number, kind: string, text: string, data?: unknown, hash?: string) {
    const h = hash ?? this.hints.get(`${match}:${kind}`)?.hash;
    const e: ChainEvent & { tx?: string; url?: string } = { t: Date.now(), match, kind, text, data };
    if (h) {
      e.tx = h;
      e.url = this.explorer(h);
    }
    this.events.push(e);
    if (this.events.length > 500) this.events.shift();
    this.onEvent(e);
  }

  sideName(m: Match, winner: number) {
    if (winner === SIDE.FIRST) return `${m.a} won`;
    if (winner === SIDE.SECOND) return `${m.b} won`;
    return "draw";
  }
}

export { NEAR };
