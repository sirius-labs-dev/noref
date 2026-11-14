// Is the code running on NEAR testnet built from this source?
//
// The arena (needs Docker):
//   cd contracts/noref && cargo near build reproducible-wasm
//   node scripts-code-hash.mjs [account=arena.noref.testnet]
//
// The six fighter vaults (Rust 1.94.1 and cargo-near 0.22.0, pinned in
// contracts/fighter/rust-toolchain.toml; see the README for a Docker command):
//   cd contracts/fighter && cargo near build non-reproducible-wasm --no-abi
//   node scripts-code-hash.mjs --fighter
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Near, b58encode } from "./shared/near.js";

const fighter = process.argv.includes("--fighter");
const file = fighter ? "../contracts/fighter/target/near/noref_fighter.wasm" : "../target/near/noref_contract/noref_contract.wasm";
const accounts = fighter
  ? ["rook", "brick", "moss", "vex", "pip", "dot"].map((n) => `npc-${n}.noref.testnet`)
  : [process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "arena.noref.testnet"];
const wasm = readFileSync(new URL(file, import.meta.url));
const local = b58encode(createHash("sha256").update(wasm).digest());
const near = new Near();
console.log(`local build  ${local}  (${wasm.length} bytes)`);
let all = true;
for (const account of accounts) {
  const onChain = (await near.account(account)).code_hash;
  console.log(`${account}  ${onChain}`);
  all &&= onChain === local;
}
console.log(all ? `MATCH: the deployed ${fighter ? "vaults are" : "contract is"} this source` : "DIFFERENT (another toolchain or another commit)");
