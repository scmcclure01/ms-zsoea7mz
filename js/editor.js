// Graph preview, timeline (point) editor and block builder UI.

import { STYLES, strokes, pause, repeat, fmtTime } from './scripts.js?v=202610201921';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// Static preview of a whole script. opts.cursor = ms to mark.
export function drawGraph(canvas, points, opts = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!points?.length) return;
  const t0 = opts.from ?? 0;
  const t1 = opts.to ?? Math.max(1, points[points.length - 1].t);
  const pad = 3;
  const X = (t) => ((t - t0) / (t1 - t0)) * w;
  const Y = (x) => pad + (1 - x / 100) * (h - pad * 2);
  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Y(50));
  ctx.lineTo(w, Y(50));
  ctx.stroke();
  const visible = points.filter((p) => p.t >= t0 && p.t <= t1).length;
  if (visible > w / 3 && opts.cursor == null) return drawOverview(ctx, w, h, points, t0, t1, X, Y);
  ctx.strokeStyle = opts.color || css('--accent');
  ctx.lineWidth = opts.lineWidth || 1.25;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let started = false;
  for (const p of points) {
    if (p.t < t0 - 5000) continue;
    const px = X(p.t);
    if (!started) { ctx.moveTo(px, Y(p.x)); started = true; } else ctx.lineTo(px, Y(p.x));
    if (p.t > t1) break;
  }
  ctx.stroke();
  if (opts.cursor != null) {
    ctx.strokeStyle = css('--text');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(X(opts.cursor), 0);
    ctx.lineTo(X(opts.cursor), h);
    ctx.stroke();
  }
}

