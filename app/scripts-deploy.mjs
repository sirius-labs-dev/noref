// Deploy contracts/noref to <account> and call new() if not initialized.
import { readFileSync } from "node:fs";
import { Near, keyFromSecret, action, TGAS } from "./shared/near.js";
const id = process.argv[2] ?? "noref.testnet";
const cred = JSON.parse(readFileSync(new URL(`../.keys/${id}.json`, import.meta.url)));
const key = await keyFromSecret(cred.private_key);
if (key.publicKey !== cred.public_key) throw new Error("key mismatch");
const near = new Near();
const wasm = readFileSync(new URL("../target/near/noref_contract/noref_contract.wasm", import.meta.url));
let initialized = true;
try {
  await near.view(id, "match_count");
} catch {
  initialized = false;
}
const actions = [action.deploy(wasm)];
if (!initialized) actions.push(action.call("new", {}, 30n * TGAS));
const r = await near.send(id, key, id, actions);
console.log("deployed", wasm.length, "bytes", initialized ? "(upgrade)" : "+ new()", "tx", near.explorer(r.hash), "gas", (Number(r.gasBurnt) / 1e12).toFixed(2), "Tgas");
console.log("match_count =", await near.view(id, "match_count"));
const a = await near.account(id);
console.log("balance", (Number(BigInt(a.amount) / 10n ** 21n) / 1000).toFixed(3), "NEAR, storage", a.storage_usage, "bytes");
