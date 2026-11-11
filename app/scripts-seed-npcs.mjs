// One-off for the testnet economy: give every NPC fighter a real NEAR account
// funded by the house (as the house's investment), then reset the server's
// roster so each bankroll is that account's balance minus its gas reserve.
// Run with the server stopped. Testnet only.
//   node scripts-seed-npcs.mjs <keysDir> <world.json> [--dry]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Near, keyFromSecret, newKey, action, milliToYocto, yoctoToMilli } from "./shared/near.js";
import * as eco from "./shared/economy.js";

const [keysDir, worldFile] = process.argv.slice(2);
const dry = process.argv.includes("--dry");
if (!keysDir || !worldFile) throw new Error("usage: node scripts-seed-npcs.mjs <keysDir> <world.json> [--dry]");
const HOUSE = "noref.testnet";
const RESERVE = 300;
// target account balance in milliNEAR (bankroll + reserve)
const TARGET = { rook: 2100, brick: 1600, moss: 1800, vex: 1500, pip: 1300, dot: 1100 };

const near = new Near();
const keyOf = async (acct) => keyFromSecret(JSON.parse(readFileSync(join(keysDir, `${acct}.json`), "utf8")).private_key);
const house = await keyOf(HOUSE);
const world = JSON.parse(readFileSync(worldFile, "utf8"));

for (const [id, target] of Object.entries(TARGET)) {
  const acct = `npc-${id}.${HOUSE}`;
  const a = await near.account(acct);
  const have = a ? yoctoToMilli(a.amount) : 0;
  if (!a) {
    console.log(`${acct}: create with ${target / 1000} NEAR`);
    if (!dry) {
      const k = await newKey();
      writeFileSync(join(keysDir, `${acct}.json`), JSON.stringify({ account_id: acct, public_key: k.publicKey, private_key: k.secretKey }), { mode: 0o600 });
      const r = await near.send(HOUSE, house, acct, [action.createAccount(), action.transfer(milliToYocto(target)), action.addFullKey(k.publicKey)]);
      console.log("  ", near.explorer(r.hash));
    }
  } else if (have < target) {
    if (!existsSync(join(keysDir, `${acct}.json`))) throw new Error(`no key for ${acct}`);
    console.log(`${acct}: top up ${have / 1000} -> ${target / 1000} NEAR`);
    if (!dry) {
      const r = await near.send(HOUSE, house, acct, [action.transfer(milliToYocto(target - have))]);
      console.log("  ", near.explorer(r.hash));
    }
  } else console.log(`${acct}: has ${have / 1000} NEAR, ok`);
}

if (!dry) await new Promise((ok) => setTimeout(ok, 2500));
const now = Date.now();
for (const n of world.roster) {
  const a = await near.account(`npc-${n.id}.${HOUSE}`);
  const bankroll = Math.max(0, (a ? yoctoToMilli(a.amount) : 0) - RESERVE);
  n.bankroll = bankroll;
  n.shares = bankroll;
  n.holders = { house: bankroll };
  n.status = bankroll >= eco.BROKE_BELOW ? "open" : "retired";
  delete n.closedAt;
  n.challenges = [];
  n.history = [{ t: now, bankroll, rating: Math.round(n.rating) }];
  console.log(`${n.id}: bankroll ${bankroll / 1000} NEAR, ${n.status}`);
}
world.feed.push({ t: now, text: "Economy moved on-chain: every fighter's bankroll is now its real NEAR account balance" });
world.simDays = 0;
world.clockOffsetMs = 0;
if (!dry) writeFileSync(worldFile, JSON.stringify(world));
const h = await near.account(HOUSE);
console.log(`house ${HOUSE}: ${yoctoToMilli(h.amount) / 1000} NEAR`);
