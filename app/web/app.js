// NoRef web client. Plain ES modules, no build step, no dependencies.
import { Engine, encodeEntries, encodeLog, flickToImpulse, SIDE } from "./shared/engine.js";
import { MatchClient, newSessionKey, exportSessionKey, importSessionKey } from "./shared/client.js";
import { fmt } from "./shared/economy.js";
import { STYLE_INFO } from "./shared/npc.js";
import { PlayerChain, accountKey } from "./shared/player-chain.js";
import { Fx, sfx, sound, renderTable, drawBall } from "./fx.js";

const $ = (id) => document.getElementById(id);
const ARENA = 256;
const RADIUS = 8;
const CENTER = 128;
const COL = { a: "rgb(255,122,26)", b: "rgb(47,139,255)", peg: "rgb(176,184,204)" };
const ballColor = (i) => (i === 0 ? COL.a : i === 1 ? COL.b : COL.peg);
const ballRGBA = (i, a) => ballColor(i).replace("rgb", "rgba").replace(")", `,${a})`);

const engine = await Engine.load(await (await fetch("engine.wasm")).arrayBuffer());
engine.reset();

let me = localStorage.getItem("noref-me");
let key = null;
let state = null;
let client = null;
let aimResolve = null;
let aim = null; // {angle, power}
let anim = null; // round playback {bytes, tick, end, acc}
let replayView = null; // chain-replay visual {records, bytes, tick, end, acc, data}
let view = engine.getState(); // what the table shows when idle
let es = null;
let npcPhase = "idle"; // idle | thinking | locked
const myBall = () => client?.side ?? 0;
const oppBall = () => 1 - myBall();
const mySideW = () => client?.mySide ?? SIDE.FIRST;
let finalMarks = false;
let week = null; // a recorded simulated week being replayed: {data, t0, t1, until}
let chainInfo = null; // {kind: "local"|"testnet", contract, explorer}
let pc = null; // testnet: the player's own signer (key never leaves this browser)
const testnet = () => chainInfo?.kind === "testnet";
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
const fx = new Fx();

// ---------- api ----------
// Same origin when the game server serves this page; a static copy on Vercel
// talks to the game server on the VPS instead (see vercel.json).
const API = location.hostname.endsWith(".vercel.app") ? "https://noref.63-183-239-145.sslip.io:80" : "";
async function api(path, body) {
  const r = await fetch(API + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}

// ---------- login ----------
async function ensureKey() {
  const saved = localStorage.getItem("noref-key");
  if (saved) {
    try {
      return await importSessionKey(JSON.parse(saved));
    } catch {}
  }
  const k = await newSessionKey();
  localStorage.setItem("noref-key", JSON.stringify(await exportSessionKey(k)));
  return k;
}

async function login(name) {
  key = await ensureKey();
  chainInfo ??= (await api("/api/state")).chain;
  let acct = null;
  if (testnet()) {
    acct = await accountKey(store);
    setStatus("Creating your NEAR testnet account…");
  }
  const r = await api("/api/login", { name, key: key.pubHex, account: acct?.publicKey });
  me = r.me;
  if (testnet()) {
    pc = new PlayerChain({ rpc: API + "/api/rpc", contract: chainInfo.contract, accountId: me, key: acct, api, log: (kind, text, res) => note("tx", text, res.hash) });
    if (r.fresh) note("chain", `Created ${me} on NEAR testnet with ${fmt(r.balance)}. Its key was made in this browser and never leaves it.`, r.tx);
  }
  localStorage.setItem("noref-me", me);
  localStorage.setItem("noref-name", name);
  $("login").hidden = true;
  if (testnet()) setStatus("Press Challenge on a fighter to play for test NEAR, or watch the recorded lie first.");
  connect();
  await refresh();
  await checkJoin();
  refreshStuck();
}

$("loginform").addEventListener("submit", async (e) => {
  e.preventDefault();
  sound.unlock();
  $("loginerr").textContent = "";
  try {
    await login($("name").value.trim().toLowerCase());
  } catch (err) {
    $("loginerr").textContent = err.message;
  }
});

const soundBtn = $("soundbtn");
soundBtn.textContent = sound.on ? "♪ on" : "♪ off";
soundBtn.addEventListener("click", () => {
  sound.unlock();
  soundBtn.textContent = sound.toggle() ? "♪ on" : "♪ off";
});
document.addEventListener("pointerdown", () => sound.unlock(), { once: true });

// ---------- events ----------
function connect() {
  es?.close();
  es = new EventSource(`${API}/api/events?me=${encodeURIComponent(me)}`);
  es.addEventListener("pvp_start", (ev) => onPvpStart(JSON.parse(ev.data)).catch((e) => note("problem", e.message)));
  for (const k of ["round", "committed", "reveal", "round_result", "final", "chain", "note", "oppsig"]) {
    es.addEventListener(k, (ev) => onMatchEvent(k, JSON.parse(ev.data)));
  }
  es.addEventListener("feed", (ev) => {
    addFeed(JSON.parse(ev.data));
    scheduleRefresh();
  });
}

const early = []; // chain events that arrive before the match client exists (create, join)
function onMatchEvent(kind, d) {
  if (kind === "chain" && d.kind === "settle") setTimeout(() => renderBoard(true).catch(() => {}), 1500);
  if (kind === "chain" && (!client || d.match !== client.id)) early.push(d);
  if (!client || d.match !== client.id) return;
  if (kind === "round") npcPhase = "thinking";
  if (kind === "committed" && d.side === client.opp) {
    npcPhase = "locked";
    setStatus(`${client.info.npc.name} has locked in a flick (hidden until you commit). Your move.`);
  }
  if (kind === "reveal") setStatus("Both locked in. Revealing…");
  if (kind === "round_result") npcPhase = "idle";
  if (kind === "final") $("lie").hidden = false;
  if (kind === "chain" && (d.kind === "claim" || d.kind === "settle")) $("lie").hidden = true;
  client.handle(kind, d);
}

// ---------- match ----------
async function challenge(npcId) {
  if (!me) return;
  sound.unlock();
  try {
    const liar = $("liar").checked;
    let r = await api("/api/challenge", { me, npc: npcId, liar });
    $("record").innerHTML = "";
    if (r.open) {
      // testnet: we lock our own stake by signing `create` here
      setStatus(`Signing: lock ${fmt(r.stake)} in ${r.open.contract}…`);
      const o = await pc.open(r.open);
      note("tx", `You signed create: match #${o.id}, ${fmt(r.stake)} locked`, o.hash);
      setStatus("Waiting for the NPC to join on-chain…");
      r = await api("/api/opened", { me, id: o.id, tx: o.hash });
    }
    note("you", `You opened match #${r.match.id} vs ${r.match.npc.name} for ${fmt(r.stake)} each.` + (liar ? " This NPC will lie about the result." : ""));
    await beginMatch(r.match, r.stake);
  } catch (e) {
    note("problem", e.message);
  }
}

/** Set up the table and our MatchClient for a match against an NPC or a person. */
async function beginMatch(match, stake) {
  clearStage();
  setPot(2 * stake);
  const pvp = !!match.pvp;
  client = new MatchClient({ engine, api, me, key, info: match, aim: waitForAim, log: onClientLog, chain: pc?.opsFor(match.id), claimer: pvp && match.side === 0, claimDelayMs: testnet() ? 6000 : 3000 });
  early.splice(0).filter((e) => e.match === match.id && e.kind !== "create").forEach((e) => note("chain", e.text, e.tx));
  view = client.table;
  finalMarks = false;
  replayView = null;
  fx.clearTrails();
  const short = (a) => a.replace(/\.local$/, "").replace(/\.noref\.testnet$/, "");
  // the scorebug is positional: orange (ball 0, creator) left, blue right
  $("youname").textContent = pvp ? (match.side === 0 ? "You" : match.players[0]) : short(me);
  $("npcname").textContent = pvp ? (match.side === 1 ? "You" : match.players[1]) : match.npc.name;
  setRound(0, match.rounds);
  updateDist(view);
  fx.show(`vs ${match.npc.name}`, { sub: `${fmt(2 * stake)} pot · ${match.rounds} rounds${pvp ? ` · you are ${match.side === 0 ? "orange" : "blue"}` : ""}`, dur: 2200 });
  $("friendlink").hidden = true;
  await refresh();
}

function setRound(i, n) {
  $("round").textContent = i < n ? `${i + 1}/${n}` : "END";
  $("pips").innerHTML = Array.from({ length: n }, (_, k) => `<i class="${k < i ? "done" : k === i ? "now" : ""}"></i>`).join("");
}

function waitForAim(eng, ctx) {
  view = eng.getState();
  aim = null;
  setRound(ctx.round, ctx.rounds);
  fx.show(ctx.round === ctx.rounds - 1 ? "Final round" : `Round ${ctx.round + 1}`, { dur: 1100 });
  sfx.round();
  setStatus(`Drag back from your ${myBall() === 0 ? "orange" : "blue"} ball to aim. Release, then Flick.`);
  setButtons(true);
  return new Promise((resolve) => {
    aimResolve = resolve;
    let lastLeft = 99;
    const left = () => Math.max(0, Math.round((ctx.deadline - Date.now()) / 1000));
    const timer = setInterval(() => {
      if (!aimResolve) return clearInterval(timer);
      const l = left();
      $("power").textContent = (aim ? `${Math.round(aim.power * 100)}% · ` : "") + `${l}s`;
      if (l <= 5 && l < lastLeft) sfx.tick();
      lastLeft = l;
      if (l <= 1) finishAim(aim);
    }, 250);
  });
}

function finishAim(choice) {
  if (!aimResolve) return;
  const r = aimResolve;
  aimResolve = null;
  setButtons(false);
  $("power").textContent = "";
  setStatus(choice ? "Flick locked in. Waiting for the reveal…" : "Passing this round…");
  if (choice) sfx.commit();
  r(choice);
}

$("flick").addEventListener("click", () => finishAim(aim));
$("pass").addEventListener("click", () => finishAim(null));
$("lie").addEventListener("click", async () => {
  $("lie").hidden = true;
  try {
    await client.falseClaim();
    note("you", "You claimed a win. The NPC has your signature on every round…");
  } catch (e) {
    note("problem", e.message);
  }
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && aimResolve && aim) finishAim(aim);
});

