// Record simulated weeks of the NPC economy for the hosted demo.
// On testnet the ladder plays one real match every 15 minutes, so a week
// cannot be skipped there. This runs the local build (same economy code, local
// mirror of the contract) from a fresh start, presses "Fast-forward a week" and
// saves what the page needs to replay it: web/demo/week-<n>.json.
//   node scripts-record-week.mjs [count=3]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COUNT = Number(process.argv[2] ?? 3);

async function recordOne(n) {
  const data = mkdtempSync(join(tmpdir(), "noref-week-"));
  const port = 18800 + n;
  const srv = spawn(process.execPath, ["server/main.ts"], { cwd: new URL(".", import.meta.url), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA: data, CHAIN: "" }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(base + "/api/state");
        break;
      } catch {
        await new Promise((ok) => setTimeout(ok, 250));
      }
    }
    const ff = await fetch(base + "/api/fastforward", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ days: 7 }) }).then((r) => r.json());
    if (ff.error) throw new Error(ff.error);
    const s = await fetch(base + "/api/state").then((r) => r.json());
    const week = {
      note: "Recorded run of the local build (same economy code as the hosted demo, local mirror of the contract). Not on NEAR testnet. Reproduce: npm start, then Fast-forward a week.",
      recorded: new Date().toISOString(),
      days: ff.days,
      played: ff.played,
      roster: s.roster.map((r) => ({ id: r.id, name: r.name, status: r.status, history: r.history })),
      feed: s.feed,
    };
    const out = new URL(`./web/demo/week-${n}.json`, import.meta.url);
    writeFileSync(out, JSON.stringify(week) + "\n");
    const broke = s.feed.filter((f) => /went broke/i.test(f.text)).length;
    console.log(`week-${n}.json: ${week.played} matches, ${week.roster.map((r) => r.history.length).join("/")} points, ${broke} bankruptcies, ${s.feed.length} feed lines`);
  } finally {
    srv.kill();
    rmSync(data, { recursive: true, force: true });
  }
}

for (let n = 1; n <= COUNT; n++) await recordOne(n);
