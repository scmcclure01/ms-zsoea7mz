// Script model, compiler, presets, random generator and funscript I/O.
//
// A script is either:
//   { kind: 'blocks', blocks: [...], loop?: bool }   – built from blocks
//   { kind: 'points', points: [{t, x}] }               – raw timeline (ms, 0-100)
//   { kind: 'random', params: {...}, seed }            – endless random generator
// Points use the Handy HSP format: t = milliseconds, x = position 0 (bottom) .. 100 (top).

export const LEAD_IN_MS = 800;

// ---------- seeded RNG ----------
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const newSeed = () => Math.floor(Math.random() * 2 ** 31);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, p) => a + (b - a) * p;
const pair = (v) => (Array.isArray(v) ? v : [v, v]);

// ---------- block constructors ----------
// spm = strokes per minute (one stroke = up + down). lo/hi = bottom/top position.
export function strokes(dur, spm, lo = 0, hi = 100, style = 'smooth', up = 0.5) {
  return { type: 'stroke', dur, spm: pair(spm), lo: pair(lo), hi: pair(hi), style, up };
}
export const pause = (dur, pos = 50) => ({ type: 'pause', dur, pos });
export const repeat = (count, times) => ({ type: 'repeat', count, times });

export const STYLES = {
  smooth: 'Smooth',
  stutter: 'Stutter',
  wave: 'Wave (depth swells)',
  jitter: 'Jitter (unpredictable)',
  flick: 'Flick (fast up, slow down)',
  slam: 'Slam (slow up, fast down)',
};

function expandRepeats(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'repeat') {
      const n = clamp(Math.round(b.count || 1), 1, out.length);
      const seg = out.slice(out.length - n);
      for (let i = 0; i < clamp(Math.round(b.times || 1), 0, 50); i++) out.push(...seg.map((s) => ({ ...s })));
    } else out.push(b);
  }
  return out;
}

export function blocksDuration(blocks) {
  return expandRepeats(blocks).reduce((s, b) => s + (b.dur || 0), 0);
}

// Compile a list of blocks into points starting at time t0 (ms).
export function compileBlocks(blocks, t0 = 0, rand = Math.random) {
  const pts = [];
  let t = t0;
  for (const b of expandRepeats(blocks)) {
    const durMs = Math.max(0, (b.dur || 0) * 1000);
    if (!durMs) continue;
    const end = t + durMs;
    if (b.type === 'pause') {
      pts.push({ t: t + Math.min(700, durMs / 2), x: clamp(b.pos ?? 50, 0, 100) });
      pts.push({ t: end, x: clamp(b.pos ?? 50, 0, 100) });
      t = end;
      continue;
    }
    // stroke block
    const style = b.style || 'smooth';
    let up = clamp(b.up ?? 0.5, 0.15, 0.85);
    if (style === 'flick') up = 0.3;
    if (style === 'slam') up = 0.7;
    const waveMs = 12000;
    let ct = t;
    while (ct < end - 50) {
      const p = (ct - t) / durMs;
      let spm = clamp(lerp(b.spm[0], b.spm[1], p), 5, 300);
      let lo = lerp(b.lo[0], b.lo[1], p);
      let hi = lerp(b.hi[0], b.hi[1], p);
      if (hi < lo) [lo, hi] = [hi, lo];
      if (style === 'jitter') {
        const span = hi - lo;
        spm *= 0.75 + rand() * 0.5;
        lo = clamp(lo + (rand() - 0.5) * span * 0.35, 0, 100);
        hi = clamp(hi + (rand() - 0.5) * span * 0.35, lo + 5, 100);
      }
      if (style === 'wave') {
        const m = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (ct - t)) / waveMs));
        hi = lo + (hi - lo) * m;
      }
      let period = 60000 / spm;
      // don't overshoot the block by more than half a stroke
      if (ct + period > end + period / 2) break;
      if (ct + period > end) period = end - ct;
      const tUp = ct + period * up;
      if (style === 'stutter') {
        const span = hi - lo;
        const upDur = period * up;
        pts.push({ t: ct + upDur * 0.4, x: lo + span * 0.55 });
        pts.push({ t: ct + upDur * 0.6, x: lo + span * 0.4 });
      }
      pts.push({ t: tUp, x: hi });
      pts.push({ t: ct + period, x: lo });
      ct += period;
    }
    t = Math.max(ct, end);
    if (pts.length && pts[pts.length - 1].t < t) pts.push({ t, x: pts[pts.length - 1].x });
  }
  const out = [];
  for (const p of pts) {
    const q = { t: Math.round(p.t), x: Math.round(clamp(p.x, 0, 100)) };
    if (out.length && q.t <= out[out.length - 1].t) continue; // keep times strictly increasing
    out.push(q);
  }
  return out;
}

