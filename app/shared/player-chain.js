// The player's own NEAR transactions on testnet, signed with the account key
// that lives only in this client (browser localStorage, or a test process).
// The server relays RPC traffic but never sees the key.

import { Near, action, TGAS, keyFromSecret, newKey } from "./near.js";
import { b64 } from "./engine.js";

/** Load or make the player's account key. store = {get(k), set(k, v)}. */
export async function accountKey(store) {
  const saved = store.get("noref-acct");
  if (saved) {
    try {
      return await keyFromSecret(saved);
    } catch {}
  }
  const k = await newKey();
  store.set("noref-acct", k.secretKey);
  return k;
}

export class PlayerChain {
  /** rpc: "/api/rpc" in the browser (relayed by the server), or a full URL. */
  constructor({ rpc, contract, accountId, key, api, log }) {
    this.near = new Near(rpc);
    Object.assign(this, { contract, accountId, key, api, log: log ?? (() => {}) });
  }

  async call(method, args, gas = 30n, deposit = 0n) {
    return this.near.send(this.accountId, this.key, this.contract, [action.call(method, args, gas * TGAS, BigInt(deposit))]);
  }

  /** Step 2 of a challenge: lock the stake on-chain ourselves. */
  async open(o) {
    const r = await this.call(o.method, o.args, 30n, o.deposit);
    return { id: Number(r.result), hash: r.hash };
  }

  /** claim/confirm/dispute for one match, in the shape MatchClient wants. */
  opsFor(id) {
    const tell = (kind, r, gas) => this.api(`/api/match/${id}/tx`, { me: this.accountId, kind, hash: r.hash, gas }).catch(() => {});
    return {
      claim: async (winner) => {
        const r = await this.call("claim", { id: String(id), winner });
        this.log("tx", "You signed claim", r);
        await tell("claim", r);
        return r;
      },
      confirm: async () => {
        const r = await this.call("confirm", { id: String(id) });
        this.log("tx", "You signed confirm", r);
        await tell("settle", r);
        return r;
      },
      dispute: async (log, signedTick, sigHex) => {
        const sig = Uint8Array.from(sigHex.match(/../g), (h) => parseInt(h, 16));
        const r = await this.call("dispute", { id: String(id), log: b64(log), signed_tick: signedTick, signature: b64(sig) }, 300n);
        const gas = r.logs.find((l) => l.startsWith("noref:replay"))?.match(/gas_used=(\d+)/)?.[1];
        this.log("tx", "You signed dispute", r);
        await tell("replay", r, gas);
        return { winner: Number(r.result), hash: r.hash };
      },
    };
  }

  async transfer(to, yocto) {
    return this.near.send(this.accountId, this.key, to, [action.transfer(BigInt(yocto))]);
  }
}