function setButtons(on) {
  $("flick").disabled = !on;
  $("pass").disabled = !on;
}
function setStatus(t) {
  $("status").textContent = t;
}

function onClientLog(kind, text, data) {
  if (kind === "round" && data) {
    engine.setState(data.roundStart);
    const before = engine.balls();
    engine.tick(encodeEntries(data.entries), data.tick);
    const after = engine.balls();
    for (const e of data.entries) {
      const b = after[e.ball];
      sfx.flick(Math.min(1, Math.hypot(b.vx, b.vy) / 12));
    }
    detectHits(before, after);
    anim = { bytes: engine.getState(), tick: data.tick + 1, end: data.tick + client.R, acc: 0 };
    setStatus("Round playing out…");
    note("check", client.info.pvp ? `Round ${data.tick / client.R + 1}: ${client.info.npc.name}'s reveal matches its commit ✓ · you signed the log ✓` : `Round ${data.tick / client.R + 1}: NPC reveal matches its commit ✓ · NPC signature ✓ · ${client.demo ? "the player" : "you"} countersigned ✓`);
    return;
  }
  if (kind === "commit") return note("check", text);
  if (kind === "final") {
    setRound(client.info.rounds, client.info.rounds);
    finalMarks = true;
    setStatus(text + ". Waiting for a claim…");
  }
  if (kind === "chain") {
    note(data.kind === "replay" ? "replay" : data.kind === "reject" ? "reject" : "chain", text, data.tx);
    if (data.kind === "claim") {
      const honest = data.data.winner === client.verdict;
      fx.show(data.data.by === me ? "You claim the win" : `${client.info.npc.name}: "${data.data.winner === SIDE.DRAW ? "draw" : data.data.winner === mySideW() ? "you won" : "I won"}"`, {
        sub: honest ? "matches your replay" : "contradicts your replay",
        color: honest ? "#fff" : "#ffb4a8",
        dur: 1800,
      });
      if (!honest && data.data.by !== me) sfx.alarm();
      if (!honest) showClaimCard(data.data.by, data.data.winner);
    }
    if (data.kind === "replay") startReplayVisual(data.data, text);
    if (data.kind === "settle") onSettle(data, text);
    return;
  }
  note(kind, text);
}

function onSettle(e, text) {
  setStatus(text);
  const w = e.data.winner;
  const delay = replayView ? 2600 : 200;
  setTimeout(() => {
    showVerdict(w, text, e.tx);
    potFlight(w);
    if (w === mySideW()) {
      fx.confetti(CENTER, CENTER + 20, [COL.a, "#ffd166", "#ffffff", "#06d6a0"]);
      fx.show(client?.demo ? "The player wins" : "You win", { sub: text, color: "#ffd166", dur: 2600 });
      sfx.win();
      setTimeout(() => sfx.coins(), 350);
    } else if (w !== SIDE.DRAW) {
      fx.show(`${client.info.npc.name} wins`, { sub: text, color: "#bcd4ff", dur: 2400 });
      sfx.lose();
    } else {
      fx.show("Draw", { sub: text, dur: 2200 });
    }
  }, delay);
  scheduleRefresh();
}

// ---------- broadcast layers: pot, chain review band, verdict bar ----------
function setPot(m) {
  $("pot").textContent = m ? `${(m / 1000).toFixed(2)} Ⓝ` : "–";
}
function clearStage() {
  document.body.classList.remove("reviewing");
  $("review").hidden = true;
  $("verdict").hidden = true;
  $("claimcard").hidden = true;
  $("claimcard").classList.remove("flipped");
  $("checks").hidden = true;
}

const sideLabel = (w) => (w === SIDE.DRAW ? "Draw" : w === mySideW() ? (client?.demo ? "Player won" : "You won") : `${client?.info?.npc?.name ?? "NPC"} won`);

