// NoRef engine wrapper. Loads engine.wasm (the exact rule code the NEAR
// contract replays disputes with) and exposes it to the browser and to the
// Node server. No dependencies.

export const SIDE = { DRAW: 0, FIRST: 1, SECOND: 2 };
export const ENTRY_SIZE = 20;
export const N_BALLS = 8;
export const ONE = 2n ** 32n;
const ERR = { "-1": "malformed log", "-2": "bad tick", "-3": "bad entry", "-4": "game error" };

export class Engine {
  static async load(bytes) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Engine(instance.exports);
  }

  constructor(x) {
    this.x = x;
    this.mem = x.memory;
    this.ROUND_TICKS = x.round_ticks();
    this.MATCH_TICKS = x.match_ticks();
    this.MAX_DURATION = x.max_duration();
    this.MAX_IMPULSE = x.max_impulse(); // BigInt, Q32.32
    this.STATE_SIZE = x.state_size();
    this.IN_LEN = x.buf_in_len();
  }

  view(ptr, len) {
    return new Uint8Array(this.mem.buffer, ptr, len);
  }
  get state() {
    return this.view(this.x.buf_state(), this.STATE_SIZE);
  }
  get out() {
    return this.view(this.x.buf_out(), 128);
  }
  writeIn(bytes) {
    if (bytes.length > this.IN_LEN) throw new Error("input too large");
    this.view(this.x.buf_in(), bytes.length).set(bytes);
  }

  reset() {
    this.x.init();
  }
  getState() {
    return this.state.slice();
  }
  setState(bytes) {
    this.state.set(bytes);
  }
  /** One tick with an encoded entries buffer (may be empty). */
  tick(entries, t) {
    this.writeIn(entries);
    if (this.x.tick(entries.length, t) !== 0) throw new Error("tick rejected input");
  }
  runTicks(n, start) {
    return this.x.run_ticks(n, start);
  }
  atRest() {
    return this.x.at_rest() === 1;
  }
  verdict() {
    return this.x.verdict();
  }
  save() {
    this.x.save();
  }
  restore() {
    this.x.restore();
  }
  /** Squared distance of a ball to the center in whole units^2 (display / NPC scoring only). */
  dist2(ball) {
    return Number(this.x.center_dist2_units(ball));
  }
  /** Ball positions and velocities as floats, for drawing only. */
  balls() {
    const dv = new DataView(this.mem.buffer, this.x.buf_state(), this.STATE_SIZE);
    const f = (off) => Number(dv.getBigInt64(off, true)) / 4294967296;
    const out = [];
    for (let i = 0; i < N_BALLS; i++) {
      const b = 8 + i * 32;
      out.push({ x: f(b), y: f(b + 8), vx: f(b + 16), vy: f(b + 24) });
    }
    return out;
  }

  /** Full-match replay of a log; same function the contract runs. */
  replay(log, duration, signedTick) {
    this.writeIn(log);
    const r = this.x.replay(log.length, duration, signedTick);
    if (r < 0) throw new Error("invalid log: " + ERR[r]);
    const o = this.out;
    return { winner: r, head: o.slice(1, 33), finalRoot: o.slice(33, 65) };
  }
  headAt(log, duration, upto) {
    this.writeIn(log);
    const r = this.x.head_at(log.length, duration, upto);
    if (r < 0) throw new Error("invalid log: " + ERR[r]);
    return this.out.slice(0, 32);
  }
  /** The 32 bytes a player signs to endorse the log up to `tick`. */
  signDigest(matchId, tick, head) {
    this.writeIn(head);
    this.x.sign_digest(BigInt(matchId), tick);
    return this.out.slice(0, 32);
  }
}

// ---- log encoding (mirrors noref_rules::encode_record) ----

/** entries: [{ball, dvx, dvy}] with dvx/dvy BigInt Q32.32 */
export function encodeEntries(entries) {
  const buf = new Uint8Array(entries.length * ENTRY_SIZE);
  const dv = new DataView(buf.buffer);
  entries.forEach((e, i) => {
    dv.setUint32(i * ENTRY_SIZE, e.ball, true);
    dv.setBigInt64(i * ENTRY_SIZE + 4, BigInt(e.dvx), true);
    dv.setBigInt64(i * ENTRY_SIZE + 12, BigInt(e.dvy), true);
  });
  return buf;
}

/** records: [{tick, entries:[...]}] sorted by tick -> raw log bytes */
export function encodeLog(records) {
  const parts = [];
  let len = 0;
  for (const r of records) {
    const e = encodeEntries(r.entries);
    const head = new Uint8Array(5);
    new DataView(head.buffer).setUint32(0, r.tick, true);
    head[4] = r.entries.length;
    parts.push(head, e);
    len += 5 + e.length;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Turn an aim (angle in degrees, 0 = +x, 90 = +y; power 0..1) into an
 * integer impulse. Floats only pick the integers; from here on everyone
 * (players, contract) works on the same integers.
 */
export function flickToImpulse(engine, angleDeg, power) {
  const p = Math.max(0, Math.min(1, power)) * 0.999;
  const max = Number(engine.MAX_IMPULSE) / 4294967296;
  const v = p * max;
  const a = (angleDeg * Math.PI) / 180;
  const dvx = BigInt(Math.trunc(v * Math.cos(a) * 4294967296));
  const dvy = BigInt(Math.trunc(v * Math.sin(a) * 4294967296));
  return { dvx, dvy };
}

// ---- small byte helpers ----

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
export function b64(bytes) {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}
export function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** commit = sha256("noref/commit" | matchId | round | ball | dvx | dvy | salt) */
export async function commitHash(matchId, round, entry, salt) {
  const tag = new TextEncoder().encode("noref/commit");
  const body = new Uint8Array(tag.length + 8 + 4 + ENTRY_SIZE + salt.length);
  body.set(tag, 0);
  const dv = new DataView(body.buffer);
  dv.setBigUint64(tag.length, BigInt(matchId), true);
  dv.setUint32(tag.length + 8, round, true);
  body.set(encodeEntries([entry]), tag.length + 12);
  body.set(salt, tag.length + 12 + ENTRY_SIZE);
  return hex(await sha256(body));
}
