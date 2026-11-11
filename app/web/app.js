// NoRef web client. Plain ES modules, no build step, no dependencies.
import { Engine, encodeEntries, encodeLog, flickToImpulse, SIDE } from "/shared/engine.js";
import { MatchClient, newSessionKey, exportSessionKey, importSessionKey } from "/shared/client.js";
import { fmt } from "/shared/economy.js";
import { STYLE_INFO } from "/shared/npc.js";
import { PlayerChain, accountKey } from "/shared/player-chain.js";
import { Fx, sfx, sound, renderTable, drawBall } from "./fx.js";

const $ = (id) => document.getElementById(id);
const ARENA = 256;
const RADIUS = 8;
const CENTER = 128;
const COL = { a: "rgb(240,138,36)", b: "rgb(61,139,253)", peg: "rgb(214,205,184)" };
const ballColor = (i) => (i === 0 ? COL.a : i === 1 ? COL.b : COL.peg);
const ballRGBA = (i, a) => ballColor(i).replace("rgb", "rgba").replace(")", `,${a})`);

const engine = await Engine.load(await (await fetch("/engine.wasm")).arrayBuffer());
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
let finalMarks = false;
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
async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
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
    pc = new PlayerChain({ rpc: "/api/rpc", contract: chainInfo.contract, accountId: me, key: acct, api, log: (kind, text, res) => note("tx", text, res.hash) });
    if (r.fresh) note("chain", `Created ${me} on NEAR testnet with ${fmt(r.balance)}. Its key was made in this browser and never leaves it.`, r.tx);
  }
  localStorage.setItem("noref-me", me);
  localStorage.setItem("noref-name", name);
  $("login").hidden = true;
  connect();
  await refresh();
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
  es = new EventSource(`/api/events?me=${encodeURIComponent(me)}`);
  for (const k of ["round", "committed", "reveal", "round_result", "final", "chain", "note"]) {
    es.addEventListener(k, (ev) => onMatchEvent(k, JSON.parse(ev.data)));
  }
  es.addEventListener("feed", (ev) => {
    addFeed(JSON.parse(ev.data));
    scheduleRefresh();
  });
}

const early = []; // chain events that arrive before the match client exists (create, join)
function onMatchEvent(kind, d) {
  if (kind === "chain" && (!client || d.match !== client.id)) early.push(d);
  if (!client || d.match !== client.id) return;
  if (kind === "round") npcPhase = "thinking";
  if (kind === "committed" && d.side === 1) {
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
    client = new MatchClient({ engine, api, me, key, info: r.match, aim: waitForAim, log: onClientLog, chain: pc?.opsFor(r.match.id) });
    early.splice(0).filter((e) => e.match === r.match.id && e.kind !== "create").forEach((e) => note("chain", e.text, e.tx));
    view = client.table;
    finalMarks = false;
    replayView = null;
    fx.clearTrails();
    $("npcname").textContent = r.match.npc.name;
    $("youname").textContent = me.replace(/\.local$/, "").replace(/\.noref\.testnet$/, "");
    setRound(0, r.match.rounds);
    updateDist(view);
    fx.show(`vs ${r.match.npc.name}`, { sub: `${fmt(2 * r.stake)} pot · ${r.match.rounds} rounds`, dur: 1800 });
    await refresh();
  } catch (e) {
    note("problem", e.message);
  }
}

function setRound(i, n) {
  $("round").textContent = i < n ? `Round ${i + 1} / ${n}` : "Match over";
  $("pips").innerHTML = Array.from({ length: n }, (_, k) => `<i class="${k < i ? "done" : k === i ? "now" : ""}"></i>`).join("");
}

function waitForAim(eng, ctx) {
  view = eng.getState();
  aim = null;
  setRound(ctx.round, ctx.rounds);
  fx.show(ctx.round === ctx.rounds - 1 ? "Final round" : `Round ${ctx.round + 1}`, { dur: 1100 });
  sfx.round();
  setStatus("Drag back from your orange ball to aim. Release, then Flick.");
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
    note("check", `Round ${data.tick / client.R + 1}: NPC reveal matches its commit ✓ · NPC signature ✓ · ${client.demo ? "the player" : "you"} countersigned ✓`);
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
      fx.show(data.data.by === me ? "You claim the win" : `${client.info.npc.name}: "${data.data.winner === SIDE.SECOND ? "I won" : data.data.winner === SIDE.FIRST ? "you won" : "draw"}"`, {
        sub: honest ? "matches your replay" : "contradicts your replay",
        color: honest ? "#fff" : "#ffb4a8",
        dur: 1800,
      });
      if (!honest && data.data.by !== me) sfx.alarm();
    }
    if (data.kind === "replay") startReplayVisual(data.data);
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
    if (w === SIDE.FIRST) {
      fx.confetti(CENTER, CENTER + 20, [COL.a, "#ffd166", "#ffffff", "#06d6a0"]);
      fx.show(client?.demo ? "The player wins" : "You win", { sub: text, color: "#ffd166", dur: 2600 });
      sfx.win();
      setTimeout(() => sfx.coins(), 350);
    } else if (w === SIDE.SECOND) {
      fx.show(`${client.info.npc.name} wins`, { sub: text, color: "#bcd4ff", dur: 2400 });
      sfx.lose();
    } else {
      fx.show("Draw", { sub: text, dur: 2200 });
    }
  }, delay);
  scheduleRefresh();
}