/** A claim that contradicts our replay: show it as a card, flipped later by the contract. */
function showClaimCard(by, winner) {
  const c = $("claimcard");
  c.classList.remove("flipped");
  $("cc-by").textContent = by === me ? "You claimed" : `${by === client?.info?.npc?.id ? client.info.npc.name : by} claimed`;
  $("cc-claim").textContent = `“${sideLabel(winner)}”`;
  $("cc-truth").textContent = "…";
  c.hidden = false;
}

/** The contract's checks, ticked off while the replay plays. */
let checkTimers = [];
function startChecks(data, text) {
  checkTimers.forEach(clearTimeout);
  const ul = $("checks");
  const gas = text.match(/\(([\d.]+) Tgas\)/)?.[1];
  const lines = [
    ["ok", "input log signed by both, every round"],
    ["ok", "opponent signature matches the log"],
    ["wait", `replaying ${client?.D ?? 1080} ticks on NEAR…`, "replay"],
  ];
  ul.innerHTML = "";
  lines.forEach(([cls, t, id], i) => {
    const li = document.createElement("li");
    li.className = cls;
    li.textContent = t;
    if (id) li.dataset.id = id;
    ul.append(li);
    checkTimers.push(setTimeout(() => li.classList.add("on"), 250 + i * 450));
  });
  ul.dataset.gas = gas ?? "";
  ul.hidden = false;
}
function finishReview(d) {
  const ul = $("checks");
  const r = ul.querySelector('[data-id="replay"]');
  if (r) {
    r.className = "ok on";
    r.textContent = `${client?.D ?? 1080} ticks replayed${ul.dataset.gas ? ` · ${ul.dataset.gas} Tgas` : ""}`;
  }
  const li = document.createElement("li");
  li.className = d.overturned ? "bad" : "ok";
  li.textContent = d.overturned ? `claim contradicts the replay: ${sideLabel(d.winner).toLowerCase()}` : "the claim matches the replay";
  ul.append(li);
  setTimeout(() => li.classList.add("on"), 50);
  if (!$("claimcard").hidden) {
    $("cc-truth").textContent = sideLabel(d.winner);
    $("cc-ticks").textContent = `${client?.D ?? 1080} ticks on NEAR`;
    setTimeout(() => $("claimcard").classList.add("flipped"), 250);
  }
}

/** The pot flies from the scorebug to the winner. */
function potFlight(w) {
  if (w !== SIDE.FIRST && w !== SIDE.SECOND) return;
  const from = $("pot").getBoundingClientRect();
  const team = document.querySelector(w === SIDE.FIRST ? ".sb-team.a" : ".sb-team.b");
  const to = team.getBoundingClientRect();
  for (let i = 0; i < 7; i++) {
    const c = document.createElement("div");
    c.className = "coin";
    c.style.left = `${from.left + from.width / 2}px`;
    c.style.top = `${from.top + from.height / 2}px`;
    document.body.append(c);
    setTimeout(() => {
      c.style.transform = `translate(${to.left + to.width / 2 - (from.left + from.width / 2) + (Math.random() - 0.5) * 20}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px) scale(0.7)`;
      c.style.opacity = "0";
    }, 30 + i * 70);
    setTimeout(() => c.remove(), 1400 + i * 70);
  }
  setTimeout(() => {
    team.classList.remove("win");
    void team.offsetWidth;
    team.classList.add("win");
    $("pot").textContent = "0.00 Ⓝ";
  }, 900);
}
function showVerdict(w, text, tx) {
  const reviewed = document.body.classList.contains("reviewing");
  const who = sideLabel(w) + ".";
  const el = $("verdict");
  el.replaceChildren();
  const lab = document.createElement("div");
  lab.className = "lab";
  lab.textContent = reviewed ? "Verdict" : "Final";
  const txt = document.createElement("div");
  txt.className = "txt";
  const span = document.createElement("span");
  const b = document.createElement("b");
  b.textContent = who;
  const m = document.createElement("span");
  m.className = "muted";
  m.textContent = " " + text;
  span.append(b, m);
  txt.append(span);
  const explorer = chainInfo?.explorer || (demoOn ? DEMO_EXPLORER : null);
  if (tx && explorer) {
    const a = document.createElement("a");
    a.href = `${explorer}/txns/${tx}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `tx ${tx.slice(0, 6)}… ↗`;
    txt.append(a);
  }
  el.append(lab, txt);
  el.hidden = false;
  setTimeout(() => {
    document.body.classList.remove("reviewing");
    $("review").hidden = true;
  }, 1800);
}

/** NEAR replays the whole match: show it, fast, with the verdict stamped at the end. */
function startReplayVisual(data, text = "") {
  startChecks(data, text);
  document.body.classList.add("reviewing");
  $("reviewsub").textContent = "the contract is replaying the signed log";
  $("review").hidden = false;
  $("verdict").hidden = true;
  engine.reset();
  replayView = { records: client.records.filter((r) => r.tick <= data.signedTick), bytes: engine.getState(), tick: 0, end: client.D, acc: 0, data };
  fx.clearTrails();
  sfx.scan();
  setStatus("NEAR is replaying the whole match from the signed log…");
}

function note(kind, text, tx) {
  const li = document.createElement("li");
  li.className = kind;
  const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  li.innerHTML = `<span class="t">${t}</span>`;
  li.append(document.createTextNode(text));
  const explorer = chainInfo?.explorer || (demoOn ? DEMO_EXPLORER : null);
  if (tx && explorer) {
    const a = document.createElement("a");
    a.href = `${explorer}/txns/${tx}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "tx";
    a.textContent = `tx ${tx.slice(0, 6)}… ↗`;
    li.append(" ", a);
  }
  const ol = $("record");
  if (ol.firstElementChild?.classList.contains("muted")) ol.innerHTML = "";
  ol.append(li);
  ol.scrollTop = ol.scrollHeight;
}

// ---------- physics playback + hit detection (visual only) ----------
function detectHits(before, after) {
  for (let i = 0; i < after.length; i++) {
    const b0 = before[i];
    const b1 = after[i];
    const dv = Math.hypot(b1.vx - b0.vx * 0.9375, b1.vy - b0.vy * 0.9375);
    if (dv < 0.25) continue;
    // wall?
    const atWall = b1.x < 1.5 || b1.x > ARENA - 1.5 || b1.y < 1.5 || b1.y > ARENA - 1.5;
    if (atWall && (Math.sign(b1.vx) !== Math.sign(b0.vx) || Math.sign(b1.vy) !== Math.sign(b0.vy))) {
      fx.impact(b1.x, b1.y, Math.min(1, dv / 10), "rgba(255,255,255,0.8)");
      sfx.thud(dv / 10);
      continue;
    }
    // collision with a neighbour (count each pair once)
    for (let j = i + 1; j < after.length; j++) {
      const d = Math.hypot(after[j].x - b1.x, after[j].y - b1.y);
      if (d < 2 * RADIUS + 1.5) {
        const s = Math.min(1, dv / 8);
        fx.impact((b1.x + after[j].x) / 2, (b1.y + after[j].y) / 2, s, i < 2 ? ballColor(i) : ballColor(j));
        sfx.clack(s);
        break;
      }
    }
  }
}