// ---------- Timeline: lazily-extended point list used by the player ----------
export class Timeline {
  constructor(script) {
    this.script = script;
    this.points = [];
    this.endless = false;
    this.genCount = 0;
    const r = rng(script.seed ?? 1);
    this.rand = r;
    if (script.kind === 'points') {
      this.points = normalizePoints(script.points);
    } else if (script.kind === 'blocks') {
      this.points = [{ t: 0, x: firstPos(script.blocks) }, ...compileBlocks(script.blocks, LEAD_IN_MS, r)];
      this.endless = !!script.loop;
    } else if (script.kind === 'random') {
      this.endless = true;
      this.points = [{ t: 0, x: 50 }];
      this.extend();
    }
  }
  get duration() {
    return this.endless ? Infinity : this.points.length ? this.points[this.points.length - 1].t : 0;
  }
  get lastT() {
    return this.points.length ? this.points[this.points.length - 1].t : 0;
  }
  extend() {
    const t0 = this.lastT;
    let blocks;
    if (this.script.kind === 'random') {
      blocks = randomBlocks({ ...this.script.params, minutes: 2 }, this.rand, this.genCount);
    } else {
      blocks = this.script.blocks;
    }
    this.genCount++;
    const add = compileBlocks(blocks, t0, this.rand).filter((p) => p.t > t0);
    if (!add.length) return false;
    this.points.push(...add);
    return true;
  }
  // make sure points exist up to time t (ms)
  ensure(t) {
    let guard = 0;
    while (this.endless && this.lastT < t && guard++ < 500) if (!this.extend()) break;
  }
  positionAt(t) {
    const p = this.points;
    if (!p.length) return 50;
    if (t <= p[0].t) return p[0].x;
    let lo = 0, hi = p.length - 1;
    if (t >= p[hi].t) return p[hi].x;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (p[m].t <= t) lo = m; else hi = m;
    }
    const a = p[lo], b = p[hi];
    return a.x + ((b.x - a.x) * (t - a.t)) / Math.max(1, b.t - a.t);
  }
  // index of first point with t >= time
  indexAt(t) {
    const p = this.points;
    let lo = 0, hi = p.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (p[m].t < t) lo = m + 1; else hi = m;
    }
    return lo;
  }
}

function firstPos(blocks) {
  const b = expandRepeats(blocks)[0];
  if (!b) return 50;
  return b.type === 'pause' ? b.pos ?? 50 : b.lo[0];
}

export function normalizePoints(points) {
  const out = points
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.x))
    .map((p) => ({ t: Math.max(0, Math.round(p.t)), x: Math.round(clamp(p.x, 0, 100)) }))
    .sort((a, b) => a.t - b.t);
  // drop duplicate timestamps
  return out.filter((p, i) => i === 0 || p.t !== out[i - 1].t);
}

// ---------- shaping (safety caps applied right before sending to the device) ----------
// maxVel: maximum speed in position-units per second (100 = one full stroke length per second).
// easeMs: amplitude ramps from 30% to 100% over the first easeMs of the script.
export function shapePoints(points, prev, { maxVel = Infinity, easeMs = 0, rate = 1 } = {}) {
  const out = [];
  let last = prev ? { ...prev } : null;
  for (const p of points) {
    let x = p.x;
    if (easeMs > 0 && p.t < easeMs) {
      const f = 0.3 + 0.7 * (p.t / easeMs);
      x = 50 + (x - 50) * f;
    }
    x = Math.round(clamp(x, 0, 100));
    if (last && Number.isFinite(maxVel)) {
      const dt = Math.max(1, (p.t - last.t) / rate);
      const maxDx = Math.floor((maxVel * dt) / 1000);
      x = clamp(x, last.x - maxDx, last.x + maxDx);
    }
    const q = { t: p.t, x };
    out.push(q);
    last = q;
  }
  return out;
}

