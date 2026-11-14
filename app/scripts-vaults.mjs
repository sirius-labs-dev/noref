// Move NPC fighters onto the fighter vault contract (contracts/fighter).
// Testnet only. Run with the game server stopped, where the NPC keys live:
//
//   node scripts-vaults.mjs --wasm=path/to/noref_fighter.wasm --npc=vex [--npc=pip ...]
//     1. the house tops the NPC up by the vault's storage cost
//     2. the NPC deploys the vault on its own account and initialises it with
//        the share register the server kept so far (data/testnet/world.json)
//     3. the NPC adds a function-call key that can only call its own play_*
//        methods; the server switches to that key (.keys/<npc>.json); the old
//        full-access key is kept aside in .keys/<npc>.full.json
//   node scripts-vaults.mjs --delete-keys --npc=vex [...]
//     4. the NPC deletes its full-access key: from then on nobody, us
//        included, can move its money except by the vault's rules
//
// Each step checks the chain and skips what is already done.
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { Near, keyFromSecret, newKey, action, TGAS, milliToYocto, yoctoToMilli } from "./shared/near.js";
import { MIN_STAKE } from "./shared/economy.js";

const args = process.argv.slice(2);
const arg = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const npcs = args.filter((a) => a.startsWith("--npc=")).map((a) => a.slice(6));
const DELETE = args.includes("--delete-keys");
const HOUSE = process.env.HOUSE ?? "noref.testnet";
const ARENA = process.env.CONTRACT ?? "arena.noref.testnet";
const KEYS = new URL("../.keys/", import.meta.url);
const WORLD = new URL(process.env.WORLD ?? "./data/testnet/world.json", import.meta.url);
const near = new Near(process.env.RPC ?? "https://rpc.testnet.fastnear.com");
const PLAY = ["play_create", "play_join", "play_claim", "play_confirm", "play_cancel", "play_dispute"];
const RESERVE = 100; // milliNEAR the vault keeps for its own gas
const DIV_AT = Number(process.env.DIVIDEND_AT ?? 3000);
const DIV_KEEP = Number(process.env.DIVIDEND_KEEP ?? 2000);

if (!npcs.length) throw new Error("name at least one --npc=<id>");
const keyFile = (acct, suffix = "") => new URL(`${acct}${suffix}.json`, KEYS);
const load = async (f) => (existsSync(f) ? keyFromSecret(JSON.parse(readFileSync(f, "utf8")).private_key) : null);
const save = (f, acct, k) => writeFileSync(f, JSON.stringify({ account_id: acct, public_key: k.publicKey, private_key: k.secretKey }), { mode: 0o600 });
const keys = async (acct) => (await near.call("query", { request_type: "view_access_key_list", finality: "final", account_id: acct })).keys;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

const house = await load(keyFile(HOUSE));
if (!house) throw new Error(`no key for ${HOUSE}`);
const world = JSON.parse(readFileSync(WORLD, "utf8"));

for (const id of npcs) {
  const acct = `npc-${id}.${HOUSE}`;
  const n = world.roster.find((r) => r.id === id);
  if (!n) throw new Error(`no NPC ${id} in the world file`);
  let a = await near.account(acct);
  if (!a) throw new Error(`${acct} does not exist`);

  if (DELETE) {
    const full = await load(keyFile(acct, ".full"));
    if (!full) {
      console.log(`${acct}: no .full.json key kept aside; nothing to delete`);
      continue;
    }
    if (a.code_hash === "11111111111111111111111111111111") throw new Error(`${acct} has no vault: refusing to delete its key`);
    const before = await keys(acct);
    const fc = before.filter((k) => k.access_key.permission !== "FullAccess");
    if (!fc.length) throw new Error(`${acct} has no function-call key: refusing`);
    const r = await near.send(acct, full, acct, [action.deleteKey(full.publicKey)]);
    await wait(2000);
    const after = await keys(acct);
    if (after.some((k) => k.access_key.permission === "FullAccess")) throw new Error(`${acct} still has a full-access key`);
    rmSync(keyFile(acct, ".full"));
    console.log(`${acct}: full-access key deleted (${near.explorer(r.hash)}); keys left: ${after.map((k) => Object.keys(k.access_key.permission)[0] ?? k.access_key.permission).join(", ")}`);
    continue;
  }

  // 1-2. deploy + init, unless the vault is already there
  if (a.code_hash === "11111111111111111111111111111111") {
    const wasmPath = arg("wasm");
    if (!wasmPath) throw new Error("--wasm=<noref_fighter.wasm> is needed to deploy");
    const code = readFileSync(wasmPath);
    const full = (await load(keyFile(acct, ".full"))) ?? (await load(keyFile(acct)));
    if (!full) throw new Error(`no key for ${acct}`);
    // storage for the code and a little state, plus the vault's gas reserve
    const need = Math.ceil((code.length + 2000) / 100) + RESERVE; // 1 milliNEAR per 100 bytes
    const t = await near.send(HOUSE, house, acct, [action.transfer(milliToYocto(need))]);
    console.log(`${acct}: house sent ${need / 1000} NEAR for storage + gas (${near.explorer(t.hash)})`);
    const holders = Object.entries(n.holders ?? {})
      .map(([who, s]) => [who === "house" ? HOUSE : who, String(Math.floor(Number(s)))])
      .filter(([, s]) => s !== "0");
    const init = {
      name: n.name,
      arena: ARENA,
      founder: HOUSE,
      holders,
      min_stake: String(milliToYocto(MIN_STAKE)),
      risk_share: 10,
      reserve: String(milliToYocto(RESERVE)),
      div_at: String(milliToYocto(DIV_AT)),
      div_keep: String(milliToYocto(DIV_KEEP)),
    };
    const r = await near.send(acct, full, acct, [action.deploy(code), action.call("new", init, 100n * TGAS)]);
    console.log(`${acct}: vault deployed and initialised with ${holders.length} holder(s) (${near.explorer(r.hash)})`);
    a = await near.account(acct);
  } else console.log(`${acct}: vault already deployed`);

  // 3. the play-only key, and the server switches to it
  const cur = await keys(acct);
  const hasFc = cur.some((k) => k.access_key.permission?.FunctionCall?.receiver_id === acct);
  if (!hasFc) {
    const full = (await load(keyFile(acct, ".full"))) ?? (await load(keyFile(acct)));
    const fc = await newKey();
    const r = await near.send(acct, full, acct, [action.addFnKey(fc.publicKey, acct, PLAY)]);
    if (!existsSync(keyFile(acct, ".full"))) save(keyFile(acct, ".full"), acct, full);
    save(keyFile(acct), acct, fc);
    console.log(`${acct}: play-only key added (${near.explorer(r.hash)}); the server now signs with it`);
  } else console.log(`${acct}: play-only key already there`);

  const v = await near.view(acct, "info", {});
  console.log(`${acct}: bankroll ${yoctoToMilli(BigInt(v.bankroll)) / 1000} NEAR, ${v.total_shares} shares, ${v.holders} holder(s), closed=${v.closed}`);
}