function advance(play, perFrame) {
  play.acc += perFrame;
  let n = Math.floor(play.acc);
  play.acc -= n;
  engine.setState(play.bytes);
  while (n-- > 0 && play.tick < play.end) {
    const before = engine.balls();
    let entries = new Uint8Array(0);
    if (play.records) {
      const rec = play.records.find((r) => r.tick === play.tick);
      if (rec) entries = encodeEntries(rec.entries);
    }
    engine.tick(entries, play.tick);
    if (play === anim || play.tick % 2 === 0) detectHits(before, engine.balls());
    play.tick++;
  }
  play.bytes = engine.getState();
  return play.tick >= play.end;
}

// ---------- drawing ----------
const cv = $("table");
const g = cv.getContext("2d");
let S = 0;
let tableImg = null;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function resize() {
  const w = Math.round(cv.getBoundingClientRect().width * Math.min(2, devicePixelRatio || 1));
  if (w && w !== S) {
    S = cv.width = cv.height = w;
    tableImg = renderTable(S, { felt: css("--felt"), felt2: css("--felt-2"), ringOuter: "rgba(47,139,255,0.20)", ringInner: "rgba(255,122,26,0.24)" });
  }
}
new ResizeObserver(resize).observe(cv);

function updateDist(bytes) {
  engine.setState(bytes);
  $("distA").textContent = Math.sqrt(engine.dist2(0)).toFixed(1);
  $("distB").textContent = Math.sqrt(engine.dist2(1)).toFixed(1);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  resize();
  if (!S) return requestAnimationFrame(frame);
  const k = S / ARENA;

  // simulation playback, time based: 60 ticks per second
  if (replayView) {
    const done = advance(replayView, dt * 60 * 9);
    view = replayView.bytes;
    if (done) {
      const d = replayView.data;
      replayView = null;
      if (client) view = client.table;
      fx.show(d.overturned ? "LIE CAUGHT" : "CLAIM CORRECT", { stamp: true, color: d.overturned ? "#ff3b3b" : "#1fd17a", dur: 4000, sub: d.overturned ? "claim overturned by the contract's replay" : "the replay agrees with the claim" });
      $("reviewsub").textContent = d.overturned ? "claim overturned · paying the real winner" : "claim confirmed by the replay";
      finishReview(d);
      sfx.stamp();
    }
    updateDist(view);
  } else if (anim) {
    const done = advance(anim, dt * 60);
    view = anim.bytes;
    if (done) {
      anim = null;
      if (client) view = client.table;
    }
    updateDist(view);
  }
  fx.step();

  g.save();
  if (fx.shake) g.translate((Math.random() - 0.5) * fx.shake, (Math.random() - 0.5) * fx.shake);
  g.drawImage(tableImg, 0, 0);

  engine.setState(view);
  const balls = engine.balls();
  balls.forEach((b, i) => fx.trail(i, b.x, b.y, Math.hypot(b.vx, b.vy) > 0.3));
  fx.draw(g, k, ballRGBA);

  // aim preview
  if (aimResolve && aim) drawAim(balls, k);

  // end-of-match distance marks
  if (finalMarks && !anim && !replayView) {
    for (const i of [0, 1]) {
      const b = balls[i];
      g.strokeStyle = ballRGBA(i, 0.8);
      g.setLineDash([5, 5]);
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(CENTER * k, CENTER * k);
      g.lineTo(b.x * k, b.y * k);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = "rgba(255,255,255,0.95)";
      g.font = `700 ${Math.round(S / 40)}px ui-monospace, monospace`;
      g.textAlign = "center";
      g.fillText(Math.hypot(b.x - CENTER, b.y - CENTER).toFixed(1), ((b.x + CENTER) / 2) * k, ((b.y + CENTER) / 2) * k - 6);
    }
  }

  // balls
  balls.forEach((b, i) => {
    const glow = i === myBall() && aimResolve ? 0.6 + 0.4 * Math.sin(now / 250) : 0;
    drawBall(g, b.x * k, b.y * k, RADIUS * k, ballColor(i), { glow, label: i === 0 ? "A" : i === 1 ? "B" : "" });
  });

  // NPC state badge
  if (client && (npcPhase === "thinking" || npcPhase === "locked") && !anim) {
    const b = balls[oppBall()];
    const txt = npcPhase === "locked" ? "🔒 locked" : "thinking" + ".".repeat(1 + (Math.floor(now / 350) % 3));
    g.font = `600 ${Math.round(S / 46)}px ui-sans-serif, system-ui, sans-serif`;
    const w = g.measureText(txt).width + 16;
    const x = b.x * k - w / 2;
    const y = b.y * k - RADIUS * k - S / 22;
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.beginPath();
    g.roundRect(x, y, w, S / 30, 8);
    g.fill();
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(txt, b.x * k, y + S / 60);
  }

  // chain replay overlay
  if (replayView) {
    const p = replayView.tick / replayView.end;
    const y = (now / 6) % S;
    g.fillStyle = "rgba(120,200,255,0.06)";
    g.fillRect(0, 0, S, S);
    g.fillStyle = "rgba(160,220,255,0.25)";
    g.fillRect(0, y, S, 3);
    g.fillStyle = "rgba(0,0,0,0.6)";
    g.fillRect(0, S - S / 12, S, S / 12);
    g.fillStyle = "rgba(120,200,255,0.9)";
    g.fillRect(0, S - 4, S * p, 4);
    g.fillStyle = "#fff";
    g.font = `700 ${Math.round(S / 38)}px ui-monospace, monospace`;
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(`NEAR replaying the signed log · tick ${replayView.tick}/${replayView.end}`, S / 40, S - S / 24);
  }

  fx.drawBanner(g, S);
  g.restore();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function drawAim(balls, k) {
  const me0 = myBall();
  const a0 = balls[me0];
  const ang = (aim.angle * Math.PI) / 180;
  const pull = aim.power * 40;
  const hue = 120 - 120 * aim.power;
  // rubber band
  g.strokeStyle = `hsla(${hue},90%,60%,0.9)`;
  g.lineWidth = Math.max(2, k * 1.2);
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(a0.x * k, a0.y * k);
  g.lineTo((a0.x - Math.cos(ang) * pull) * k, (a0.y - Math.sin(ang) * pull) * k);
  g.stroke();
  // power ring
  g.beginPath();
  g.arc(a0.x * k, a0.y * k, (RADIUS + 5) * k, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * aim.power);
  g.strokeStyle = `hsla(${hue},90%,60%,0.95)`;
  g.lineWidth = Math.max(3, k * 1.6);
  g.stroke();
  // predicted path (opponent assumed still)
  engine.setState(view);
  const { dvx, dvy } = flickToImpulse(engine, aim.angle, aim.power);
  engine.tick(encodeEntries([{ ball: me0, dvx, dvy }]), 0);
  let prev = engine.balls();
  for (let i = 0; i < 150; i++) {
    engine.tick(new Uint8Array(0), i + 1);
    const bs = engine.balls();
    const b = bs[me0];
    if (i % 3 === 0) {
      g.beginPath();
      g.arc(b.x * k, b.y * k, Math.max(1.5, 2.6 * (1 - i / 150)) * k * 0.6, 0, Math.PI * 2);
      g.fillStyle = `rgba(255,190,120,${0.75 * (1 - i / 150)})`;
      g.fill();
    }
    // show where other balls would be pushed
    for (let j = 0; j < bs.length; j++) {
      if (j !== me0 && Math.hypot(bs[j].vx, bs[j].vy) > 0.5 && Math.hypot(prev[j].vx, prev[j].vy) < 0.5) {
        g.beginPath();
        g.arc(bs[j].x * k, bs[j].y * k, RADIUS * k + 3, 0, Math.PI * 2);
        g.strokeStyle = "rgba(255,255,255,0.6)";
        g.lineWidth = 1.5;
        g.stroke();
      }
    }
    prev = bs;
    if (engine.atRest()) break;
  }
  // final resting spot
  engine.runTicks(400, 200);
  const end = engine.balls()[me0];
  g.beginPath();
  g.arc(end.x * k, end.y * k, RADIUS * k, 0, Math.PI * 2);
  g.strokeStyle = "rgba(255,190,120,0.8)";
  g.setLineDash([4, 4]);
  g.lineWidth = 2;
  g.stroke();
  g.setLineDash([]);
}

// aiming: drag back from your ball (slingshot)
function toArena(ev) {
  const r = cv.getBoundingClientRect();
  return { x: ((ev.clientX - r.left) / r.width) * ARENA, y: ((ev.clientY - r.top) / r.height) * ARENA };
}
let dragging = false;
cv.addEventListener("pointerdown", (ev) => {
  if (!aimResolve) return;
  dragging = true;
  cv.setPointerCapture(ev.pointerId);
  onDrag(ev);
});
cv.addEventListener("pointermove", (ev) => dragging && onDrag(ev));
cv.addEventListener("pointerup", () => (dragging = false));
function onDrag(ev) {
  const p = toArena(ev);
  engine.setState(view);
  const b = engine.balls()[myBall()];
  const dx = b.x - p.x;
  const dy = b.y - p.y;
  const len = Math.hypot(dx, dy);
  if (len < 3) return;
  aim = { angle: (Math.atan2(dy, dx) * 180) / Math.PI, power: Math.min(1, len / 40) };
  $("power").textContent = `${Math.round(aim.power * 100)}%`;
}

// ---------- roster, economy ----------
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 400);
}

