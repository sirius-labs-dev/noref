// Testnet adapter: same interface as LocalChain, backed by the deployed
// NoRef contract. Amounts in the interface stay integer milliNEAR.
//
// - NPC fighters are real accounts (npc-<id>.<contract>), keys in .keys/,
//   signed here. Players sign their own transactions in the browser with a
//   key the server never sees; the server only watches the contract.
// - The mirror in `matches` is refreshed from `get_match`; every change is
//   turned into the same events the local chain emits, plus the tx hash
//   when we know it.

import * as eco from "../shared/economy.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Near, keyFromSecret, newKey, action, TGAS, NEAR, milliToYocto, yoctoToMilli } from "../shared/near.js";
import { SIDE } from "../shared/engine.js";
import type { Match, ChainEvent } from "./chain-local.ts";

const PHASE: Record<string, Match["phase"]> = { Open: "open", Live: "live", Settled: "settled", Cancelled: "cancelled" };

/** How a finished match ended, as the contract stores it (raw account ids). */
export type Final = { a: string; b: string | null; settled: boolean; result: number | null; claimBy: string | null; claimWinner: number | null };

export class TestnetChain {
  kind = "testnet";
  near: Near;
  contract: string;
  house: string;
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

  constructor(o: { near?: Near; contract: string; house?: string; keysDir: URL }) {
    this.near = o.near ?? new Near();
    this.contract = o.contract;
    this.house = o.house ?? o.contract; // creates and funds accounts; the contract itself may be key-less
    this.keysDir = o.keysDir;
  }

  async init(npcIds: string[]) {
    npcIds.forEach((i) => this.npcIds.add(i));
    this.owner = await this.loadKey(this.house);
    if (!this.owner) throw new Error(`no key for ${this.house} in .keys/`);
    await this.refreshBalance(this.house);
    await this.detectVaults();
    setInterval(() => this.pollAll().catch((e) => console.error("poll:", e.message)), 1500);
  }

  // ---- accounts ----
  /** logical id (NPC id or player account) -> chain account */
  acct(who: string) {
    return this.npcIds.has(who) ? `npc-${who}.${this.house}` : who;
  }
  logical(account: string | null) {
    if (!account) return null;
    const m = account.match(new RegExp(`^npc-([a-z0-9]+)\\.${this.house.replace(/\./g, "\\.")}$`));
    return m && this.npcIds.has(m[1]) ? m[1] : account;
  }
  playerAccount(name: string) {
    return `${name}.${this.house}`;
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
    if (this.vaults.has(who)) {
      const v = yoctoToMilli(BigInt((await this.vaultInfo(who)).bankroll));
      this.bal.set(this.acct(who), v);
      return v;
    }
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
    const r = await this.near.send(this.house, this.owner, id, [action.createAccount(), action.transfer(milliToYocto(fundMilli)), action.addFullKey(publicKey)]);
    await this.refreshBalance(id);
    this.refreshBalance(this.house).catch(() => {});
    return { id, fresh: true, hash: r.hash };
  }

  /** Make sure the NPC's chain account exists and can cover `needMilli` plus gas. */
  async ensureNpc(npcId: string, needMilli: number) {
    const id = this.acct(npcId);
    if (this.vaults.has(npcId)) {
      // a vault is never topped up from outside (that would be a gift to its
      // shareholders); it either covers the stake under its own rules or not
      const v = await this.vaultInfo(npcId);
      if (v.in_play.length) await this.vaultSyncAll(npcId);
      if (milliToYocto(needMilli) > BigInt(v.max_stake)) throw new Error(`${id} cannot stake ${needMilli / 1000} NEAR under its vault rules`);
      await this.refreshBalance(npcId);
      return id;
    }
    const reserve = 300; // gas + storage
    let k = await this.loadKey(id);
    const a = await this.near.account(id);
    if (!a) {
      k = await newKey();
      writeFileSync(this.keyFile(id), JSON.stringify({ account_id: id, public_key: k.publicKey, private_key: k.secretKey }), { mode: 0o600 });
      this.keys.set(id, k);
      await this.near.send(this.house, this.owner, id, [action.createAccount(), action.transfer(milliToYocto(needMilli + reserve + 200)), action.addFullKey(k.publicKey)]);
    } else {
      if (!k) throw new Error(`no key for ${id}`);
      const have = yoctoToMilli(a.amount);
      if (have < needMilli + reserve) await this.near.send(this.house, this.owner, id, [action.transfer(milliToYocto(needMilli + reserve + 200 - have))]);
    }
    await this.refreshBalance(id);
    this.refreshBalance(this.house).catch(() => {});
    return id;
  }

