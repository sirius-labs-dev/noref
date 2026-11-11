// Visual and audio juice for the NoRef table. Nothing here affects the
// game: physics and verdicts come only from the engine.

// ---------------- sound (synthesized, no assets) ----------------
let ac = null;
let master = null;
export const sound = {
  on: localStorage.getItem("noref-sound") !== "off",
  unlock() {
    if (ac) return;
    try {
      ac = new AudioContext();
      master = ac.createGain();
      master.gain.value = 0.5;
      master.connect(ac.destination);
    } catch {}
  },
  toggle() {
    this.on = !this.on;
    localStorage.setItem("noref-sound", this.on ? "on" : "off");
    return this.on;
  },
};

function env(node, t, a, d, peak) {
  node.gain.setValueAtTime(0.0001, t);
  node.gain.exponentialRampToValueAtTime(peak, t + a);
  node.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function tone(freq, { type = "sine", a = 0.004, d = 0.18, peak = 0.3, slide = 0, delay = 0 } = {}) {
  if (!sound.on || !ac) return;
  const t = ac.currentTime + delay;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + a + d);
  env(g, t, a, d, peak);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + a + d + 0.05);
}

function noise({ d = 0.12, peak = 0.25, freq = 1200, q = 1.2, delay = 0 } = {}) {
  if (!sound.on || !ac) return;
  const t = ac.currentTime + delay;
  const len = Math.ceil(ac.sampleRate * (d + 0.05));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ac.createGain();
  env(g, t, 0.003, d, peak);
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

export const sfx = {
  clack(strength) {
    const s = Math.min(1, strength);
    tone(900 + 700 * s, { type: "triangle", d: 0.07, peak: 0.08 + 0.35 * s });
    noise({ d: 0.04, peak: 0.05 + 0.2 * s, freq: 3200 });
  },
  thud(strength) {
    const s = Math.min(1, strength);
    tone(120, { type: "sine", d: 0.16, peak: 0.1 + 0.3 * s, slide: 0.6 });
  },
  flick(power) {
    noise({ d: 0.18 + 0.12 * power, peak: 0.12 + 0.2 * power, freq: 600 + 900 * power, q: 0.8 });
  },
  commit() {
    tone(660, { type: "sine", d: 0.08, peak: 0.12 });
    tone(990, { type: "sine", d: 0.1, peak: 0.1, delay: 0.06 });
  },
  tick() {
    tone(1400, { type: "square", d: 0.02, peak: 0.04 });
  },
  round() {
    tone(523, { type: "triangle", d: 0.2, peak: 0.12 });
  },
  win() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, { type: "triangle", d: 0.35, peak: 0.16, delay: i * 0.09 }));
  },
  lose() {
    [392, 330, 262].forEach((f, i) => tone(f, { type: "sine", d: 0.35, peak: 0.14, delay: i * 0.12 }));
  },
  alarm() {
    for (let i = 0; i < 3; i++) tone(880, { type: "sawtooth", d: 0.09, peak: 0.07, delay: i * 0.16 });
  },
  scan() {
    tone(220, { type: "sawtooth", a: 0.05, d: 1.6, peak: 0.05, slide: 4 });
  },
  stamp() {
    tone(90, { type: "square", d: 0.25, peak: 0.25, slide: 0.5 });
    noise({ d: 0.12, peak: 0.3, freq: 400 });
  },
  coins() {
    for (let i = 0; i < 6; i++) tone(1800 + Math.random() * 900, { type: "triangle", d: 0.08, peak: 0.07, delay: i * 0.05 });
  },
};

// ---------------- particles & effects ----------------
export class Fx {
  constructor() {
    this.parts = [];
    this.rings = [];
    this.shake = 0;
    this.trails = new Map(); // ball index -> [{x,y}]
    this.banner = null; // {text, sub, color, t0, dur, stamp}
  }

