// Check the README's on-chain claims from a terminal, without a browser or an
// explorer (nearblocks pages refuse automated readers). Reads NEAR testnet RPC
// only; signs nothing. No install:
//   node scripts-verify.mjs [contract=arena.noref.testnet]
import { Near } from "./shared/near.js";

const contract = process.argv[2] ?? "arena.noref.testnet";
const near = new Near();
const SIDE = { 0: "draw", 1: "first player (creator)", 2: "second player" };
let ok = true;
const check = (cond, text) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${text}`);
  ok &&= cond;
};

const keys = await near.call("query", { request_type: "view_access_key_list", finality: "final", account_id: contract });
check(keys.keys.length === 0, `${contract} has ${keys.keys.length} access keys: nobody can redeploy or change it`);

const acct = await near.account(contract);
check(acct.code_hash === "UQVPg3sdWWWkaggDEMXBpFgbwJhs9i7zL3F5YAnDNeS", `deployed code hash ${acct.code_hash} (README: reproducible build of this repo)`);

const meta = await near.view(contract, "contract_source_metadata");
console.log(`     NEP-330 source: ${meta.link}  build: ${meta.build_info?.build_command?.join(" ")}`);

// match #0: NPC Vex lost, claimed a win; the player's dispute replayed it.
// match #1: two people; the host lost, claimed a win; the guest's dispute replayed it.
// match #2: NPC-vs-NPC ladder match, honest claim, no dispute.
const expect = [
  { id: 0, lie: true },
  { id: 1, lie: true },
  { id: 2, lie: false },
];
for (const e of expect) {
  const m = await near.view(contract, "get_match", { id: String(e.id) });
  const claimed = m.claim?.winner;
  const paid = m.result;
  const line = `match #${e.id}: ${m.a.split(".")[0]} vs ${m.b?.split(".")[0]}, ${m.phase}; ${m.claim?.by.split(".")[0]} claimed "${SIDE[claimed]} won"; contract paid ${SIDE[paid]}`;
  if (e.lie) check(m.phase === "Settled" && !!m.replayed && paid !== claimed && paid === m.replayed.winner, `${line}; replayed by ${m.replayed?.by.split(".")[0]} at tick ${m.replayed?.signed_tick}: the false claim lost`);
  else check(m.phase === "Settled" && !m.replayed && paid === claimed, `${line}; no dispute needed`);
}
console.log(ok ? "\nall checks passed" : "\nsome checks FAILED");
process.exitCode = ok ? 0 : 1;