// ---------- random generator ----------
// params: { minutes (0 = endless), spmMin, spmMax, lo, hi, chaos 0-100, arc: 'flat'|'build'|'waves' }
export function randomBlocks(params, rand = Math.random, offsetIdx = 0) {
  const {
    minutes = 10, spmMin = 40, spmMax = 140, lo = 0, hi = 100, chaos = 40, arc = 'flat',
  } = params;
  const total = minutes * 60;
  const c = chaos / 100;
  const blocks = [];
  let t = 0;
  let prevSpm = spmMin + (spmMax - spmMin) * 0.3;
  const styles = ['smooth', 'smooth', 'smooth', 'wave', 'stutter', 'jitter', 'flick', 'slam'];
  let i = 0;
  while (t < total) {
    const p = t / total;
    let level; // 0..1 intensity target
    if (arc === 'build') level = 0.15 + 0.85 * p;
    else if (arc === 'waves') level = 0.5 - 0.45 * Math.cos(2 * Math.PI * (p * 3 + offsetIdx * 0.37));
    else level = 0.5;
    level = clamp(level + (rand() - 0.5) * (0.3 + c), 0, 1);
    const dur = Math.round(lerp(20, 60, rand()) * (1.2 - c * 0.7));
    const target = lerp(spmMin, spmMax, level);
    // pauses become more common with chaos
    if (i > 0 && rand() < 0.04 + c * 0.12) {
      blocks.push(pause(Math.round(3 + rand() * 8 * (0.5 + c)), Math.round(lerp(lo, hi, rand()))));
      t += blocks[blocks.length - 1].dur;
      i++;
      continue;
    }
    // stroke range: higher chaos picks narrower/odd sub-ranges more often
    let bLo = lo, bHi = hi;
    if (rand() < 0.2 + c * 0.5) {
      const span = (hi - lo) * lerp(0.35, 0.8, rand());
      bLo = lo + rand() * (hi - lo - span);
      bHi = bLo + span;
    }
    const style = rand() < 0.35 + c * 0.6 ? styles[Math.floor(rand() * styles.length)] : 'smooth';
    blocks.push(strokes(Math.max(8, dur), [Math.round(prevSpm), Math.round(target)], Math.round(bLo), Math.round(bHi), style));
    prevSpm = target;
    t += Math.max(8, dur);
    i++;
  }
  return blocks;
}

export function surpriseParams(caps = {}) {
  const r = Math.random;
  const spmMax = Math.round(lerp(90, 180, r()));
  return {
    minutes: [5, 10, 15, 20][Math.floor(r() * 4)],
    spmMin: Math.round(lerp(25, 60, r())),
    spmMax: Math.min(spmMax, caps.spmMax ?? 300),
    lo: Math.round(r() < 0.7 ? 0 : lerp(0, 30, r())),
    hi: Math.round(r() < 0.7 ? 100 : lerp(70, 100, r())),
    chaos: Math.round(lerp(15, 85, r())),
    arc: ['flat', 'build', 'waves'][Math.floor(r() * 3)],
  };
}

// ---------- presets ----------
function edging(minutes, finish = true) {
  const total = minutes * 60;
  const finishDur = finish ? Math.min(150, total * 0.15) : 0;
  const cycleLen = minutes <= 10 ? 150 : 240;
  const cycles = Math.max(2, Math.round((total - finishDur) / cycleLen));
  const len = (total - finishDur) / cycles;
  const out = [];
  for (let c = 0; c < cycles; c++) {
    const k = cycles === 1 ? 1 : c / (cycles - 1);
    const peak = Math.round(lerp(110, 175, k));
    const build = Math.round(len * 0.62);
    const hold = Math.round(len * 0.16);
    const cool = Math.round(len * 0.22);
    out.push(strokes(build, [45, peak], [35, 0], [75, 100]));
    out.push(strokes(hold, peak, 0, 100, c % 2 ? 'jitter' : 'smooth'));
    out.push(pause(Math.round(cool * 0.4), 70));
    out.push(strokes(Math.round(cool * 0.6), [30, 40], 55, 85));
  }
  if (finish) {
    out.push(strokes(Math.round(finishDur * 0.6), [120, 185], 0, 100));
    out.push(strokes(Math.round(finishDur * 0.4), 190, 0, 100));
  }
  return out;
}