/** NEAR replays the whole match: show it, fast, with the verdict stamped at the end. */
function startReplayVisual(data) {
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
    tableImg = renderTable(S, { felt: css("--felt"), felt2: css("--felt-2"), ringOuter: "rgba(61,139,253,0.18)", ringInner: "rgba(240,138,36,0.22)" });
  }
}
new ResizeObserver(resize).observe(cv);

function updateDist(bytes) {
  engine.setState(bytes);
  $("distA").textContent = Math.sqrt(engine.dist2(0)).toFixed(1) + " from ◎";
  $("distB").textContent = Math.sqrt(engine.dist2(1)).toFixed(1) + " from ◎";
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
      fx.show(d.overturned ? "LIE CAUGHT" : "CLAIM CORRECT", { stamp: true, color: d.overturned ? "#ff5a4a" : "#5ee59a", dur: 4000, sub: d.overturned ? "the replay disagrees with the claim" : "" });
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
    const glow = i === 0 && aimResolve ? 0.6 + 0.4 * Math.sin(now / 250) : 0;
    drawBall(g, b.x * k, b.y * k, RADIUS * k, ballColor(i), { glow, label: i === 0 ? "A" : i === 1 ? "B" : "" });
  });

  // NPC state badge
  if (client && (npcPhase === "thinking" || npcPhase === "locked") && !anim) {
    const b = balls[1];
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
  const a0 = balls[0];
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
  engine.tick(encodeEntries([{ ball: 0, dvx, dvy }]), 0);
  let prev = engine.balls();
  for (let i = 0; i < 150; i++) {
    engine.tick(new Uint8Array(0), i + 1);
    const bs = engine.balls();
    const b = bs[0];
    if (i % 3 === 0) {
      g.beginPath();
      g.arc(b.x * k, b.y * k, Math.max(1.5, 2.6 * (1 - i / 150)) * k * 0.6, 0, Math.PI * 2);
      g.fillStyle = `rgba(255,190,120,${0.75 * (1 - i / 150)})`;
      g.fill();
    }
    // show where other balls would be pushed
    for (let j = 1; j < bs.length; j++) {
      if (Math.hypot(bs[j].vx, bs[j].vy) > 0.5 && Math.hypot(prev[j].vx, prev[j].vy) < 0.5) {
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
  const end = engine.balls()[0];
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
  const b = engine.balls()[0];
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
  renderBadge();
  renderAccount();
  renderRoster();
  renderChart();
  renderFeed();
}

function renderAccount() {
  const a = $("account");
  if (!state.me) {
    a.innerHTML = "";
    return;
  }
  a.innerHTML = testnet()
    ? `<a href="${chainInfo.explorer}/address/${state.me.id}" target="_blank" rel="noopener"><b>${state.me.id}</b></a><span>${fmt(state.me.balance)}</span>`
    : `<b>${state.me.id}</b><span>${fmt(state.me.balance)}</span>`;
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
  for (const n of state.roster) {
    const li = document.createElement("li");
    li.className = "npc" + (n.status === "open" ? "" : " closed");
    const mine = state.me ? n.holders[state.me.id] ?? 0 : 0;
    li.innerHTML = `
      <div><span class="name">${n.name}</span>${n.status === "open" ? "" : '<span class="pill closed">closed</span>'}
        <div class="style">${n.style} · ${STYLE_INFO[n.style]}</div>
        <div class="meta">rating ${n.rating} · ${n.wins}W ${n.losses}L ${n.draws}D · bankroll ${testnet() && n.account ? `<a href="${chainInfo.explorer}/address/${n.account}" target="_blank" rel="noopener" title="its real NEAR account">${fmt(n.bankroll)} ↗</a>` : fmt(n.bankroll)}</div>
      </div>
      <div class="price">asks ${fmt(n.stake)}</div>
      <div class="acts">
        <button class="small" data-act="fight" ${n.status !== "open" || busy || !state.me ? "disabled" : ""}>Challenge</button>
        <button class="small ghost" data-act="back" ${!state.me ? "disabled" : ""}>Back with ${BACK()} NEAR</button>
        ${mine > 0 ? `<button class="small ghost" data-act="cash">Cash out ${mine.toFixed(1)} sh (${fmt(Math.floor(mine * n.sharePrice))})</button>` : ""}
      </div>`;
    const price = li.querySelector(".price");
    price.addEventListener("mouseenter", (ev) => showTip(ev, ["Why this price:", ...n.why]));
    price.addEventListener("mousemove", (ev) => showTip(ev, ["Why this price:", ...n.why]));
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
  }
}

const COLORS = ["#f08a24", "#3d8bfd", "#1f8a4c", "#a855f7", "#e11d48", "#0d9488"];
function renderChart() {
  const c = $("chart");
  const ctx = c.getContext("2d");
  const W = c.width;
  const H = c.height;
  ctx.clearRect(0, 0, W, H);
  const all = state.roster.flatMap((n) => n.history);
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
  state.roster.forEach((n, idx) => {
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
  $("legend").innerHTML = state.roster.map((n, i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${n.name}${n.status === "open" ? "" : " (closed)"}</span>`).join("");
  if (testnet()) {
    $("ff").hidden = true;
    $("simdays").textContent = `Fighters play each other on-chain every ${chainInfo.ladderMin ?? 15} min. Bankrolls are their real NEAR balances.`;
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
  state.feed.forEach(addFeed);
}

$("ff").addEventListener("click", async () => {
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
    await sleep((D / (60 * 9)) * 1000 + 2200);
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
  }
}
$("demobtn").addEventListener("click", () => {
  sound.unlock();
  playDemo();
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
}
if (location.hash === "#demo") setTimeout(playDemo, 800);
