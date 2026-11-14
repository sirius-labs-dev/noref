// Minimal NEAR client: borsh transactions, ed25519 signing, JSON-RPC.
// No dependencies; runs in Node and in the browser (WebCrypto Ed25519).
//
// Covers exactly what NoRef needs: view calls, function calls, transfers,
// creating sub-accounts, adding function-call keys and deploying a contract.

const subtle = globalThis.crypto.subtle;

// ---------------- base58 ----------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}
export function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of str) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return new Uint8Array(out);
}

// ---------------- borsh writer ----------------
class W {
  constructor() {
    this.buf = new Uint8Array(1024);
    this.len = 0;
  }
  grow(n) {
    if (this.len + n <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    b.set(this.buf);
    this.buf = b;
  }
  u8(v) {
    this.grow(1);
    this.buf[this.len++] = v;
  }
  u32(v) {
    this.grow(4);
    new DataView(this.buf.buffer).setUint32(this.len, v, true);
    this.len += 4;
  }
  u64(v) {
    this.grow(8);
    new DataView(this.buf.buffer).setBigUint64(this.len, BigInt(v), true);
    this.len += 8;
  }
  u128(v) {
    const x = BigInt(v);
    this.u64(x & 0xffffffffffffffffn);
    this.u64(x >> 64n);
  }
  raw(bytes) {
    this.grow(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }
  bytes(bytes) {
    this.u32(bytes.length);
    this.raw(bytes);
  }
  str(s) {
    this.bytes(new TextEncoder().encode(s));
  }
  out() {
    return this.buf.slice(0, this.len);
  }
}

// ---------------- keys ----------------
/** A signer: { accountId, publicKey: "ed25519:...", sign(bytes) -> Promise<Uint8Array(64)> } */
export async function keyFromSeed(seed32) {
  // PKCS8 wrapper for a raw ed25519 seed
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed32]);
  const priv = await subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await subtle.exportKey("jwk", priv);
  const pub = b64urlDecode(jwk.x);
  return { priv, pub, publicKey: "ed25519:" + b58encode(pub), secretKey: "ed25519:" + b58encode(new Uint8Array([...seed32, ...pub])) };
}
export async function newKey() {
  return keyFromSeed(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}
/** NEAR CLI style "ed25519:<base58 64 bytes>" secret key */
export async function keyFromSecret(secretKey) {
  const raw = b58decode(secretKey.replace(/^ed25519:/, ""));
  return keyFromSeed(raw.slice(0, 32));
}
function b64urlDecode(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function sign(key, bytes) {
  return new Uint8Array(await subtle.sign({ name: "Ed25519" }, key.priv, bytes));
}

// ---------------- actions ----------------
export const action = {
  createAccount: () => ({ kind: 0 }),
  deploy: (code) => ({ kind: 1, code }),
  call: (method, args, gas = 30_000_000_000_000n, deposit = 0n) => ({ kind: 2, method, args, gas: BigInt(gas), deposit: BigInt(deposit) }),
  transfer: (deposit) => ({ kind: 3, deposit: BigInt(deposit) }),
  addFullKey: (publicKey) => ({ kind: 5, publicKey, perm: null }),
  deleteKey: (publicKey) => ({ kind: 6, publicKey }),
  deleteAccount: (beneficiaryId) => ({ kind: 7, beneficiaryId }),
  addFnKey: (publicKey, receiverId, methods = [], allowance = null) => ({ kind: 5, publicKey, perm: { receiverId, methods, allowance } }),
};

function writePublicKey(w, pk) {
  w.u8(0);
  w.raw(b58decode(pk.replace(/^ed25519:/, "")));
}

function encodeTx({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  const w = new W();
  w.str(signerId);
  writePublicKey(w, publicKey);
  w.u64(nonce);
  w.str(receiverId);
  w.raw(blockHash);
  w.u32(actions.length);
  for (const a of actions) {
    w.u8(a.kind);
    if (a.kind === 1) w.bytes(a.code);
    else if (a.kind === 2) {
      w.str(a.method);
      const args = a.args instanceof Uint8Array ? a.args : new TextEncoder().encode(JSON.stringify(a.args ?? {}));
      w.bytes(args);
      w.u64(a.gas);
      w.u128(a.deposit);
    } else if (a.kind === 3) w.u128(a.deposit);
    else if (a.kind === 7) w.str(a.beneficiaryId);
    else if (a.kind === 6) writePublicKey(w, a.publicKey);
    else if (a.kind === 5) {
      writePublicKey(w, a.publicKey);
      w.u64(0); // access key nonce
      if (a.perm) {
        w.u8(0); // FunctionCall
        if (a.perm.allowance == null) w.u8(0);
        else {
          w.u8(1);
          w.u128(a.perm.allowance);
        }
        w.str(a.perm.receiverId);
        w.u32(a.perm.methods.length);
        a.perm.methods.forEach((m) => w.str(m));
      } else w.u8(1); // FullAccess
    }
  }
  return w.out();
}

// ---------------- rpc ----------------
export class Near {
  constructor(rpc = "https://rpc.testnet.fastnear.com", network = "testnet") {
    this.rpc = rpc;
    this.network = network;
    this.nonces = new Map();
    this.queue = new Map(); // per-key serialization
  }

  async call(method, params) {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(this.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "noref", method, params }) });
      if (r.status === 429 && attempt < 4) {
        await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt));
        continue;
      }
      const j = await r.json();
      // some providers answer a rate limit inside a 200 response
      if (j.error?.code === -429 && attempt < 4) {
        await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt));
        continue;
      }
      if (j.error) throw Object.assign(new Error(JSON.stringify(j.error.data ?? j.error.cause ?? j.error)), { rpc: j.error });
      return j.result;
    }
  }

  async account(accountId) {
    try {
      return await this.call("query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
    } catch (e) {
      if (String(e.message).includes("UNKNOWN_ACCOUNT") || String(e.message).includes("does not exist")) return null;
      throw e;
    }
  }

  async view(contractId, method, args = {}) {
    const r = await this.call("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: btoa(JSON.stringify(args)),
    });
    return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));
  }

  /** Sign and send; resolves with the final execution outcome. */
  async send(signerId, key, receiverId, actions) {
    const qk = signerId + key.publicKey;
    const prev = this.queue.get(qk) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this._send(signerId, key, receiverId, actions));
    this.queue.set(qk, run);
    return run;
  }

  async _send(signerId, key, receiverId, actions) {
    // a lagging RPC node can hand out a stale block hash or nonce; those txs are
    // rejected before execution, so building and sending again is safe
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._sendOnce(signerId, key, receiverId, actions);
      } catch (e) {
        if (attempt >= 2 || !/"Expired"|InvalidNonce/.test(e.message)) throw e;
        this.nonces.delete(signerId + key.publicKey);
        await new Promise((ok) => setTimeout(ok, 1200));
      }
    }
  }

  async _sendOnce(signerId, key, receiverId, actions) {
    const qk = signerId + key.publicKey;
    let ak;
    for (let i = 0; ; i++) {
      try {
        ak = await this.call("query", { request_type: "view_access_key", finality: "optimistic", account_id: signerId, public_key: key.publicKey });
        break;
      } catch (e) {
        // a key added a moment ago may not be visible on this node yet
        if (i >= 5 || !/UNKNOWN_ACCESS_KEY|does not exist|UNKNOWN_ACCOUNT/.test(e.message)) throw e;
        await new Promise((ok) => setTimeout(ok, 700));
      }
    }
    const nonce = Math.max(Number(ak.nonce), this.nonces.get(qk) ?? 0) + 1;
    this.nonces.set(qk, nonce);
    const tx = encodeTx({ signerId, publicKey: key.publicKey, nonce, receiverId, blockHash: b58decode(ak.block_hash), actions });
    const hash = new Uint8Array(await subtle.digest("SHA-256", tx));
    const sig = await sign(key, hash);
    const signed = new Uint8Array(tx.length + 65);
    signed.set(tx);
    signed[tx.length] = 0;
    signed.set(sig, tx.length + 1);
    let b64 = "";
    for (const x of signed) b64 += String.fromCharCode(x);
    const res = await this.call("send_tx", { signed_tx_base64: btoa(b64), wait_until: "EXECUTED_OPTIMISTIC" });
    // overall status only: a deleted account's gas-refund receipt "fails" harmlessly
    const failure = res.status?.Failure;
    const out = { hash: res.transaction.hash, logs: res.receipts_outcome.flatMap((r) => r.outcome.logs), gasBurnt: res.receipts_outcome.reduce((s, r) => s + BigInt(r.outcome.gas_burnt), BigInt(res.transaction_outcome.outcome.gas_burnt)), result: null, failure };
    const ok = res.status?.SuccessValue;
    if (ok) out.result = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(ok), (c) => c.charCodeAt(0))));
    if (failure) throw Object.assign(new Error("tx failed: " + JSON.stringify(failure)), { outcome: out });
    return out;
  }

  /** Does this account have this public key? */
  async hasKey(accountId, publicKey) {
    try {
      await this.call("query", { request_type: "view_access_key", finality: "optimistic", account_id: accountId, public_key: publicKey });
      return true;
    } catch {
      return false;
    }
  }

  /** Final status of a transaction (used to verify a transfer the player signed). */
  async tx(hash, senderId) {
    return this.call("tx", { tx_hash: hash, sender_account_id: senderId, wait_until: "EXECUTED_OPTIMISTIC" });
  }

  explorer(hash) {
    return `https://testnet.nearblocks.io/txns/${hash}`;
  }
}

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const yoctoToMilli = (y) => Number(BigInt(y) / 10n ** 21n);
export const milliToYocto = (m) => BigInt(Math.round(m)) * 10n ** 21n;