function session(minutes, recipe) {
  const total = minutes * 60;
  const out = [];
  for (const [frac, stage] of recipe) out.push(...STAGES[stage](Math.max(20, Math.round(total * frac))));
  return out;
}

const STAGES = {
  warmup: (d) => [strokes(d * 0.5, [30, 50], [40, 15], [80, 100]), strokes(d * 0.5, [50, 70], 0, 100, 'wave')],
  build: (d) => [
    strokes(d * 0.35, [70, 100], 0, 100),
    strokes(d * 0.15, 95, 40, 100, 'stutter'),
    strokes(d * 0.5, [100, 135], 0, 100),
  ],
  tease: (d) => [
    strokes(d * 0.25, 90, 65, 100, 'flick'),
    pause(Math.max(4, d * 0.06), 80),
    strokes(d * 0.2, [40, 140], 0, 100),
    pause(Math.max(4, d * 0.06), 50),
    strokes(d * 0.23, 60, 30, 100, 'stutter'),
    strokes(d * 0.2, 25, 0, 100),
  ],
  finish: (d) => [strokes(d * 0.55, [130, 180], 0, 100), strokes(d * 0.45, 190, 0, 100, 'slam')],
  slowburn: (d) => [strokes(d, [20, 45], 0, 100, 'wave')],
};

export const LENGTH_CHOICES = [10, 15, 20, 30, 45, 60];

