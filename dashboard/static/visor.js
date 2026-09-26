// visor.js — Thea's LED visor, drawn dot by dot on a canvas.
//
// Her face in every reference is a black visor with blue LED eyes that change shape:
// hearts, happy arcs (^ ^), open rectangles, question marks, flat lines. This draws the
// same thing as a real dot-matrix: a fixed grid of LEDs, each either dark or lit, lit
// ones glowing. Expressions are shapes sampled onto the grid, so they stay crisp at any
// size and transitions are just LEDs fading in and out.
//
//   const v = new Visor(canvas); v.set('happy'); v.level(0..1)  // voice amplitude
//
// Expressions: happy, heart, open, soft, smug, line, curious, wide, think

(function () {
  const COLS = 46, ROWS = 13;             // LED grid across the band
  const EYE_W = 15, EYE_H = 11;           // per-eye region, in LEDs
  const GAP = 6;                          // LEDs between the eyes

  // --- shape library: f(u, v) -> brightness 0..1, u,v in [-1, 1], v grows downward
  const ring = (d, r, t) => Math.max(0, 1 - Math.abs(d - r) / t);
  const heartF = (u, v) => { const x = u * 1.25, y = -(v * 1.25) + 0.25; const a = x * x + y * y - 1; return a * a * a - x * x * y * y * y; };
  const QMARK = [
    '..XXXXX..',
    '.XX...XX.',
    '......XX.',
    '.....XX..',
    '....XX...',
    '....XX...',
    '.........',
    '....XX...',
    '....XX...',
  ];
  const SHAPES = {
    happy: (u, v) => (v < 0.55 ? ring(Math.hypot(u, v - 0.55), 0.78, 0.26) : 0),
    heart: (u, v) => { const o = heartF(u, v), i = heartF(u * 1.45, v * 1.45 + 0.05); return o <= 0 && i > 0 ? 1 : o <= 0 ? 0.18 : 0; },
    open: (u, v) => { const du = Math.abs(u) - 0.62, dv = Math.abs(v) - 0.7; const out = Math.max(du, dv); return out <= 0 && out > -0.26 ? 1 : 0; },
    wide: (u, v) => { const d = Math.hypot(u / 0.85, v / 0.95); return ring(d, 0.78, 0.22) + (d < 0.28 ? 0.9 : 0); },
    soft: (u, v) => (Math.abs(u) < 0.8 ? Math.max(0, 1 - Math.abs(v - (0.12 - 0.34 * u + 0.12 * u * u)) / 0.2) * 0.8 : 0),  // droopy: outer ends sag
    smug: (u, v) => (Math.abs(v + 0.05) < 0.14 && Math.abs(u) < 0.82 ? 1 : 0) + (v > -0.05 && v < 0.7 ? ring(Math.hypot(u, v + 0.05), 0.72, 0.2) * 0.9 : 0),
    line: (u, v) => (Math.abs(v - 0.1) < 0.16 && Math.abs(u) < 0.8 ? 1 : 0),
    think: (u, v) => (Math.abs(v - 0.1) < 0.16 && Math.abs(u) < 0.8 ? 0.35 : 0),     // dimmed; dots animate on top
    curious: null,                                                                 // bitmap
  };

  function sample(expr, blink) {
    // returns Float32Array COLS*ROWS of target brightness
    const out = new Float32Array(COLS * ROWS);
    const x0 = Math.floor((COLS - (EYE_W * 2 + GAP)) / 2), y0 = Math.floor((ROWS - EYE_H) / 2);
    for (let e = 0; e < 2; e++) {
      const ex = x0 + e * (EYE_W + GAP);
      for (let j = 0; j < EYE_H; j++) {
        for (let i = 0; i < EYE_W; i++) {
          let b = 0;
          if (blink > 0.5) {
            b = j === Math.floor(EYE_H / 2) + 1 && i > 1 && i < EYE_W - 2 ? 0.9 : 0;
          } else if (expr === 'curious') {
            const bi = i - Math.floor((EYE_W - 9) / 2), bj = j - 1;
            b = QMARK[bj] && QMARK[bj][bi] === 'X' ? 1 : 0;
          } else {
            // mirror the right eye so asymmetric shapes (smug) read as a face
            const u = ((i + 0.5) / EYE_W) * 2 - 1, v = ((j + 0.5) / EYE_H) * 2 - 1;
            b = Math.min(1, (SHAPES[expr] || SHAPES.happy)(e ? -u : u, v));
          }
          out[(y0 + j) * COLS + ex + i] = b;
        }
      }
    }
    return out;
  }

  class Visor {
    constructor(canvas) {
      this.c = canvas; this.g = canvas.getContext('2d');
      this.expr = 'happy'; this.cur = new Float32Array(COLS * ROWS); this.target = sample('happy', 0);
      this.amp = 0; this.ampS = 0; this.dim = 1; this.nextBlink = performance.now() + 2500; this.blinkUntil = 0;
      this.t0 = performance.now(); this.color = [79, 179, 255];
      this.resize(); addEventListener('resize', () => this.resize());
      const loop = (t) => { this.frame(t); this.raf = requestAnimationFrame(loop); };
      this.raf = requestAnimationFrame(loop);
    }
    resize() {
      const r = this.c.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      if (!r.width || !r.height) return;
      this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
      const P = this.pitch = Math.min(this.c.width / (COLS + 1), this.c.height / (ROWS + 1));
      this.ox = (this.c.width - P * COLS) / 2; this.oy = (this.c.height - P * ROWS) / 2;
      // the dark hardware grid, drawn once
      const bg = this.bg = document.createElement('canvas'); bg.width = this.c.width; bg.height = this.c.height;
      const b = bg.getContext('2d'); b.fillStyle = 'rgba(70,90,140,0.11)';
      for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
        b.beginPath(); b.arc(this.ox + (i + 0.5) * P, this.oy + (j + 0.5) * P, P * 0.29, 0, 6.283); b.fill();
      }
      // one lit LED with its halo, drawn once; frames just stamp it with an alpha
      const S = this.spriteSize = Math.ceil(P * 3.2), sp = this.sprite = document.createElement('canvas');
      sp.width = sp.height = S;
      const s = sp.getContext('2d'), [R, G] = this.color, m = S / 2;
      const halo = s.createRadialGradient(m, m, 0, m, m, m);
      halo.addColorStop(0, `rgba(${R},${G},255,0.55)`); halo.addColorStop(0.35, `rgba(${R},${G},255,0.18)`); halo.addColorStop(1, 'rgba(0,0,0,0)');
      s.fillStyle = halo; s.fillRect(0, 0, S, S);
      const core = s.createRadialGradient(m, m, 0, m, m, P * 0.38);
      core.addColorStop(0, 'rgba(235,248,255,1)'); core.addColorStop(0.55, `rgba(${R + 60},${G + 45},255,1)`); core.addColorStop(1, `rgba(${R},${G},255,0.9)`);
      s.fillStyle = core; s.beginPath(); s.arc(m, m, P * 0.38, 0, 6.283); s.fill();
    }
    set(expr) { if (expr && expr !== this.expr) { this.expr = expr; this.target = sample(expr, 0); } }
    level(a) { this.amp = Math.max(0, Math.min(1, a)); }
    setDim(d) { this.dim = d; }
    frame(t) {
      if (this.paused) return;
      if (!this.bg) { this.resize(); if (!this.bg) return; }
      // idle: ~30 fps is plenty for a face; on a call (amp moving) run every frame
      if (this.ampS < 0.02 && t - (this.last || 0) < 32) return;
      this.last = t;
      const g = this.g, P = this.pitch, S = this.spriteSize;
      // blinking: every 3-7 s, 130 ms; not while thinking or sleepy
      if (t > this.nextBlink && this.expr !== 'think' && this.expr !== 'line') { this.blinkUntil = t + 130; this.nextBlink = t + 3000 + Math.random() * 4000; }
      const blinking = t < this.blinkUntil;
      const tgt = blinking ? (this.blinkMask ||= sample('open', 1)) : this.target;
      this.ampS += (this.amp - this.ampS) * 0.35;
      const boost = 0.7 + this.ampS * 0.7;                        // talking makes her brighter
      g.clearRect(0, 0, this.c.width, this.c.height);
      g.drawImage(this.bg, 0, 0);
      const think = this.expr === 'think';
      const phase = (t - this.t0) / 1000;
      const midRow = Math.floor(ROWS / 2) + 1;
      for (let j = 0; j < ROWS; j++) {
        for (let i = 0; i < COLS; i++) {
          const k = j * COLS + i;
          let want = tgt[k];
          if (think && j === midRow && tgt[k] > 0 && Math.abs(((i + phase * 9) % 8) - 4) < 1) want = 1;  // dots walking
          this.cur[k] += (want - this.cur[k]) * (blinking ? 0.9 : 0.22);
          const b = this.cur[k];
          if (b < 0.03) continue;
          const flick = 0.93 + 0.07 * Math.sin(phase * 7 + i * 1.3 + j * 0.7);
          g.globalAlpha = Math.min(1, b * boost * flick * this.dim);
          g.drawImage(this.sprite, this.ox + (i + 0.5) * P - S / 2, this.oy + (j + 0.5) * P - S / 2);
        }
      }
      g.globalAlpha = 1;
    }
  }

  // Mood -> expression. Reads the same state the dashboard shows; nothing here invents a feeling.
  Visor.pick = function (now) {
    if (!now) return 'happy';
    const w = (now.mood_words || []).join(' ').toLowerCase();
    const d = now.dials || {}, p = now.pad || {};
    if (/giddy|cherished|loved|adoring|smitten|blissful/.test(w)) return 'heart';
    if (/surprised|curious|puzzled|confused|wonder/.test(w)) return 'curious';
    if (/bratty|smug|mischiev|teasing|cheeky/.test(w)) return 'smug';
    if (/longing|low|sad|lonely|wistful|sentimental|hurt|missing/.test(w)) return 'soft';
    if (/sleepy|tired|drained|exhausted/.test(w) || (p.arousal ?? 0.3) < 0.08) return 'line';
    if (/focused|keyed|alert|protective|intent/.test(w)) return 'open';
    if (/playful|joy|happy|warm|content|settled|glad/.test(w)) return 'happy';
    if ((d.playfulness ?? 0.5) > 0.75) return 'smug';
    return (p.pleasure ?? 0.5) > 0.55 ? 'happy' : 'open';
  };

  window.Visor = Visor;
})();