async function refresh() {
  state = await api(`/api/state?me=${encodeURIComponent(me ?? "")}`);
  chainInfo = state.chain;
  renderFaucet();
  renderBadge();
  $("hero").hidden = !!me;
  renderBoard().catch(() => {});
  renderAccount();
  renderRoster();
  renderChart();
  renderFeed();
}

/** The house funds every new name; say so before someone tries and fails. */
function renderFaucet() {
  const el = $("faucetnote");
  const f = chainInfo?.faucet;
  el.hidden = !f || f === "ok";
  el.classList.toggle("empty", f === "empty");
  el.textContent =
    f === "empty"
      ? "The demo faucet is empty right now, so a new name gets no test NEAR. Names already created still work, and the recorded match plays without an account."
      : "The demo faucet is running low; new names may stop getting test NEAR soon.";
}

// ---------- stakes the player can take back ----------
const STUCK = {
  cancel: { label: "Cancel, refund me", done: "your stake came back" },
  refund: { label: "Refund both", done: "both stakes went back" },
  finalize: { label: "Pay out", done: "the contract paid the winner" },
};
async function refreshStuck() {
  if (!testnet() || !me || !pc) return;
  const r = await api(`/api/stuck?me=${encodeURIComponent(me)}`).catch(() => null);
  if (!r) return;
  const skew = Date.now() - r.now;
  const list = $("stucklist");
  list.replaceChildren();
  for (const m of r.stuck) {
    const wait = m.readyAt ? m.readyAt + skew - Date.now() : 0;
    const li = document.createElement("li");
    const info = document.createElement("div");
    const vs = m.opponent ? ` vs ${m.opponent.replace(/\.noref\.testnet$/, "")}` : "";
    info.innerHTML = `<b>#${m.id}</b>${vs} · ${fmt(m.stake)} each<br><span class="muted small"></span>`;
    info.querySelector("span").textContent = m.why + (wait > 0 ? ` · possible in ${Math.ceil(wait / 60_000)} min` : "");
    const b = document.createElement("button");
    b.className = "small";
    b.textContent = STUCK[m.action].label;
    b.disabled = wait > 0;
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.textContent = "Signing…";
      try {
        const t = await pc.call(m.action, { id: String(m.id) });
        note("tx", `You signed ${m.action} for match #${m.id}: ${STUCK[m.action].done}`, t.hash);
      } catch (e) {
        note("problem", `${m.action} for match #${m.id} failed: ${e.message}`);
      }
      await refreshStuck();
      await refresh();
    });
    li.append(info, b);
    list.append(li);
  }
  $("stuckcard").hidden = r.stuck.length === 0;
}
setInterval(() => refreshStuck(), 60_000);