// Each preset: { id, group, name, desc, build(minutes) -> blocks, loop?, lengths? }
export const PRESETS = [
  // Steady (loop until stopped)
  { id: 'st-slow', group: 'Steady', name: 'Slow & full', desc: 'Long, unhurried full strokes.', loop: true, build: () => [strokes(60, 40, 0, 100)] },
  { id: 'st-med', group: 'Steady', name: 'Medium & full', desc: 'A comfortable steady tempo.', loop: true, build: () => [strokes(60, 80, 0, 100)] },
  { id: 'st-fast', group: 'Steady', name: 'Fast & full', desc: 'Quick full-length strokes.', loop: true, build: () => [strokes(60, 150, 0, 100)] },
  { id: 'st-tip', group: 'Steady', name: 'Tip focus', desc: 'Short strokes at the top only.', loop: true, build: () => [strokes(60, 110, 60, 100)] },
  { id: 'st-base', group: 'Steady', name: 'Deep & short', desc: 'Short strokes at the bottom.', loop: true, build: () => [strokes(60, 100, 0, 40)] },
  { id: 'st-deep-slow', group: 'Steady', name: 'Slow-motion', desc: 'Very slow full strokes, savor every inch.', loop: true, build: () => [strokes(60, 18, 0, 100)] },

  // Edging
  { id: 'ed-10', group: 'Build-ups & edging', name: 'Edge 10', desc: 'Short ramp-and-back-off cycles, finish at the end.', build: () => edging(10) },
  { id: 'ed-20', group: 'Build-ups & edging', name: 'Edge 20', desc: 'Several climbs that get higher each time, then finish.', build: () => edging(20) },
  { id: 'ed-30', group: 'Build-ups & edging', name: 'Edge 30', desc: 'Long session of rising peaks and cool-downs, then finish.', build: () => edging(30) },
  { id: 'ed-loop', group: 'Build-ups & edging', name: 'Endless edging', desc: 'Climb, back off, repeat — no finish. Runs until you stop.', loop: true, build: () => edging(10, false) },
  { id: 'ed-ramp', group: 'Build-ups & edging', name: 'Slow ramp', desc: 'One continuous climb from slow to fast.', lengths: true, build: (m) => [strokes(m * 60 * 0.9, [25, 170], [40, 0], [70, 100]), strokes(m * 60 * 0.1, 175, 0, 100)] },

  // Teasing / variety
  { id: 'te-stutter', group: 'Teasing & variety', name: 'Stutter tease', desc: 'Hesitating strokes that catch halfway up.', loop: true, build: () => [strokes(40, 60, 20, 100, 'stutter'), strokes(20, 40, 0, 100)] },
  { id: 'te-waves', group: 'Teasing & variety', name: 'Waves', desc: 'Depth swells in and out like a tide.', loop: true, build: () => [strokes(60, 70, 0, 100, 'wave')] },
  { id: 'te-burst', group: 'Teasing & variety', name: 'Burst & rest', desc: 'Fast bursts broken up by pauses.', loop: true, build: () => [strokes(10, 160, 0, 100), pause(6, 90), strokes(15, 50, 0, 100), strokes(8, 170, 30, 100), pause(5, 60)] },
  { id: 'te-tip', group: 'Teasing & variety', name: 'Tip flicks', desc: 'Quick tip flicks with pauses in between.', loop: true, build: () => [strokes(12, 140, 70, 100, 'flick'), pause(5, 95), strokes(8, 40, 30, 100), pause(4, 80)] },
  { id: 'te-chaos', group: 'Teasing & variety', name: 'Unpredictable', desc: 'Jittery tempo and depth — never quite the same.', loop: true, build: () => [strokes(60, 90, 0, 100, 'jitter')] },
  { id: 'te-slam', group: 'Teasing & variety', name: 'Slow up, fast down', desc: 'Lingering upstroke, sudden downstroke.', loop: true, build: () => [strokes(60, 55, 0, 100, 'slam')] },

  // Sessions
  { id: 'se-classic', group: 'Sessions', name: 'Classic', desc: 'Warm-up → build → tease → finish.', lengths: true, build: (m) => session(m, [[0.15, 'warmup'], [0.35, 'build'], [0.25, 'tease'], [0.25, 'finish']]) },
  { id: 'se-tease', group: 'Sessions', name: 'Tease-heavy', desc: 'Short warm-up, long tease, quick finish.', lengths: true, build: (m) => session(m, [[0.1, 'warmup'], [0.15, 'build'], [0.55, 'tease'], [0.2, 'finish']]) },
  { id: 'se-slow', group: 'Sessions', name: 'Slow burn', desc: 'Very slow for a long time, then everything.', lengths: true, build: (m) => session(m, [[0.45, 'slowburn'], [0.2, 'warmup'], [0.2, 'build'], [0.15, 'finish']]) },
  { id: 'se-quick', group: 'Sessions', name: 'Quickie', desc: 'Brief warm-up straight into a strong finish.', lengths: true, build: (m) => session(m, [[0.1, 'warmup'], [0.4, 'build'], [0.5, 'finish']]) },
];

export function presetScript(preset, minutes = 20) {
  return {
    id: 'preset:' + preset.id,
    name: preset.name + (preset.lengths ? ` (${minutes} min)` : ''),
    kind: 'blocks',
    blocks: preset.build(minutes),
    loop: !!preset.loop,
    seed: newSeed(),
  };
}

// ---------- funscript I/O ----------
export function toFunscript(points, name = 'script') {
  return {
    version: '1.0',
    inverted: false,
    range: 100,
    metadata: { title: name, creator: 'Handy Control' },
    actions: points.map((p) => ({ at: p.t, pos: p.x })),
  };
}

export function fromFunscript(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || !Array.isArray(data.actions)) throw new Error('Not a funscript (no "actions" list).');
  const inv = !!data.inverted;
  return normalizePoints(data.actions.map((a) => ({ t: Number(a.at), x: inv ? 100 - Number(a.pos) : Number(a.pos) })));
}

// Points for previews/export of any script (endless scripts are previewed for `previewMin` minutes).
export function scriptPoints(script, previewMin = 10) {
  const tl = new Timeline(script);
  if (tl.endless) tl.ensure(previewMin * 60000);
  return tl.points;
}

export function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '∞';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