  /** NPC pays someone out of its own account (cash-out, dividends). Never topped up by the house. */
  async pay(npcId: string, to: string, milli: number) {
    const id = this.acct(npcId);
    if (this.vaults.has(npcId)) throw new Error(`${id} is a vault: it pays only through cash_out and dividends`);
    await this.loadKey(id);
    if ((await this.refreshBalance(npcId)) < milli + 100) throw new Error(`${id} cannot cover ${milli / 1000} NEAR`);
    const r = await this.near.send(this.acct(npcId), this.keys.get(this.acct(npcId)), to, [action.transfer(milliToYocto(milli))]);
    this.refreshBalance(to).catch(() => {});
    this.refreshBalance(npcId).catch(() => {});
    return r.hash;
  }

  // ---- fighter vaults (contracts/fighter deployed on the NPC's own account) ----
  /** NPC ids whose account runs the fighter vault: their money moves only by its rules. */
  vaults = new Set<string>();
  async detectVaults() {
    for (const id of this.npcIds) {
      const a = await this.near.account(this.acct(id)).catch(() => null);
      if (a && a.code_hash !== "11111111111111111111111111111111") this.vaults.add(id);
      else this.vaults.delete(id);
    }
  }
  isVault(npcId: string) {
    return this.vaults.has(npcId);
  }
  /** The vault's own view: bankroll, shares, price, stakes in play (yoctoNEAR strings). */
  async vaultInfo(npcId: string) {
    return this.near.view(this.acct(npcId), "info", {});
  }
  async vaultHolders(npcId: string): Promise<[string, string][]> {
    return this.near.view(this.acct(npcId), "holders", {});
  }
  /** Anyone may tell a vault a match is over; the house pays the gas. */
  async vaultSync(npcId: string, id: number) {
    return this.near.send(this.house, this.owner, this.acct(npcId), [action.call("sync", { id: String(id) }, 60n * TGAS)]);
  }
  /** Stakes the vault still counts as in play: tell it about the ones that are over. */
  async vaultSyncAll(npcId: string) {
    const v = await this.vaultInfo(npcId);
    for (const [id] of v.in_play) await this.vaultSync(npcId, Number(id)).catch((e) => console.error(`sync ${npcId} #${id}:`, e.message));
    return v.in_play.length;
  }
  /** Dividends: set aside the excess, then pay each holder. Returns what was paid to whom. */
  async vaultDividends(npcId: string) {
    const acct = this.acct(npcId);
    const r = await this.near.send(this.house, this.owner, acct, [action.call("pay_dividends", {}, 30n * TGAS)]);
    const paid: { who: string; milli: number; hash: string }[] = [];
    for (const [who] of await this.vaultHolders(npcId)) {
      const c = await this.near.send(this.house, this.owner, acct, [action.call("claim_dividend", { account_id: who }, 30n * TGAS)]);
      const milli = yoctoToMilli(BigInt(String(c.result ?? "0")));
      if (milli > 0) paid.push({ who, milli, hash: c.hash });
    }
    return { hash: r.hash, total: yoctoToMilli(BigInt(String(r.result))), paid };
  }
  /** Check a call a player signed in the browser to a vault (back / cash_out). */
  async verifyVaultCall(hash: string, from: string, npcId: string, method: string, depositMilli?: number) {
    const t = await this.near.tx(hash, from);
    if (t.status?.Failure) throw new Error(`${method} failed on-chain`);
    const tx = t.transaction;
    const fc = tx.actions?.find((a: any) => a.FunctionCall)?.FunctionCall;
    if (tx.signer_id !== from || tx.receiver_id !== this.acct(npcId) || fc?.method_name !== method) throw new Error(`transaction is not a ${method} on ${this.acct(npcId)}`);
    if (depositMilli != null && BigInt(fc.deposit) !== milliToYocto(depositMilli)) throw new Error("wrong amount");
    this.refreshBalance(from).catch(() => {});
    const v = t.status?.SuccessValue ? JSON.parse(atob(t.status.SuccessValue)) : null;
    return v;
  }

  /** Does the NPC have a chain account yet? */
  async hasAccount(npcId: string) {
    return !!(await this.near.account(this.acct(npcId)));
  }

  /** The house backs an NPC with a real transfer (sponsor of last resort). */
  async houseBack(npcId: string, milli: number) {
    const r = this.vaults.has(npcId)
      ? await this.near.send(this.house, this.owner, this.acct(npcId), [action.call("back", {}, 30n * TGAS, milliToYocto(milli))])
      : await this.near.send(this.house, this.owner, this.acct(npcId), [action.transfer(milliToYocto(milli))]);
    this.refreshBalance(npcId).catch(() => {});
    this.refreshBalance(this.house).catch(() => {});
    return r.hash;
  }