let shownBalance = null;
function renderAccount() {
  const a = $("account");
  if (!state.me) {
    a.innerHTML = "";
    shownBalance = null;
    return;
  }
  const from = shownBalance;
  const to = state.me.balance;
  shownBalance = to;
  a.innerHTML = testnet()
    ? `<a href="${chainInfo.explorer}/address/${state.me.id}" target="_blank" rel="noopener"><b>${state.me.id}</b></a><span>${fmt(state.me.balance)}</span>`
    : `<b>${state.me.id}</b><span>${fmt(state.me.balance)}</span>`;
  const owned = state.roster.filter((n) => (n.holders[state.me.id] ?? 0) > 0);
  if (owned.length) a.insertAdjacentHTML("beforeend", `<span class="port" title="What your shares in fighters are worth now">backing ${owned.length} · ${fmt(owned.reduce((t, n) => t + Math.floor(n.holders[state.me.id] * n.sharePrice), 0))}</span>`);
  // a win: count the balance up and show the gain
  if (from != null && to > from) {
    const span = a.querySelector("span");
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 1000);
      span.textContent = fmt(Math.round(from + (to - from) * (1 - (1 - p) ** 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    const g = document.createElement("span");
    g.className = "gain";
    g.textContent = `+${fmt(to - from)}`;
    a.append(g);
    setTimeout(() => g.remove(), 4000);
  }
}

function renderBadge() {
  const b = $("chainbadge");
  if (testnet()) {
    b.innerHTML = `<a href="${chainInfo.explorer}/address/${chainInfo.contract}" target="_blank" rel="noopener">NEAR testnet · ${chainInfo.contract}</a>`;
    b.title = "Stakes, claims, disputes and payouts are real transactions on the NoRef contract on NEAR testnet.";
  } else {
    b.textContent = "local chain · mirror of contracts/noref";
    b.title = "This build settles on a local mirror of contracts/noref. Run with CHAIN=testnet for real NEAR transactions.";
  }
}
const BACK = () => (testnet() ? 0.1 : 0.5);

const tip = $("tip");
function showTip(ev, lines) {
  tip.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  tip.hidden = false;
  tip.style.left = Math.min(ev.clientX + 12, innerWidth - 340) + "px";
  tip.style.top = ev.clientY + 14 + "px";
}

function renderRoster() {
  const ul = $("roster");
  ul.innerHTML = "";
  const busy = client && !client.settled;
  state.roster.forEach((n, idx) => {
    const li = document.createElement("li");
    li.className = "npc" + (n.status === "open" ? "" : " closed");
    li.style.setProperty("--c", COLORS[idx % COLORS.length]);
    const tr = trendOf(n);
    const mine = state.me ? n.holders[state.me.id] ?? 0 : 0;
    li.innerHTML = `
      <div><span class="name">${n.name}</span>${n.status === "open" ? "" : '<span class="pill closed">closed</span>'}
        <div class="style">${n.style} · ${STYLE_INFO[n.style]}</div>
        ${mine > 0 ? `<div class="mine">you own ${((100 * mine) / n.shares).toFixed(1)}% · worth ${fmt(Math.floor(mine * n.sharePrice))}</div>` : ""}
        <div class="meta">rating ${n.rating} · ${n.wins}W ${n.losses}L ${n.draws}D · bankroll ${testnet() && n.account ? `<a href="${chainInfo.explorer}/address/${n.account}" target="_blank" rel="noopener" title="its real NEAR account">${fmt(n.bankroll)} ↗</a>` : fmt(n.bankroll)}</div>
      </div>
      <div class="price">asks ${fmt(n.stake)}${tr ? `<span class="trend ${tr.pct >= 0 ? "up" : "down"}">${tr.pct >= 0 ? "▲" : "▼"} ${Math.abs(tr.pct).toFixed(0)}%</span>${tr.svg}` : ""}</div>
      <div class="acts">
        <button class="small" data-act="fight" ${n.status !== "open" || n.declined || busy || !state.me ? "disabled" : ""} ${n.declined ? `title="${n.why[n.why.length - 1].replace(/"/g, "&quot;")}"` : ""}>${n.declined ? "Won't play you" : "Challenge"}</button>
        <button class="small ghost" data-act="back" ${!state.me ? "disabled" : ""} title="Buy shares of ${n.name}'s bankroll: its wins raise your share value, and it pays dividends to backers when it grows rich. Cash out any time.">Back with ${BACK()} NEAR</button>
        ${mine > 0 ? `<button class="small ghost" data-act="cash">Cash out ${mine.toFixed(1)} sh (${fmt(Math.floor(mine * n.sharePrice))})</button>` : ""}
      </div>`;
    const price = li.querySelector(".price");
    price.addEventListener("mouseenter", (ev) => showTip(ev, [state.me ? "Why this price, for you:" : "Why this price:", ...n.why]));
    price.addEventListener("mousemove", (ev) => showTip(ev, [state.me ? "Why this price, for you:" : "Why this price:", ...n.why]));
    price.addEventListener("mouseleave", () => (tip.hidden = true));
    li.querySelector('[data-act="fight"]').addEventListener("click", () => challenge(n.id));
    li.querySelector('[data-act="back"]').addEventListener("click", async () => {
      try {
        let tx;
        if (testnet()) {
          // a real transfer into the NPC's own account, signed here
          const r = await pc.transfer(n.account, BigInt(Math.round(BACK() * 1000)) * 10n ** 21n);
          tx = r.hash;
          note("tx", `You sent ${BACK()} NEAR to ${n.account}`, tx);
        }
        await api("/api/sponsor", { me, npc: n.id, amount: BACK(), tx });
        sfx.coins();
        await refresh();
      } catch (e) {
        note("problem", e.message);
      }
    });
    li.querySelector('[data-act="cash"]')?.addEventListener("click", async () => {
      const r = await api("/api/cashout", { me, npc: n.id, shares: mine });
      if (r.tx) note("tx", `${n.name} paid you ${fmt(r.amount)} from ${n.account}`, r.tx);
      sfx.coins();
      await refresh();
    });
    ul.append(li);
  });
  renderTicker();
}

/** Bankroll trend over the fighter's recent history, with a tiny sparkline. */
function trendOf(n) {
  const h = (n.history ?? []).slice(-40).map((x) => x.bankroll);
  if (h.length < 2 || !h[0]) return null;
  const pct = ((h[h.length - 1] - h[0]) / h[0]) * 100;
  const lo = Math.min(...h);
  const hi = Math.max(...h);
  const pts = h.map((v, i) => `${((i / (h.length - 1)) * 70).toFixed(1)},${(16 - ((v - lo) / (hi - lo || 1)) * 14).toFixed(1)}`).join(" ");
  const col = pct >= 0 ? "#1fd17a" : "#ff3b3b";
  return { pct, svg: `<svg class="spark" width="70" height="18" viewBox="0 0 70 18" aria-hidden="true"><polyline fill="none" stroke="${col}" stroke-width="1.5" points="${pts}"/></svg>` };
}

/** Economy ticker: every fighter's price and trend, then the latest feed lines. */
function renderTicker() {
  const t = $("ticktrack");
  if (!t || !state) return;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const items = state.roster.map((n) => {
    const tr = trendOf(n);
    const dir = !tr ? "" : tr.pct >= 0 ? `<span class="up">▲</span>` : `<span class="down">▼</span>`;
    return `<span>${esc(n.name.toUpperCase())} <b>${(n.stake / 1000).toFixed(2)}</b> ${dir}${n.status === "open" ? "" : " closed"}</span>`;
  });
  for (const f of state.feed.slice(-5).reverse()) items.push(`<span>· ${esc(f.text)}${f.url ? ` <a href="${esc(f.url)}" target="_blank" rel="noopener">tx ↗</a>` : ""}</span>`);
  const once = items.join("");
  t.innerHTML = once + once;
}

const COLORS = ["#ffb02e", "#2f8bff", "#1fd17a", "#a855f7", "#ff6bd6", "#14b8a6"];
function renderChart() {
  const c = $("chart");
  const ctx = c.getContext("2d");
  const W = c.width;
  const H = c.height;
  ctx.clearRect(0, 0, W, H);
  // a recorded simulated week replays over the live chart (testnet), see playWeek
  const full = week ? week.data.roster : state.roster;
  const roster = week ? full.map((n) => ({ ...n, history: n.history.filter((h) => h.t <= week.until), status: n.history.at(-1).t <= week.until ? n.status : "open" })) : full;
  const all = full.flatMap((n) => n.history);
  if (!all.length) return;
  const t0 = Math.min(...all.map((h) => h.t));
  const t1 = Math.max(...all.map((h) => h.t), t0 + 1);
  const max = Math.max(...all.map((h) => h.bankroll), 1000);
  ctx.strokeStyle = css("--line");
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = H - 20 - ((H - 30) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.fillStyle = css("--muted");
    ctx.font = "20px ui-monospace, monospace";
    ctx.fillText(((max * i) / 4 / 1000).toFixed(0), 0, y + 6);
  }
  roster.forEach((n, idx) => {
    ctx.strokeStyle = COLORS[idx % COLORS.length];
    ctx.lineWidth = 3;
    ctx.beginPath();
    n.history.forEach((h, i) => {
      const x = 40 + ((W - 50) * (h.t - t0)) / (t1 - t0);
      const y = H - 20 - ((H - 30) * h.bankroll) / max;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  });
  $("legend").innerHTML = roster.map((n, i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${n.name}${n.status === "open" ? "" : " (closed)"}</span>`).join("");
  if (testnet()) {
    $("ff").hidden = false;
    $("ff").textContent = week ? "Back to live" : "Replay a simulated week";
    $("ff").title = week ? "" : "A week of NPC ladder matches recorded from the local build (same economy code, local mirror of the contract), replayed here in a few seconds. Not on testnet.";
    $("simdays").textContent = week
      ? `Recorded simulation, not on testnet: day ${Math.min(week.data.days, Math.floor((week.until - week.t0) / 86_400_000) + 1)} of ${week.data.days}, ${week.data.played} ladder matches`
      : `Fighters play each other on-chain every ${chainInfo.ladderMin ?? 15} min. Bankrolls are their real NEAR balances.`;
  } else $("simdays").textContent = state.simDays ? `${state.simDays} simulated days so far` : "";
}

function addFeed(f) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="t">${new Date(f.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>`;
  li.append(document.createTextNode(f.text));
  if (f.url) {
    const a = document.createElement("a");
    a.href = f.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "tx";
    a.textContent = " tx ↗";
    li.append(a);
  }
  $("feed").prepend(li);
}
function renderFeed() {
  $("feed").innerHTML = "";
  if (!week) return state.feed.forEach(addFeed);
  for (const f of week.data.feed.filter((f) => f.t <= week.until)) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="t">sim day ${Math.floor((f.t - week.t0) / 86_400_000) + 1}</span>`;
    li.append(document.createTextNode(f.text));
    $("feed").prepend(li);
  }
}

// ---------- a recorded simulated week (testnet page) ----------
// On testnet the ladder plays one real match every 15 minutes, so a week cannot
// be skipped. The button replays one of a few weeks recorded from the local
// build with `node scripts-record-week.mjs` (web/demo/week-<n>.json).
async function playWeek() {
  const n = 1 + Math.floor(Math.random() * 3);
  const data = await fetch(`demo/week-${n}.json`).then((r) => r.json());
  const ts = data.roster.flatMap((r) => r.history.map((h) => h.t));
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  week = { data, t0, t1, until: t0 };
  const start = performance.now();
  const DUR = 8000;
  const step = () => {
    if (!week || week.data !== data) return;
    const k = Math.min(1, (performance.now() - start) / DUR);
    week.until = t0 + k * (t1 - t0);
    renderChart();
    renderFeed();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

$("ff").addEventListener("click", async () => {
  if (testnet()) {
    if (week) {
      week = null;
      renderChart();
      renderFeed();
    } else await playWeek().catch((e) => note("problem", e.message));
    return;
  }
  $("ff").disabled = true;
  $("ff").textContent = "Simulating…";
  try {
    await api("/api/fastforward", { days: 7 });
    await refresh();
  } catch (e) {
    note("problem", e.message);
  } finally {
    $("ff").disabled = false;
    $("ff").textContent = "Fast-forward a week";
  }
});

// ---------- person vs person, by invite link ----------
let myInvite = null; // the open invite we created: {id}
const inviteLink = (id) => `${location.origin}${location.pathname}#join=${id}`;
const joinId = () => {
  const m = location.hash.match(/^#join=(\d+)$/);
  return m ? Number(m[1]) : null;
};

$("friendform").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!me) return note("problem", "Pick a name first.");
  sound.unlock();
  $("pvpcreate").disabled = true;
  try {
    let r = await api("/api/pvp/create", { me, amount: Number($("pvpamt").value) });
    if (r.open) {
      setStatus(`Signing: lock ${fmt(r.stake)} in ${r.open.contract}…`);
      const o = await pc.open(r.open);
      note("tx", `You signed create: match #${o.id}, ${fmt(r.stake)} locked, open for a friend`, o.hash);
      r = await api("/api/pvp/opened", { me, id: o.id, tx: o.hash });
    } else note("you", `You opened match #${r.id} for ${fmt(r.stake)} each, open for a friend.`);
    myInvite = { id: r.id };
    $("pvplink").value = inviteLink(r.id);
    $("friendlink").hidden = false;
    setStatus("Send the link to a friend. The match starts when they join.");
  } catch (err) {
    note("problem", err.message);
  } finally {
    $("pvpcreate").disabled = false;
  }
});
$("pvpcopy").addEventListener("click", async () => {
  $("pvplink").select();
  try {
    await navigator.clipboard.writeText($("pvplink").value);
    $("pvpcopy").textContent = "Copied";
    setTimeout(() => ($("pvpcopy").textContent = "Copy"), 1500);
  } catch {}
});
$("pvpcancel").addEventListener("click", async () => {
  if (!myInvite) return;
  try {
    if (testnet()) {
      const r = await pc.call("cancel", { id: String(myInvite.id) });
      note("tx", `You cancelled match #${myInvite.id}; your stake came back`, r.hash);
    }
    await api("/api/pvp/cancel", { me, id: myInvite.id });
    myInvite = null;
    $("friendlink").hidden = true;
    setStatus("Invite cancelled.");
    await refresh();
  } catch (err) {
    note("problem", err.message);
  }
});

/** The host's side: the server says the friend joined. */
async function onPvpStart(d) {
  myInvite = null;
  note("chain", `${d.info.npc.name} joined your match #${d.match}. Pot ${fmt(2 * d.stake)}.`);
  await beginMatch(d.info, d.stake);
}

/** Opened with #join=<id>: show the invite once we are logged in. */
async function checkJoin() {
  const id = joinId();
  if (id == null) return;
  const inv = await api(`/api/pvp/invite?id=${id}`).catch(() => null);
  const card = $("joincard");
  card.hidden = false;
  if (!inv?.open) {
    $("jointext").textContent = `Match #${id} is no longer open`;
    $("joinbtn").hidden = true;
    return;
  }
  const host = inv.host.replace(/\.local$/, "").replace(/\.noref\.testnet$/, "");
  $("jointext").innerHTML = "";
  $("jointext").append(host, " invites you · ");
  const b = document.createElement("b");
  b.textContent = `${fmt(inv.stake)} each`;
  $("jointext").append(b);
  $("joinbtn").hidden = false;
  $("joinbtn").disabled = !me || inv.host === me;
  if (inv.host === me) $("joinbtn").textContent = "This is your own invite";
  else if (!me) $("joinbtn").textContent = "Pick a name above, then join";
  else $("joinbtn").textContent = "Lock my stake and play";
  card.scrollIntoView({ behavior: "smooth", block: "center" });
}
window.addEventListener("hashchange", () => checkJoin().catch(() => {}));
$("joinbtn").addEventListener("click", async () => {
  const id = joinId();
  if (id == null || !me) return;
  sound.unlock();
  $("joinbtn").disabled = true;
  try {
    let r = await api("/api/pvp/join", { me, id });
    if (r.call) {
      setStatus(`Signing: lock ${fmt(r.stake)} in ${r.call.contract}…`);
      const t = await pc.call(r.call.method, r.call.args, 30n, r.call.deposit);
      note("tx", `You signed join: ${fmt(r.stake)} locked in match #${id}`, t.hash);
      r = await api("/api/pvp/joined", { me, id, tx: t.hash });
    }
    $("joincard").hidden = true;
    history.replaceState(null, "", location.pathname);
    await beginMatch(r.match, r.stake);
  } catch (err) {
    note("problem", err.message);
    $("joinbtn").disabled = false;
  }
});

// ---------- recorded demo: a real lie caught on NEAR testnet ----------
// Plays back web/demo/lie.json (recorded by `scripts-testnet-e2e.mjs --record`)
// through the same table, checks and stamps as a live match. The moves are
// replayed locally with the same engine; every linked transaction is real.
const DEMO_EXPLORER = "https://testnet.nearblocks.io";
let demoOn = false;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function playDemo() {
  if (demoOn || aimResolve || anim || replayView) return;
  if (client && !client.demo && client.verdict == null) return note("problem", "Finish your match first, then watch the demo.");
  demoOn = true;
  $("demobtn").disabled = true;
  try {
    const rec = await fetch("demo/lie.json").then((r) => r.json());
    const R = rec.roundTicks;
    const D = rec.duration;
    const records = rec.records.map((r) => ({ tick: r.tick, entries: r.entries.map((e) => ({ ball: e.ball, dvx: BigInt(e.dvx), dvy: BigInt(e.dvy) })) }));
    engine.reset();
    client = { demo: true, id: -rec.match, info: { npc: rec.npc, rounds: rec.rounds }, R, D, records, table: engine.getState(), verdict: null };
    const ev = (k) => rec.events.find((e) => e.kind === k);
    const say = (t) => t.split(rec.player).join("the player");
    $("record").innerHTML = "";
    $("lie").hidden = true;
    clearStage();
    setPot(2 * rec.stake);
    fx.clearTrails();
    finalMarks = false;
    view = client.table;
    $("npcname").textContent = rec.npc.name;
    $("youname").textContent = "Player";
    setRound(0, rec.rounds);
    updateDist(view);
    $("table").scrollIntoView({ behavior: "smooth", block: "center" });
    note("demo", `Recording of real match #${rec.match} on NEAR testnet. The moves replay here; every linked transaction is real.`);
    fx.show(`Player vs ${rec.npc.name}`, { sub: `recorded match #${rec.match} · ${fmt(2 * rec.stake)} pot`, dur: 2000 });
    setStatus(`${rec.npc.name} has been told to lie about the result. Watch.`);
    await sleep(1800);
    for (const k of ["create", "join"]) {
      const e = ev(k);
      if (e) note("chain", say(e.text), e.tx);
      await sleep(700);
    }
    let state = client.table;
    for (let i = 0; i < rec.rounds; i++) {
      setRound(i, rec.rounds);
      fx.show(i === rec.rounds - 1 ? "Final round" : `Round ${i + 1}`, { dur: 900 });
      await sleep(900);
      const tick = i * R;
      const entries = records.find((r) => r.tick === tick)?.entries ?? [];
      engine.setState(state);
      engine.tick(encodeEntries(entries), tick);
      engine.runTicks(R - 1, tick + 1);
      client.table = engine.getState();
      onClientLog("round", "", { roundStart: state, entries, tick });
      state = client.table;
      await sleep((R / 60) * 1000 + 400);
    }
    client.verdict = engine.replay(encodeLog(records), D, D - 1).winner;
    onClientLog("final", `Our own replay of all ${D} ticks: ${client.verdict === SIDE.FIRST ? "the player won" : client.verdict === SIDE.SECOND ? rec.npc.name + " won" : "a draw"}`);
    await sleep(2000);
    const claim = ev("claim");
    onClientLog("chain", say(claim.text), claim);
    await sleep(2400);
    note("you", "The claim contradicts the replay: the player disputes on-chain with the NPC's own signature.");
    setStatus("Disputing: the signed log goes to the contract…");
    await sleep(1400);
    const replay = ev("replay");
    onClientLog("chain", say(replay.text), replay);
    await sleep((D / (60 * 9)) * 1000);
    while (replayView) await sleep(100); // slow devices: let the replay finish first
    await sleep(2200);
    const settle = ev("settle");
    onClientLog("chain", say(settle.text), settle);
    await sleep(3200);
    note("demo", "No server and no person decided this: the contract replayed the match and paid the real winner. Now pick a fighter and play (tick “NPC lies” to make it lie to you).");
    setStatus("Your turn: pick a fighter.");
  } catch (e) {
    note("problem", "demo: " + e.message);
  } finally {
    demoOn = false;
    $("demobtn").disabled = false;
    if (client?.demo) client.settled = true; // a recording never blocks a real challenge
    refresh().catch(() => {});
  }
}
$("demobtn").addEventListener("click", () => {
  sound.unlock();
  playDemo();
});

// ---------- Gauntlet: beat all six fighters; the board ----------
let boardAt = 0;
async function renderBoard(force = false) {
  if (!force && Date.now() - boardAt < 8000) return;
  boardAt = Date.now();
  const b = await api(`/api/leaderboard?me=${encodeURIComponent(me ?? "")}`);
  const beaten = b.me?.beaten ?? [];
  $("gprog").textContent = me ? `you: ${beaten.length}/${b.fighters.length}${beaten.length === b.fighters.length ? " · complete" : ""}` : `${b.players} player(s) so far`;
  $("gchips").innerHTML = b.fighters
    .map((name, i) => `<li class="${beaten.includes(name) ? "won" : ""}" style="--c:${COLORS[i % COLORS.length]}">${beaten.includes(name) ? "✓ " : ""}${name}</li>`)
    .join("");
  const short = (a) => a.replace(/\.noref\.testnet$/, "");
  $("board").innerHTML = b.top.length
    ? b.top
        .map((r) => `<li class="${r.account === me ? "me" : ""}">${short(r.account)}${r.bot ? " (bot)" : ""} <span class="g">${r.beaten.length}/${b.fighters.length}</span> · ${r.wins}W ${r.losses}L${r.liesCaught ? ` · ${r.liesCaught} lie${r.liesCaught > 1 ? "s" : ""} caught` : ""}</li>`)
        .join("")
    : `<li class="muted">No finished matches yet.</li>`;
  $("board").title = `From ${b.from}.`;
}

// ---------- first screen ----------
$("herodemo").addEventListener("click", () => {
  sound.unlock();
  $("table").scrollIntoView({ behavior: "smooth", block: "center" });
  playDemo();
});
$("heroplay").addEventListener("click", () => {
  $("login").hidden = false;
  $("login").scrollIntoView({ behavior: "smooth", block: "center" });
  $("name").focus({ preventScroll: true });
});
$("heroweek").addEventListener("click", () => {
  document.querySelector(".economy").scrollIntoView({ behavior: "smooth", block: "start" });
  if (!week) $("ff").click();
});

// ---------- boot ----------
if (me && localStorage.getItem("noref-name")) {
  try {
    await login(localStorage.getItem("noref-name"));
  } catch {
    $("login").hidden = false;
  }
} else {
  $("login").hidden = false;
  await refresh();
  await checkJoin();
}
if (location.hash === "#demo") setTimeout(playDemo, 800);
