// Static copy of the web client for Vercel: app/web plus app/shared, nothing
// else. The game server stays on the VPS; the page calls it cross-origin.
//   node scripts-vercel-dist.mjs && cd dist-vercel && npx vercel deploy --prod
import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const out = new URL("./dist-vercel/", import.meta.url);
// keep .vercel (the project link), replace everything else
if (existsSync(out)) for (const f of readdirSync(out)) if (f !== ".vercel") rmSync(new URL(f, out), { recursive: true, force: true });
cpSync(new URL("./web/", import.meta.url), out, { recursive: true, filter: (p) => !p.endsWith(".DS_Store") });
cpSync(new URL("./shared/", import.meta.url), new URL("./shared/", out), { recursive: true, filter: (p) => !p.endsWith(".DS_Store") });
writeFileSync(
  new URL("./vercel.json", out),
  JSON.stringify({ headers: [{ source: "/(.*)", headers: [{ key: "cache-control", value: "no-cache" }] }] }, null, 2) + "\n",
);
writeFileSync(new URL("./.vercelignore", out), ".env*\n.gitignore\n");
console.log("dist-vercel ready");
