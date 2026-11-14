// Own a piece of a fighter, on testnet, through its vault contract:
// a fresh player backs the fighter (buys shares from the vault), checks the
// vault's own register and the server's mirror, then cashes out. The test
// account is deleted at the end and its balance returned to the house.
//
//   node scripts-testnet-vault.mjs [npc=vex] --url=https://noref.63-183-239-145.sslip.io:80
import { writeFileSync, rmSync } from "node:fs";
import { newSessionKey } from "./shared/client.js";
import { PlayerChain, accountKey } from "./shared/player-chain.js";
import { action, yoctoToMilli } from "./shared/near.js";

const args = process.argv.slice(2);
const npc = args.find((a) => !a.startsWith("--")) ?? "vex";
const BASE = (args.find((a) => a.startsWith("--url="))?.slice(6) ?? "http://127.0.0.1:8789").replace(/\/$/, "");
const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}`);
async function api(path, body) {
  const r = await fetch(BASE + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error}`);
  return j;
}
const milli = (y) => yoctoToMilli(BigInt(y)) / 1000;

const keyPath = new URL(`../.keys/vault-${Date.now()}.secret`, import.meta.url);
const acct = await accountKey({ get: () => null, set: (_, v) => writeFileSync(keyPath, v, { mode: 0o600 }) });
const session = await newSessionKey();
const login = await api("/api/login", { name: "vlt" + Date.now().toString(36).slice(-5), key: session.pubHex, account: acct.publicKey });
const me = login.me;
const pc = new PlayerChain({ rpc: BASE + "/api/rpc", contract: login.chain.contract, accountId: me, key: acct, api, log: () => {} });
log(`player ${me}, ${login.balance / 1000} NEAR`);
try {
  const n = (await api(`/api/state?me=${me}`)).roster.find((r) => r.id === npc);
  if (!n?.vault) throw new Error(`${npc} has no vault`);
  const before = await pc.near.view(n.account, "info", {});
  log(`${n.account}: bankroll ${milli(before.bankroll)} NEAR, ${before.total_shares} shares, price ${milli(before.price) * 1000} milliNEAR/share`);

  const b = await pc.callAt(n.account, "back", {}, 30n, 100n * 10n ** 21n);
  log(`back 0.1 NEAR -> ${b.result} shares  ${pc.near.explorer(b.hash)}`);
  await api("/api/sponsor", { me, npc, amount: 0.1, tx: b.hash });
  const [mine] = await pc.near.view(n.account, "shares_of", { account_id: me });
  const mirror = (await api(`/api/state?me=${me}`)).roster.find((r) => r.id === npc).holders[me];
  log(`vault register: ${mine} shares; server mirror: ${mirror}`);
  if (String(mine) !== String(b.result) || Number(mirror) !== Number(mine)) throw new Error("register and mirror disagree");

  const c = await pc.callAt(n.account, "cash_out", { shares: String(mine) }, 30n);
  await api("/api/cashout", { me, npc, shares: Number(mine), tx: c.hash });
  const after = await pc.near.view(n.account, "info", {});
  log(`cash_out ${mine} shares  ${pc.near.explorer(c.hash)}; bankroll back to ${milli(after.bankroll)} NEAR, ${after.total_shares} shares`);
  if (after.total_shares !== before.total_shares) throw new Error("shares did not go back");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  const r = await pc.near.send(me, acct, me, [action.deleteAccount(login.chain.house ?? login.chain.contract)]);
  log(`deleted ${me}: ${r.hash}`);
  rmSync(keyPath);
}