// Dense scripts: shaded band = stroke range, line = speed (strokes per minute, top = 200+).
function drawOverview(ctx, w, h, points, t0, t1, X, Y) {
  const cols = Math.max(20, Math.floor(w / 4));
  const span = (t1 - t0) / cols;
  const lo = new Array(cols).fill(null), hi = new Array(cols).fill(null), turns = new Array(cols).fill(0);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const c = Math.floor((p.t - t0) / span);
    if (c < 0 || c >= cols) continue;
    lo[c] = lo[c] == null ? p.x : Math.min(lo[c], p.x);
    hi[c] = hi[c] == null ? p.x : Math.max(hi[c], p.x);
    const a = points[i - 1], b = points[i + 1];
    if (a && b && (p.x - a.x) * (b.x - p.x) < 0 && p.x < a.x) turns[c]++; // count bottoms = strokes
  }
  // slow sections can leave columns without a point: carry the range forward
  for (let c = 1; c < cols; c++) if (lo[c] == null && lo[c - 1] != null && points[points.length - 1].t > t0 + c * span) { lo[c] = lo[c - 1]; hi[c] = hi[c - 1]; }
  const colW = w / cols;
  ctx.fillStyle = css('--accent');
  ctx.globalAlpha = 0.28;
  for (let c = 0; c < cols; c++) {
    if (lo[c] == null) continue;
    const x0 = Math.round(c * colW);
    ctx.fillRect(x0, Y(hi[c]), Math.round((c + 1) * colW) - x0, Math.max(1.5, Y(lo[c]) - Y(hi[c])));
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = css('--accent');
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let started = false;
  for (let c = 0; c < cols; c++) {
    // smooth over 3 columns
    const n = (turns[c - 1] ?? turns[c]) + turns[c] + (turns[c + 1] ?? turns[c]);
    const spm = (n / 3) * (60000 / span);
    const y = Y(Math.min(100, (spm / 200) * 100));
    const x = c * colW + colW / 2;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ---------------- Timeline editor ----------------
export class TimelineEditor {
  constructor(canvas, { onChange, onSelect } = {}) {
    this.canvas = canvas;
    this.points = [];
    this.onChange = onChange || (() => {});
    this.onSelect = onSelect || (() => {});
    this.msPerPx = 40;
    this.scrollT = 0;
    this.mode = 'edit'; // edit | draw | erase
    this.sel = -1;
    this.drag = null;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2);
      else this.scrollBy((e.deltaX || e.deltaY) * this.msPerPx);
    }, { passive: false });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  set(points) {
    this.points = points.map((p) => ({ ...p }));
    this.sel = -1;
    this.scrollT = 0;
    this.draw();
  }
  get pad() { return 14; }
  X(t) { return (t - this.scrollT) / this.msPerPx; }
  T(px) { return px * this.msPerPx + this.scrollT; }
  Y(x) { const h = this.canvas.clientHeight; return this.pad + (1 - x / 100) * (h - this.pad * 2); }
  P(py) { const h = this.canvas.clientHeight; return Math.round(Math.max(0, Math.min(100, (1 - (py - this.pad) / (h - this.pad * 2)) * 100))); }
  zoom(f) {
    const center = this.T(this.canvas.clientWidth / 2);
    this.msPerPx = Math.max(2, Math.min(2000, this.msPerPx * f));
    this.scrollT = Math.max(0, center - (this.canvas.clientWidth / 2) * this.msPerPx);
    this.draw();
  }
  scrollBy(dt) {
    this.scrollT = Math.max(0, this.scrollT + dt);
    this.draw();
  }
  // Fit everything if sparse; otherwise show the first 30 s so points are editable.
  smartFit() {
    if (this.points.length > this.canvas.clientWidth / 8) {
      this.msPerPx = 30000 / Math.max(100, this.canvas.clientWidth);
      this.scrollT = 0;
      this.draw();
    } else this.fitAll();
  }
  fitAll() {
    const end = this.points.length ? this.points[this.points.length - 1].t : 30000;
    this.msPerPx = Math.max(2, (end + 2000) / Math.max(100, this.canvas.clientWidth));
    this.scrollT = 0;
    this.draw();
  }
  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  hit(x, y) {
    let best = -1, bd = 18 * 18;
    this.points.forEach((p, i) => {
      const d = (this.X(p.t) - x) ** 2 + (this.Y(p.x) - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  insert(p) {
    let i = this.points.findIndex((q) => q.t > p.t);
    if (i < 0) i = this.points.length;
    if (this.points[i - 1]?.t === p.t) { this.points[i - 1].x = p.x; return i - 1; }
    this.points.splice(i, 0, p);
    return i;
  }
  down(e) {
    const { x, y } = this.local(e);
    this.canvas.setPointerCapture(e.pointerId);
    const i = this.hit(x, y);
    if (this.mode === 'erase') {
      if (i >= 0) { this.points.splice(i, 1); this.sel = -1; this.changed(); }
      this.drag = { erase: true };
      return;
    }
    if (this.mode === 'draw') {
      this.drag = { draw: true, lastT: -1 };
      this.drawAt(x, y);
      return;
    }
    if (i >= 0) {
      this.sel = i;
      this.drag = { idx: i };
    } else {
      this.sel = this.insert({ t: Math.max(0, Math.round(this.T(x))), x: this.P(y) });
      this.drag = { idx: this.sel };
      this.changed();
    }
    this.onSelect(this.points[this.sel]);
    this.draw();
  }
  drawAt(x, y) {
    const t = Math.max(0, Math.round(this.T(x)));
    const d = this.drag;
    if (d.lastT >= 0 && Math.abs(t - d.lastT) < 80) return;
    // remove points between the last drawn point and this one
    if (d.lastT >= 0) {
      const a = Math.min(d.lastT, t), b = Math.max(d.lastT, t);
      this.points = this.points.filter((p) => p.t <= a || p.t >= b);
    }
    this.insert({ t, x: this.P(y) });
    d.lastT = t;
    this.changed();
  }
  move(e) {
    if (!this.drag) return;
    const { x, y } = this.local(e);
    if (this.drag.erase) {
      const i = this.hit(x, y);
      if (i >= 0) { this.points.splice(i, 1); this.changed(); }
      return;
    }
    if (this.drag.draw) return this.drawAt(x, y);
    const i = this.drag.idx;
    const p = this.points[i];
    const lo = (this.points[i - 1]?.t ?? -1) + 1;
    const hi = (this.points[i + 1]?.t ?? Infinity) - 1;
    p.t = Math.max(0, Math.max(lo, Math.min(hi, Math.round(this.T(x)))));
    p.x = this.P(y);
    this.onSelect(p);
    this.changed();
  }
  up() {
    this.drag = null;
  }
  updateSelected(t, x) {
    const p = this.points[this.sel];
    if (!p) return;
    if (Number.isFinite(x)) p.x = Math.max(0, Math.min(100, Math.round(x)));
    if (Number.isFinite(t)) {
      this.points.splice(this.sel, 1);
      p.t = Math.max(0, Math.round(t));
      this.sel = this.insert(p);
    }
    this.changed();
  }
  deleteSelected() {
    if (this.sel < 0) return;
    this.points.splice(this.sel, 1);
    this.sel = -1;
    this.onSelect(null);
    this.changed();
  }
  changed() {
    this.draw();
    this.onChange(this.points);
  }
  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    // grid: horizontal 0/25/50/75/100, vertical seconds
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = css('--muted');
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    for (const v of [0, 25, 50, 75, 100]) {
      ctx.beginPath();
      ctx.moveTo(0, this.Y(v));
      ctx.lineTo(w, this.Y(v));
      ctx.stroke();
    }
    const steps = [500, 1000, 2000, 5000, 10000, 30000, 60000, 120000, 300000];
    const step = steps.find((s) => s / this.msPerPx > 70) || 600000;
    for (let t = Math.ceil(this.scrollT / step) * step; this.X(t) < w; t += step) {
      const x = this.X(t);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(fmtTime(t) + (step < 1000 ? '.' + String(t % 1000).padStart(3, '0').slice(0, 1) : ''), x + 3, h - 3);
    }
    ctx.fillText('top', 3, this.Y(100) + 11);
    ctx.fillText('bottom', 3, this.Y(0) - 3);
    // path
    const pts = this.points;
    ctx.strokeStyle = css('--accent');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(this.X(p.t), this.Y(p.x)) : ctx.moveTo(this.X(p.t), this.Y(p.x))));
    ctx.stroke();
    // handles (only when zoomed in enough to be useful)
    if (this.msPerPx < 120) {
      pts.forEach((p, i) => {
        const x = this.X(p.t);
        if (x < -10 || x > w + 10) return;
        ctx.fillStyle = i === this.sel ? css('--text') : css('--accent');
        ctx.beginPath();
        ctx.arc(x, this.Y(p.x), i === this.sel ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }
}

// ---------------- Block builder ----------------
const num = (label, value, key, { min = 0, max = 100, step = 1, suffix = '' } = {}) =>
  `<label class="fld"><span>${label}${suffix ? ` (${suffix})` : ''}</span><input type="number" inputmode="decimal" data-k="${key}" value="${value}" min="${min}" max="${max}" step="${step}"></label>`;

export function newBlock(type) {
  if (type === 'pause') return pause(5, 50);
  if (type === 'repeat') return repeat(2, 2);
  return strokes(30, 60, 0, 100);
}

export function renderBlocks(container, blocks, onChange) {
  container.innerHTML = '';
  blocks.forEach((b, i) => {
    const card = document.createElement('div');
    card.className = 'block block-' + b.type;
    let body = '';
    if (b.type === 'stroke') {
      const ramp = b.spm[0] !== b.spm[1] || b.lo[0] !== b.lo[1] || b.hi[0] !== b.hi[1] || b._ramp;
      body = `
        <div class="row">
          ${num('Length', b.dur, 'dur', { min: 1, max: 3600, suffix: 's' })}
          <label class="fld"><span>Style</span><select data-k="style">${Object.entries(STYLES).map(([k, v]) => `<option value="${k}" ${k === b.style ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        </div>
        <label class="chk ramp"><input type="checkbox" data-k="ramp" ${ramp ? 'checked' : ''}> Change gradually (start → end)</label>
        <div class="row">
          ${num(ramp ? 'Speed start' : 'Speed', b.spm[0], 'spm.0', { min: 5, max: 300, suffix: 'spm' })}
          ${ramp ? num('Speed end', b.spm[1], 'spm.1', { min: 5, max: 300, suffix: 'spm' }) : ''}
        </div>
        <div class="row">
          ${num(ramp ? 'Bottom start' : 'Bottom', b.lo[0], 'lo.0')}
          ${num(ramp ? 'Top start' : 'Top', b.hi[0], 'hi.0')}
          ${ramp ? num('Bottom end', b.lo[1], 'lo.1') + num('Top end', b.hi[1], 'hi.1') : ''}
        </div>`;
    } else if (b.type === 'pause') {
      body = `<div class="row">${num('Length', b.dur, 'dur', { min: 1, max: 600, suffix: 's' })}${num('Hold at', b.pos, 'pos', { suffix: '%' })}</div>`;
    } else {
      body = `<div class="row">${num('Repeat the previous', b.count, 'count', { min: 1, max: 50, suffix: 'blocks' })}${num('Extra times', b.times, 'times', { min: 1, max: 50, suffix: '×' })}</div>`;
    }
    const title = b.type === 'stroke' ? 'Strokes' : b.type === 'pause' ? 'Pause' : 'Repeat';
    card.innerHTML = `
      <div class="block-head">
        <strong>${i + 1}. ${title}</strong>
        <span class="block-tools">
          <button class="icon" data-a="up" title="Move up" aria-label="Move up">↑</button>
          <button class="icon" data-a="down" title="Move down" aria-label="Move down">↓</button>
          <button class="icon" data-a="dup" title="Duplicate" aria-label="Duplicate">⧉</button>
          <button class="icon danger" data-a="del" title="Delete" aria-label="Delete">✕</button>
        </span>
      </div>${body}`;
    card.addEventListener('change', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      if (k === 'ramp') {
        if (!e.target.checked) { b.spm[1] = b.spm[0]; b.lo[1] = b.lo[0]; b.hi[1] = b.hi[0]; b._ramp = false; } else b._ramp = true;
        renderBlocks(container, blocks, onChange);
        onChange();
        return;
      }
      const v = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
      if (k.includes('.')) {
        const [a, j] = k.split('.');
        b[a][+j] = v;
        if (!e.target.closest('.block').querySelector('[data-k="ramp"]')?.checked) b[a][1] = v;
      } else b[k] = v;
      onChange();
    });
    card.addEventListener('click', (e) => {
      const a = e.target.dataset.a;
      if (!a) return;
      if (a === 'del') blocks.splice(i, 1);
      if (a === 'dup') blocks.splice(i + 1, 0, structuredClone(b));
      if (a === 'up' && i > 0) [blocks[i - 1], blocks[i]] = [blocks[i], blocks[i - 1]];
      if (a === 'down' && i < blocks.length - 1) [blocks[i + 1], blocks[i]] = [blocks[i], blocks[i + 1]];
      renderBlocks(container, blocks, onChange);
      onChange();
    });
    container.appendChild(card);
  });
  if (!blocks.length) container.innerHTML = '<p class="muted center">No blocks yet — add one below.</p>';
}