  /**
   * NPC vs NPC ladder match, played for real on the contract: A creates and
   * stakes, B joins with the same stake, A claims the result both servers
   * computed, B confirms, and the contract pays the pot. Both NPCs are ours,
   * so nothing here is disputed; the money still moves on-chain.
   */
  async ladderMatch(aId: string, bId: string, stakeMilli: number, winner: number, duration: number) {
    const sk = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, "0")).join("");
    const dep = milliToYocto(stakeMilli);
    const c = await this.npcTx(aId, "create", { duration, session_key: sk(), window_secs: 10, opponent: this.acct(bId) }, dep);
    const id = Number(c.result);
    try {
      await this.npcTx(bId, "join", { id: String(id), session_key: sk() }, dep);
    } catch (e) {
      await this.npcTx(aId, "cancel", { id: String(id) }).catch(() => {});
      if (this.vaults.has(aId)) await this.vaultSync(aId, id).catch(() => {});
      throw e;
    }
    await this.npcTx(aId, "claim", { id: String(id), winner });
    const f = await this.npcTx(bId, "confirm", { id: String(id) });
    for (const n of [aId, bId]) if (this.vaults.has(n)) await this.vaultSync(n, id).catch((e) => console.error(`sync ${n} #${id}:`, e.message));
    this.refreshBalance(aId).catch(() => {});
    this.refreshBalance(bId).catch(() => {});
    return { id, create: c.hash, settle: f.hash };
  }

  /**
   * An arena call signed by an NPC. With a vault the NPC's key may only call
   * the vault's play_* methods: the stake goes as an argument and the vault
   * attaches it from its own balance after checking its rules.
   */
  private async npcTx(npcId: string, method: string, args: any, deposit = 0n, gas = 30n) {
    const account = this.acct(npcId);
    const key = await this.loadKey(account);
    if (!key) throw new Error(`no key for ${account}`);
    if (!this.vaults.has(npcId)) return this.near.send(account, key, this.contract, [action.call(method, args, gas * TGAS, deposit)]);
    const a = deposit > 0n ? { ...args, stake: String(deposit) } : args;
    return this.near.send(account, key, account, [action.call(`play_${method}`, a, method === "dispute" ? 300n * TGAS : 60n * TGAS, 0n)]);
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
    this.inflight.add(id); // so the poller does not report it before we know the hash
    let r;
    try {
      r = await this.npcTx(npcId, method, args, deposit, gas);
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
      r = await this.near.send(this.house, this.owner, this.contract, [action.call("finalize", { id: String(id) }, 30n * TGAS)]);
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

  /** Settled/cancelled matches never change again; remember who played them and how they ended. */
  private done = new Map<number, Final>();

  /**
   * Read the last `depth` matches on the contract that are not known to be
   * over yet (terminal ones are cached forever) and return the raw views of
   * the non-terminal ones that involve `account`.
   */
  private async scan(account: string, depth: number) {
    const count = Number(await this.near.view(this.contract, "match_count"));
    const ids = [];
    for (let id = count - 1; id >= Math.max(0, count - depth); id--) if (!this.done.has(id)) ids.push(id);
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      const batch = await Promise.all(ids.slice(i, i + 10).map((id) => this.near.view(this.contract, "get_match", { id: String(id) }).then((c: any) => [id, c])));
      for (const [id, c] of batch) {
        if (!c) continue;
        if (c.phase === "Settled" || c.phase === "Cancelled") this.done.set(id, { a: c.a, b: c.b ?? null, settled: c.phase === "Settled", result: c.result ?? null, claimBy: c.claim?.by ?? null, claimWinner: c.claim?.winner ?? null });
        else if (c.a === account || c.b === account) out.push({ id, ...c });
      }
    }
    return { out, from: Math.max(0, count - depth) };
  }

  /**
   * The account's matches among the last `depth` on the contract that still
   * hold its money: open (nobody joined) or live (not paid out). Raw contract
   * view, so the browser can decide to cancel, refund or finalize.
   */
  async unsettled(account: string, depth = 150) {
    return (await this.scan(account, depth)).out;
  }

  /** The account's public record from settled matches on the contract (anyone can recompute it). */
  async record(account: string, depth = 150) {
    const { from } = await this.scan(account, depth);
    return eco.tally(account, [...this.done.entries()].filter(([id]) => id >= from).map(([, f]) => f));
  }

  /** Every settled or cancelled match among the last `depth` on the contract (cached once final). */
  async finals(depth = 500) {
    const { from } = await this.scan("", depth);
    return [...this.done.entries()].filter(([id]) => id >= from).map(([, f]) => f);
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
    if ((m.phase === "settled" || m.phase === "cancelled") && prev && prev.phase !== m.phase) {
      // a vault keeps its stake "in play" until someone shows it the match is over
      for (const x of [m.a, m.b]) if (x && this.vaults.has(x)) this.vaultSync(x, id).then(() => this.refreshBalance(x)).catch((e) => console.error(`sync ${x} #${id}:`, e.message));
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