  impact(x, y, strength, color) {
    const n = 6 + Math.round(10 * Math.min(1, strength));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (0.4 + Math.random()) * (1 + 2.5 * strength);
      this.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, decay: 0.03 + Math.random() * 0.03, color, r: 1 + Math.random() * 1.5 });
    }
    this.rings.push({ x, y, r: 4, life: 1, color });
    this.shake = Math.min(8, this.shake + 6 * strength);
  }

  confetti(x, y, colors) {
    for (let i = 0; i < 90; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const v = 2 + Math.random() * 5;
      this.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 0.12, life: 1, decay: 0.008 + Math.random() * 0.01, color: colors[i % colors.length], r: 1.5 + Math.random() * 2, rect: true, rot: Math.random() * 6 });
    }
  }

  trail(i, x, y, moving) {
    let t = this.trails.get(i);
    if (!t) this.trails.set(i, (t = []));
    if (moving) t.push({ x, y });
    else if (t.length) t.shift();
    if (t.length > 14) t.shift();
  }

  clearTrails() {
    this.trails.clear();
  }

  show(text, { sub = "", color = "#fff", dur = 1600, stamp = false } = {}) {
    this.banner = { text, sub, color, t0: performance.now(), dur, stamp };
  }

  step() {
    for (const p of this.parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.94;
      p.vy = p.vy * 0.94 + (p.g ?? 0);
      p.life -= p.decay;
      if (p.rot != null) p.rot += 0.2;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const r of this.rings) {
      r.r += 1.6;
      r.life -= 0.05;
    }
    this.rings = this.rings.filter((r) => r.life > 0);
    this.shake *= 0.85;
    if (this.shake < 0.1) this.shake = 0;
  }

  /** k: px per arena unit */
  draw(g, k, ballColor) {
    // trails
    for (const [i, t] of this.trails) {
      for (let j = 0; j < t.length; j++) {
        const a = (j + 1) / t.length;
        g.beginPath();
        g.arc(t[j].x * k, t[j].y * k, 8 * k * a * 0.8, 0, Math.PI * 2);
        g.fillStyle = ballColor(i, 0.12 * a);
        g.fill();
      }
    }
    for (const r of this.rings) {
      g.beginPath();
      g.arc(r.x * k, r.y * k, r.r * k, 0, Math.PI * 2);
      g.strokeStyle = `rgba(255,255,255,${0.5 * r.life})`;
      g.lineWidth = 2;
      g.stroke();
    }
    for (const p of this.parts) {
      g.globalAlpha = Math.max(0, p.life);
      g.fillStyle = p.color;
      if (p.rect) {
        g.save();
        g.translate(p.x * k, p.y * k);
        g.rotate(p.rot);
        g.fillRect(-p.r * 1.5, -p.r, p.r * 3, p.r * 2);
        g.restore();
      } else {
        g.beginPath();
        g.arc(p.x * k, p.y * k, p.r * k * 0.6 + 1, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = 1;
  }

  drawBanner(g, S) {
    const b = this.banner;
    if (!b) return;
    const t = (performance.now() - b.t0) / b.dur;
    if (t >= 1) {
      this.banner = null;
      return;
    }
    const inT = Math.min(1, t * 6);
    const outT = t > 0.8 ? (1 - t) / 0.2 : 1;
    const alpha = Math.min(inT, outT);
    const scale = b.stamp ? 1 + 1.5 * (1 - Math.min(1, t * 8)) ** 2 : 0.9 + 0.1 * inT;
    g.save();
    g.globalAlpha = alpha;
    g.translate(S / 2, S / 2);
    if (b.stamp) g.rotate(-0.12);
    g.scale(scale, scale);
    g.textAlign = "center";
    g.textBaseline = "middle";
    const fs = Math.round(S / 8);
    g.font = `900 ${fs}px "Barlow Condensed", "Arial Narrow", ui-sans-serif, sans-serif`;
    const text = b.text.toUpperCase();
    if (b.stamp) {
      const w = g.measureText(text).width + fs * 0.8;
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(-w / 2, -fs * 0.75, w, fs * 1.5);
      g.lineWidth = fs * 0.09;
      g.strokeStyle = b.color;
      g.strokeRect(-w / 2, -fs * 0.75, w, fs * 1.5);
    } else {
      g.fillStyle = "rgba(0,0,0,0.35)";
      g.fillRect(-S / 2, -fs * 0.9, S, fs * (b.sub ? 2.2 : 1.8));
    }
    g.fillStyle = b.color;
    g.fillText(text, 0, 0);
    if (b.sub && b.stamp) {
      g.font = `600 ${Math.round(fs * 0.3)}px Inter, ui-sans-serif, system-ui, sans-serif`;
      g.fillStyle = b.color;
      g.fillText(b.sub, 0, fs * 1.15);
    } else if (b.sub) {
      g.font = `600 ${Math.round(fs * 0.32)}px Inter, ui-sans-serif, system-ui, sans-serif`;
      g.fillStyle = "rgba(255,255,255,0.9)";
      g.fillText(b.sub, 0, fs * 0.85);
    }
    g.restore();
  }
}

// ---------------- table texture ----------------
/** Pre-render the static table (felt, rim, house rings) to an offscreen canvas. */
export function renderTable(S, colors) {
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  const k = S / 256;
  // felt with radial light
  const grad = g.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.75);
  grad.addColorStop(0, colors.felt2);
  grad.addColorStop(1, colors.felt);
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  // fibre noise
  const img = g.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // faint grid
  g.strokeStyle = "rgba(255,255,255,0.035)";
  g.lineWidth = 1;
  for (let x = 32; x < 256; x += 32) {
    g.beginPath();
    g.moveTo(x * k, 0);
    g.lineTo(x * k, S);
    g.moveTo(0, x * k);
    g.lineTo(S, x * k);
    g.stroke();
  }
  // the house: concentric target rings
  const rings = [
    [64, "rgba(255,255,255,0.05)"],
    [48, colors.ringOuter],
    [32, "rgba(255,255,255,0.10)"],
    [16, colors.ringInner],
    [5, "rgba(255,255,255,0.85)"],
  ];
  for (const [r, col] of rings) {
    g.beginPath();
    g.arc(128 * k, 128 * k, r * k, 0, Math.PI * 2);
    g.fillStyle = col;
    g.fill();
  }
  for (const r of [16, 32, 48, 64]) {
    g.beginPath();
    g.arc(128 * k, 128 * k, r * k, 0, Math.PI * 2);
    g.strokeStyle = "rgba(255,255,255,0.18)";
    g.lineWidth = Math.max(1, k * 0.6);
    g.stroke();
  }
  // start marks
  for (const x of [40, 216]) {
    g.beginPath();
    g.arc(x * k, 128 * k, 10 * k, 0, Math.PI * 2);
    g.strokeStyle = "rgba(255,255,255,0.12)";
    g.setLineDash([4, 5]);
    g.stroke();
    g.setLineDash([]);
  }
  // inner shadow / cushion
  const v = g.createRadialGradient(S / 2, S / 2, S * 0.45, S / 2, S / 2, S * 0.75);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.35)");
  g.fillStyle = v;
  g.fillRect(0, 0, S, S);
  g.lineWidth = k * 3;
  g.strokeStyle = "rgba(0,0,0,0.35)";
  g.strokeRect(0, 0, S, S);
  return c;
}

/** Shaded ball sprite. */
export function drawBall(g, x, y, r, base, { glow = 0, label = "" } = {}) {
  // drop shadow
  g.beginPath();
  g.ellipse(x + r * 0.18, y + r * 0.28, r * 0.95, r * 0.75, 0, 0, Math.PI * 2);
  g.fillStyle = "rgba(0,0,0,0.28)";
  g.fill();
  if (glow) {
    g.beginPath();
    g.arc(x, y, r * (1.25 + 0.25 * glow), 0, Math.PI * 2);
    g.fillStyle = base.replace(")", `,${0.18 * glow})`).replace("rgb", "rgba");
    g.fill();
  }
  const grad = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  grad.addColorStop(0, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.18, base);
  grad.addColorStop(1, shade(base, 0.55));
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = grad;
  g.fill();
  if (label) {
    g.fillStyle = "rgba(255,255,255,0.92)";
    g.font = `800 ${Math.round(r * 0.9)}px ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, x, y + r * 0.04);
  }
}

function shade(rgb, f) {
  const m = rgb.match(/\d+/g).map(Number);
  return `rgb(${Math.round(m[0] * f)},${Math.round(m[1] * f)},${Math.round(m[2] * f)})`;
}
