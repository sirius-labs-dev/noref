// One-off: create <name>.testnet through the testnet helper (faucet) with a
// fresh key stored in ../.keys/<name>.testnet.json (chmod 600). Never prints the secret.
import { writeFileSync, existsSync, chmodSync } from "node:fs";
import { Near, newKey } from "./shared/near.js";
const id = process.argv[2];
const file = new URL(`../.keys/${id}.json`, import.meta.url).pathname;
if (existsSync(file)) throw new Error("key file already exists: " + file);
const near = new Near();
if (await near.account(id)) throw new Error(id + " already exists");
const k = await newKey();
writeFileSync(file, JSON.stringify({ account_id: id, public_key: k.publicKey, private_key: k.secretKey }), { mode: 0o600 });
chmodSync(file, 0o600);
const r = await fetch("https://helper.testnet.near.org/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: k.publicKey }) });
console.log("helper:", r.status, (await r.text()).slice(0, 200));
for (let i = 0; i < 10; i++) {
  const a = await near.account(id);
  if (a) {
    console.log(`${id} created, balance ${(Number(BigInt(a.amount) / 10n ** 21n) / 1000).toFixed(3)} NEAR, key ${k.publicKey}`);
    process.exit(0);
  }
  await new Promise((ok) => setTimeout(ok, 1500));
}
console.log("account not visible yet");
