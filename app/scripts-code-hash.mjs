// Is the contract running on noref.testnet built from this source?
// Build first: cd contracts/noref && cargo near build non-reproducible-wasm --no-abi
//   node scripts-code-hash.mjs [account=noref.testnet]
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Near, b58encode } from "./shared/near.js";
const account = process.argv[2] ?? "noref.testnet";
const wasm = readFileSync(new URL("../target/near/noref_contract/noref_contract.wasm", import.meta.url));
const local = b58encode(createHash("sha256").update(wasm).digest());
const onChain = (await new Near().account(account)).code_hash;
console.log(`local build  ${local}  (${wasm.length} bytes)`);
console.log(`${account}  ${onChain}`);
console.log(local === onChain ? "MATCH: the deployed contract is this source" : "DIFFERENT (another toolchain or another commit)");
