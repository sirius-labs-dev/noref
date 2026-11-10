// Top up the house account on testnet: make a throwaway account through the
// testnet helper (it starts with faucet NEAR), then delete it with the house
// account as beneficiary, which moves its whole balance over. Testnet only.
//   node scripts-refill.mjs [house=noref.testnet]
import { Near, newKey, action, yoctoToMilli } from "./shared/near.js";
const house = process.argv[2] ?? "noref.testnet";
const near = new Near();
const id = `noref-refill-${Date.now().toString(36)}.testnet`;
const k = await newKey();
const r = await fetch("https://helper.testnet.near.org/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: k.publicKey }) });
if (!r.ok) throw new Error(`helper: ${r.status} ${(await r.text()).slice(0, 200)}`);
let a = null;
for (let i = 0; i < 15 && !a; i++) {
  a = await near.account(id);
  if (!a) await new Promise((ok) => setTimeout(ok, 1500));
}
if (!a) throw new Error("helper account never appeared");
const before = yoctoToMilli((await near.account(house)).amount);
const t = await near.send(id, k, id, [action.deleteAccount(house)]);
await new Promise((ok) => setTimeout(ok, 2500));
const after = yoctoToMilli((await near.account(house)).amount);
console.log(`${house}: ${before / 1000} -> ${after / 1000} NEAR (${near.explorer(t.hash)})`);
