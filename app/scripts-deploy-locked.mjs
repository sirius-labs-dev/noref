// Deploy contracts/noref to a fresh account that never has an access key, so
// nobody (us included) can ever change or remove the code: one transaction
// from the parent account creates it, funds it, deploys and initializes.
// Build first: cd contracts/noref && cargo near build reproducible-wasm
//   node scripts-deploy-locked.mjs [contract=arena.noref.testnet] [house=noref.testnet] [fund NEAR=3]
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Near, keyFromSecret, action, TGAS, NEAR, b58encode } from "./shared/near.js";

const [contract = "arena.noref.testnet", house = "noref.testnet", fund = "3"] = process.argv.slice(2);
if (!contract.endsWith("." + house)) throw new Error(`${contract} must be a sub-account of ${house}`);
const near = new Near();
const key = await keyFromSecret(JSON.parse(readFileSync(new URL(`../.keys/${house}.json`, import.meta.url))).private_key);
const wasm = readFileSync(new URL("../target/near/noref_contract/noref_contract.wasm", import.meta.url));
const local = b58encode(createHash("sha256").update(wasm).digest());
if (await near.account(contract)) throw new Error(`${contract} already exists`);

const r = await near.send(house, key, contract, [
  action.createAccount(),
  action.transfer(BigInt(Math.round(Number(fund) * 1000)) * (NEAR / 1000n)),
  action.deploy(wasm),
  action.call("new", {}, 30n * TGAS),
]);
console.log(`created + deployed + initialized ${contract}: ${near.explorer(r.hash)}`);
await new Promise((ok) => setTimeout(ok, 2500));

const a = await near.account(contract);
const keys = await near.call("query", { request_type: "view_access_key_list", finality: "optimistic", account_id: contract });
console.log(`code hash   ${a.code_hash}`);
console.log(`local build ${local}  ${a.code_hash === local ? "MATCH" : "DIFFERENT"}`);
console.log(`access keys ${keys.keys.length} ${keys.keys.length === 0 ? "(locked: nobody can redeploy)" : "(NOT locked)"}`);
console.log(`match_count ${await near.view(contract, "match_count")}`);
try {
  console.log("source metadata", JSON.stringify(await near.view(contract, "contract_source_metadata")));
} catch (e) {
  console.log("no contract_source_metadata view:", String(e.message).slice(0, 120));
}
