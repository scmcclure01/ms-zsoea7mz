import {
  PRESETS, LENGTH_CHOICES, presetScript, randomBlocks, surpriseParams, blocksDuration, scriptPoints,
  toFunscript, fromFunscript, fmtTime, newSeed, rng, strokes, compileBlocks, STYLES, Timeline, LEAD_IN_MS,
} from './scripts.js';
import { autoConnect, SimDriver } from './api.js';
import { Engine } from './engine.js';
import { drawGraph, TimelineEditor, renderBlocks, newBlock } from './editor.js';
import {
  loadSettings, saveSettings, loadLibrary, saveLibrary, uid, download, pickFile, backupData,
} from './storage.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let settings = loadSettings();
let library = loadLibrary();
const engine = new Engine(settings);
let connInfo = null;

// ---------------- toast & modal ----------------
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), err ? 5000 : 2600);
}
function modal(title, bodyHtml, okLabel = 'OK') {
  const d = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-ok').textContent = okLabel;
  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? d : null), { once: true });
  });
}
const confirmBox = (title, text, ok = 'OK') => modal(title, `<p class="muted">${esc(text)}</p>`, ok);

engine.addEventListener('error', (e) => toast(e.detail, true));
engine.addEventListener('notice', (e) => toast(e.detail));

// ---------------- tabs ----------------
function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  try { localStorage.setItem('handyctl.tab', name); } catch {}
  if (name === 'create') requestAnimationFrame(() => { updateCreatePreview(); tlEditor.draw(); });
  if (name === 'play') renderLibrary();
  updateNow();
  window.scrollTo({ top: 0 });
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});
$('#conn-pill').addEventListener('click', () => showTab('settings'));

// ---------------- connection ----------------
function setPill(kind, text) {
  const p = $('#conn-pill');
  p.className = 'pill ' + kind;
  $('#conn-text').textContent = text;
}
async function connect(showToast = true) {
  if (engine.state !== 'idle') await engine.stop();
  const key = settings.connectionKey.trim();
  if (!key) {
    engine.setDriver(new SimDriver());
    connInfo = { api: 'demo' };
    setPill('demo', 'Demo mode');
    $('#conn-detail').textContent = 'Demo mode: everything works on screen, nothing is sent to a device.';
    return;
  }
  setPill('', 'Connecting…');
  $('#conn-detail').textContent = 'Connecting…';
  try {
    const { driver, info } = await autoConnect(key, settings.appId.trim());
    engine.setDriver(driver);
    connInfo = info;
    setPill('ok', `Connected · ${info.api}`);
    const upd = info.fwStatus === 1 ? ' — firmware update REQUIRED' : info.fwStatus === 2 ? ' — firmware update available' : '';
    $('#conn-detail').textContent = `Connected via API ${info.api}. Model ${info.model ?? '?'}, firmware ${info.fw ?? '?'}${upd}.` +
      (info.api === 'v2' ? ' Older firmware: speed changes and endless mode cause a brief pause while the script re-uploads.' : '');
    driver.setStroke(settings.strokeMin, settings.strokeMax).catch(() => {});
    if (showToast) toast('Connected to your Handy');
  } catch (e) {
    engine.setDriver(new SimDriver());
    connInfo = null;
    setPill('err', 'Not connected');
    let msg = e.message;
    if (!settings.appId.trim()) msg += ' — If your Handy has firmware 4 or newer, you also need an Application ID.';
    $('#conn-detail').textContent = msg;
    if (showToast) toast('Could not connect: ' + e.message, true);
  }
}

// ---------------- play tab / dock ----------------
const liveCanvas = $('#live-graph');
function updateNow() {
  const st = engine.state;
  const s = engine.script;
  const name = st === 'manual' ? 'Manual control' : s?.name || (st === 'cooldown' ? 'Cooling down' : 'Nothing playing');
  const label = { idle: 'Idle', playing: 'Playing', cooldown: 'Cooling down', manual: 'Manual' }[st];
  $('#now-state').textContent = label;
  $('#now-name').textContent = name;
  $('#dock-name').textContent = st === 'idle' ? 'Ready' : name;
  $('#too-close').disabled = !(st === 'playing' || st === 'manual' || st === 'cooldown');
  $('#too-close').textContent = st === 'cooldown' ? '+ More time' : 'Too close';
  $('#dock').classList.toggle('cooldown', st === 'cooldown');
  const active = st !== 'idle';
  $('#dock-extra').hidden = !active;
  $('#dock-limits').hidden = !active;
  document.body.classList.toggle('active', active);
  $('#dock-rate').textContent = st === 'manual' ? engine.manualVel + '%' : Math.round(engine.rate * 100) + '%';
  $('#dock-view').hidden = $('#tab-play').classList.contains('active');
  $('#dock-resume').hidden = st !== 'cooldown';
  $('#dock-extra .stepper').hidden = st === 'cooldown';
  $('#rate').value = Math.round(engine.rate * 100);
  $('#rate-val').textContent = Math.round(engine.rate * 100) + '%';
}
engine.addEventListener('state', updateNow);

let manualPhase = 0, lastFrame = performance.now();
function frame(now) {
  const dt = now - lastFrame;
  lastFrame = now;
  const st = engine.state;
  let pos = engine.position();
  if (st === 'manual') {
    // approximate visual for manual mode
    manualPhase += (dt / 1000) * (0.2 + engine.manualVel / 100 * 3);
    const lo = settings.strokeMin, hi = settings.strokeMax;
    pos = lo + (hi - lo) * (0.5 - 0.5 * Math.cos(manualPhase * Math.PI * 2));
  }
  if (pos != null) {
    const lo = settings.strokeMin, hi = settings.strokeMax;
    const shown = st === 'manual' ? pos : lo + (pos / 100) * (hi - lo);
    $('#rail-knob').style.setProperty('--pos', shown.toFixed(1));
    $('#mini-knob').style.setProperty('--pos', shown.toFixed(1));
  }
  // live graph window: 5 s back, 15 s ahead
  if ($('#tab-play').classList.contains('active')) {
    if (engine.tl && (st === 'playing' || st === 'cooldown')) {
      const t = engine.t;
      engine.tl.ensure(t + 20000);
      drawGraph(liveCanvas, engine.tl.points, { from: t - 5000, to: t + 15000, cursor: t, lineWidth: 2 });
    } else drawGraph(liveCanvas, [], {});
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

engine.addEventListener('tick', () => {
  const st = engine.state;
  let sub = 'Pick something to play';
  let pct = 0;
  if (st === 'playing' && engine.tl) {
    const t = engine.t;
    const d = engine.tl.duration;
    sub = `${fmtTime(t)} / ${fmtTime(d)} · ${Math.round(engine.rate * 100)}% speed`;
    pct = Number.isFinite(d) ? (t / d) * 100 : 0;
    $('#now-time').textContent = fmtTime(t);
  } else if (st === 'cooldown') {
    const left = Math.max(0, engine.cooldownEnd - performance.now());
    sub = `Paused · resuming in ${Math.ceil(left / 1000)} s`;
    $('#now-time').textContent = '−' + Math.ceil(left / 1000) + 's';
  } else if (st === 'manual') {
    sub = `Manual · speed ${engine.manualVel}%`;
    $('#now-time').textContent = fmtTime(performance.now() - engine.sessionStart);
  } else {
    $('#now-time').textContent = '0:00';
  }
  if (settings.maxSessionMin > 0 && st !== 'idle') {
    const left = settings.maxSessionMin * 60000 - (performance.now() - engine.sessionStart);
    sub += ` · limit in ${fmtTime(left)}`;
  }
  $('#dock-sub').textContent = sub;
  $('#progress-bar').style.width = Math.min(100, pct) + '%';
  $('#dock-bar').style.width = Math.min(100, pct) + '%';
});

$('#stop').addEventListener('click', () => engine.stop());
function stepSpeed(dir) {
  if (engine.state === 'manual') {
    engine.setManualVelocity(Math.max(0, Math.min(100, engine.manualVel + dir * 5)));
    $('#man-vel').value = engine.manualVel;
    $('#man-vel-val').textContent = engine.manualVel + '%';
  } else engine.setRate(Math.round(engine.rate * 10 + dir) / 10);
}
$('#dock-slower').addEventListener('click', () => stepSpeed(-1));
$('#dock-faster').addEventListener('click', () => stepSpeed(1));
$('#dock-view').addEventListener('click', () => showTab('play'));
$('#dock-resume').addEventListener('click', () => engine.resumeNow());
// keep page padding / tab bar position matched to the dock's real height
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--dock-h', $('#dock').offsetHeight + 'px');
}).observe($('#dock'));
$('#too-close').addEventListener('click', () => engine.tooClose());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') engine.stop();
});

$('#rate').addEventListener('input', (e) => engine.setRate(Number(e.target.value) / 100));

// stroke limit sliders (Play + Manual tabs share them)
function syncStrokeUI() {
  $$('#stroke-min, .stroke-min').forEach((i) => (i.value = settings.strokeMin));
  $$('#stroke-max, .stroke-max').forEach((i) => (i.value = settings.strokeMax));
  $$('#smin-val, .smin-mirror').forEach((b) => (b.textContent = settings.strokeMin));
  $$('#smax-val, .smax-mirror').forEach((b) => (b.textContent = settings.strokeMax));
}
function setStroke(min, max, which) {
  min = Number(min); max = Number(max);
  if (max - min < 5) {
    if (which === 'min') max = Math.min(100, min + 5);
    else min = Math.max(0, max - 5);
  }
  settings.strokeMin = min;
  settings.strokeMax = max;
  saveSettings(settings);
  syncStrokeUI();
  engine.setStroke(min, max);
}
$$('#stroke-min, .stroke-min').forEach((i) => i.addEventListener('input', () => setStroke(i.value, settings.strokeMax, 'min')));
$$('#stroke-max, .stroke-max').forEach((i) => i.addEventListener('input', () => setStroke(settings.strokeMin, i.value, 'max')));

// ---------------- library ----------------
function scriptMeta(s) {
  if (s.kind === 'points') return s.points.length ? fmtTime(s.points[s.points.length - 1].t) : '0:00';
  if (s.kind === 'blocks') return s.loop ? `${fmtTime((blocksDuration(s.blocks)) * 1000)} loop` : fmtTime(blocksDuration(s.blocks) * 1000 + LEAD_IN_MS);
  return '∞';
}
function graphLater(canvas, script) {
  requestAnimationFrame(() => {
    try { drawGraph(canvas, scriptPoints(script, 3)); } catch {}
  });
}
function renderLibrary() {
  const el = $('#library');
  el.innerHTML = '';
  if (!library.length) {
    el.innerHTML = '<p class="muted">No saved scripts yet. Build one in <b>Create</b>, save one from <b>Random</b>, customize a <b>Preset</b>, or import a .funscript.</p>';
    return;
  }
  for (const s of library) {
    const it = document.createElement('div');
    it.className = 'item';
    it.innerHTML = `
      <div class="item-head"><strong>${esc(s.name)}</strong><span class="tag">${scriptMeta(s)}</span></div>
      <canvas class="graph"></canvas>
      <div class="btns">
        <button class="btn primary sm" data-a="play">▶ Play</button>
        <button class="btn ghost sm" data-a="edit">Edit</button>
        <button class="btn ghost sm" data-a="export">Export</button>
        <button class="btn ghost sm danger" data-a="del">Delete</button>
      </div>`;
    graphLater($('canvas', it), s);
    it.addEventListener('click', async (e) => {
      const a = e.target.dataset.a;
      if (a === 'play') playScript(s);
      if (a === 'edit') openInCreate(s, true);
      if (a === 'export') download(fileName(s.name), toFunscript(scriptPoints(s, 30), s.name));
      if (a === 'del' && (await confirmBox('Delete script?', `"${s.name}" will be removed from this browser.`, 'Delete'))) {
        library = library.filter((x) => x.id !== s.id);
        saveLibrary(library);
        renderLibrary();
      }
    });
    el.appendChild(it);
  }
}
const fileName = (n) => (n || 'script').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.funscript';

function saveToLibrary(script) {
  const now = Date.now();
  const i = library.findIndex((x) => x.id === script.id);
  const rec = { ...structuredClone(script), updated: now };
  if (i >= 0) library[i] = rec;
  else library.unshift({ ...rec, id: script.id || uid(), created: now });
  if (!saveLibrary(library)) {
    toast('Could not save — browser storage is full or blocked. Export a backup.', true);
    return null;
  }
  return i >= 0 ? library[i] : library[0];
}

$('#lib-import').addEventListener('click', async () => {
  const files = await pickFile('.funscript,.json');
  let n = 0;
  for (const f of files) {
    try {
      const pts = fromFunscript(f.text);
      saveToLibrary({ id: uid(), name: f.name.replace(/\.(funscript|json)$/i, ''), kind: 'points', points: pts });
      n++;
    } catch (e) {
      toast(`${f.name}: ${e.message}`, true);
    }
  }
  if (n) toast(`Imported ${n} script${n > 1 ? 's' : ''}`);
  renderLibrary();
});
$('#lib-new').addEventListener('click', () => { newCreate(); showTab('create'); });

function playScript(script) {
  engine.play(structuredClone({ seed: newSeed(), ...script }));
  updateNow();
}

// ---------------- manual ----------------
$('#man-vel').addEventListener('input', (e) => {
  const v = Math.min(Number(e.target.value), settings.maxSpeed);
  e.target.value = v;
  $('#man-vel-val').textContent = v + '%';
  engine.setManualVelocity(v);
});
$('#man-start').addEventListener('click', () => {
  if (engine.state === 'manual') return engine.stop();
  engine.startManual(Number($('#man-vel').value));
});
engine.addEventListener('state', () => {
  $('#man-start').textContent = engine.state === 'manual' ? '■ Stop manual' : 'Start manual';
  if (engine.state === 'manual') {
    $('#man-vel').value = engine.manualVel;
    $('#man-vel-val').textContent = engine.manualVel + '%';
  }
});
$$('[data-zone]').forEach((b) => b.addEventListener('click', () => {
  const [a, c] = b.dataset.zone.split(',').map(Number);
  setStroke(a, c);
}));

// ---------------- presets ----------------
function renderPresets() {
  const el = $('#presets');
  el.innerHTML = '';
  const groups = [...new Set(PRESETS.map((p) => p.group))];
  for (const g of groups) {
    const h = document.createElement('h3');
    h.className = 'group-title';
    h.textContent = g;
    el.appendChild(h);
    const list = document.createElement('div');
    list.className = 'list';
    for (const p of PRESETS.filter((x) => x.group === g)) {
      const it = document.createElement('div');
      it.className = 'item';
      const lenSel = p.lengths
        ? `<select data-k="len">${LENGTH_CHOICES.map((m) => `<option value="${m}" ${m === 20 ? 'selected' : ''}>${m} min</option>`).join('')}</select>`
        : '';
      const tag = p.loop ? 'loops' : p.lengths ? '' : fmtTime(blocksDuration(p.build(20)) * 1000);
      it.innerHTML = `
        <div class="item-head"><strong>${esc(p.name)}</strong>${tag ? `<span class="tag">${tag}</span>` : ''}</div>
        <div class="desc">${esc(p.desc)}</div>
        <canvas class="graph"></canvas>
        <div class="btns">
          <button class="btn primary sm" data-a="play">▶ Play</button>
          <button class="btn ghost sm" data-a="custom">Customize</button>
          ${lenSel}
        </div>`;
      const canvas = $('canvas', it);
      const len = () => Number($('[data-k=len]', it)?.value || 20);
      const redraw = () => graphLater(canvas, { ...presetScript(p, len()), seed: 7 });
      redraw();
      $('[data-k=len]', it)?.addEventListener('change', redraw);
      it.addEventListener('click', (e) => {
        const a = e.target.dataset.a;
        if (a === 'play') playScript(presetScript(p, len()));
        if (a === 'custom') {
          const s = presetScript(p, len());
          openInCreate({ ...s, id: null, name: s.name + ' (custom)' }, false);
        }
      });
      list.appendChild(it);
    }
    el.appendChild(list);
  }
}

// ---------------- random ----------------
const rd = { arc: 'flat', last: null };
const rdFields = [
  ['rd-min', (v) => `${v} min`],
  ['rd-chaos', (v) => (v < 25 ? 'calm' : v < 60 ? 'some' : v < 85 ? 'lots' : 'wild') + ` (${v})`],
  ['rd-smin', (v) => `${v} spm`],
  ['rd-smax', (v) => `${v} spm`],
  ['rd-lo', (v) => v],
  ['rd-hi', (v) => v],
];
function rdUpdateLabels() {
  for (const [id, f] of rdFields) $(`#${id}-val`).textContent = f($('#' + id).value);
}
rdFields.forEach(([id]) => $('#' + id).addEventListener('input', () => {
  // keep ranges sane
  if (+$('#rd-smax').value < +$('#rd-smin').value + 10) $(id === 'rd-smin' ? '#rd-smax' : '#rd-smin').value = id === 'rd-smin' ? +$('#rd-smin').value + 10 : +$('#rd-smax').value - 10;
  if (+$('#rd-hi').value < +$('#rd-lo').value + 15) $(id === 'rd-lo' ? '#rd-hi' : '#rd-lo').value = id === 'rd-lo' ? +$('#rd-lo').value + 15 : +$('#rd-hi').value - 15;
  rdUpdateLabels();
}));
$('#rd-arc').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  rd.arc = b.dataset.v;
  $$('#rd-arc button').forEach((x) => x.classList.toggle('active', x === b));
});
function rdParams() {
  return {
    minutes: +$('#rd-min').value, chaos: +$('#rd-chaos').value, spmMin: +$('#rd-smin').value, spmMax: +$('#rd-smax').value,
    lo: +$('#rd-lo').value, hi: +$('#rd-hi').value, arc: rd.arc,
  };
}
function setRdParams(p) {
  $('#rd-min').value = p.minutes; $('#rd-chaos').value = p.chaos; $('#rd-smin').value = p.spmMin; $('#rd-smax').value = p.spmMax;
  $('#rd-lo').value = p.lo; $('#rd-hi').value = p.hi;
  rd.arc = p.arc;
  $$('#rd-arc button').forEach((x) => x.classList.toggle('active', x.dataset.v === p.arc));
  rdUpdateLabels();
}
let rdCount = 0;
function generateRandom(params) {
  const seed = newSeed();
  const blocks = randomBlocks(params, rng(seed));
  rdCount++;
  const script = { id: null, name: `Random #${rdCount} (${params.minutes} min)`, kind: 'blocks', blocks, seed };
  rd.last = script;
  $('#rnd-result').hidden = false;
  $('#rnd-title').textContent = script.name;
  $('#rnd-dur').textContent = fmtTime(blocksDuration(blocks) * 1000);
  graphLater($('#rnd-graph'), script);
  return script;
}
$('#rnd-gen').addEventListener('click', () => generateRandom(rdParams()));
$('#rnd-again').addEventListener('click', () => generateRandom(rdParams()));
$('#rnd-play').addEventListener('click', () => rd.last && playScript(rd.last));
$('#rnd-save').addEventListener('click', () => {
  if (!rd.last) return;
  const saved = saveToLibrary({ ...rd.last, id: uid() });
  if (saved) toast('Saved to My scripts');
});
$('#rnd-edit').addEventListener('click', () => rd.last && openInCreate({ ...rd.last, id: null }, false));
$('#rnd-surprise').addEventListener('click', () => {
  const p = surpriseParams({ spmMax: 60 + settings.maxSpeed * 1.4 });
  setRdParams(p);
  playScript(generateRandom(p));
});
$('#rnd-endless').addEventListener('click', () => {
  const params = rdParams();
  playScript({ id: null, name: 'Endless random', kind: 'random', params, seed: newSeed() });
});

// ---------------- create ----------------
const cr = { id: null, mode: 'blocks', blocks: [], loop: false, points: [] };
const tlEditor = new TimelineEditor($('#tl-canvas'), {
  onChange: (pts) => { cr.points = pts; updateCreatePreview(); },
  onSelect: (p) => {
    $('#tl-sel').hidden = !p;
    if (p) { $('#tl-sel-t').value = (p.t / 1000).toFixed(2); $('#tl-sel-x').value = p.x; }
  },
});
function currentCreateScript() {
  const name = $('#cr-name').value.trim() || 'Untitled';
  if (cr.mode === 'timeline') return { id: cr.id, name, kind: 'points', points: cr.points };
  return { id: cr.id, name, kind: 'blocks', blocks: cr.blocks, loop: cr.loop, seed: cr.seed ?? 1 };
}
function updateCreatePreview() {
  const s = currentCreateScript();
  let pts = [];
  try { pts = scriptPoints(s, 3); } catch {}
  drawGraph($('#cr-graph'), pts);
  const dur = pts.length ? pts[pts.length - 1].t : 0;
  $('#cr-info').textContent = cr.mode === 'blocks'
    ? `${cr.blocks.length} block${cr.blocks.length === 1 ? '' : 's'} · ${fmtTime(blocksDuration(cr.blocks) * 1000)}${cr.loop ? ' · loops until stopped' : ''}`
    : `${cr.points.length} points · ${fmtTime(dur)}`;
}
function setCreateMode(mode) {
  cr.mode = mode;
  $$('#cr-mode button').forEach((b) => b.classList.toggle('active', b.dataset.v === mode));
  $('#cr-blocks-pane').hidden = mode !== 'blocks';
  $('#cr-timeline-pane').hidden = mode !== 'timeline';
  if (mode === 'timeline') requestAnimationFrame(() => { tlEditor.draw(); });
  updateCreatePreview();
}
function rerenderBlocks() {
  renderBlocks($('#cr-blocks'), cr.blocks, updateCreatePreview);
  updateCreatePreview();
}
function openInCreate(script, keepId) {
  const s = structuredClone(script);
  cr.id = keepId ? s.id : null;
  cr.seed = s.seed;
  $('#cr-name').value = s.name || 'My script';
  if (s.kind === 'points') {
    cr.points = s.points;
    cr.blocks = [];
    cr.loop = false;
    tlEditor.set(cr.points);
    setCreateMode('timeline');
    requestAnimationFrame(() => tlEditor.smartFit());
  } else if (s.kind === 'blocks') {
    cr.blocks = s.blocks;
    cr.loop = !!s.loop;
    cr.points = [];
    tlEditor.set([]);
    $('#cr-loop').checked = cr.loop;
    setCreateMode('blocks');
    rerenderBlocks();
  }
  showTab('create');
}
function newCreate() {
  cr.id = null;
  cr.seed = newSeed();
  cr.blocks = [strokes(30, [40, 60], 0, 100), strokes(60, [60, 100], 0, 100)];
  cr.loop = false;
  cr.points = [];
  $('#cr-name').value = 'My script';
  $('#cr-loop').checked = false;
  tlEditor.set([]);
  setCreateMode('blocks');
  rerenderBlocks();
}
$('#cr-mode').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === cr.mode) return;
  if (b.dataset.v === 'timeline') {
    if (cr.blocks.length && !cr.points.length) {
      if (cr.loop || (await confirmBox('Convert to timeline?', 'Your blocks will be turned into individual points you can drag and draw. You can switch back to the blocks, but timeline edits will not carry over.', 'Convert'))) {
        const tl = new Timeline({ kind: 'blocks', blocks: cr.blocks, seed: cr.seed ?? 1 });
        if (cr.loop) tl.endless = false;
        cr.points = tl.points.map((p) => ({ ...p }));
        tlEditor.set(cr.points);
      } else return;
    }
    setCreateMode('timeline');
    requestAnimationFrame(() => tlEditor.smartFit());
  } else {
    if (!cr.blocks.length && cr.points.length && !(await confirmBox('Switch to blocks?', 'Timeline points cannot be converted into blocks. You will start with an empty block list (your timeline stays until you save).', 'Switch'))) return;
    setCreateMode('blocks');
    rerenderBlocks();
  }
});
$$('[data-add]').forEach((b) => b.addEventListener('click', () => {
  cr.blocks.push(newBlock(b.dataset.add));
  rerenderBlocks();
}));
$('#cr-loop').addEventListener('change', (e) => { cr.loop = e.target.checked; updateCreatePreview(); });
$('#cr-play').addEventListener('click', () => {
  const s = currentCreateScript();
  if ((s.kind === 'blocks' && !s.blocks.length) || (s.kind === 'points' && s.points.length < 2)) return toast('Add something first', true);
  playScript(s);
});
function doSave(asNew) {
  const s = currentCreateScript();
  if (asNew || !s.id) s.id = uid();
  const saved = saveToLibrary(s);
  if (saved) { cr.id = saved.id; toast('Saved to My scripts'); }
}
$('#cr-save').addEventListener('click', () => doSave(false));
$('#cr-saveas').addEventListener('click', () => doSave(true));
$('#cr-export').addEventListener('click', () => {
  const s = currentCreateScript();
  download(fileName(s.name), toFunscript(scriptPoints(s, 30), s.name));
});
$('#cr-new').addEventListener('click', async () => {
  if (await confirmBox('Start a new script?', 'Unsaved changes to the current script will be lost.', 'New script')) newCreate();
});
// timeline toolbar
$('#tl-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  tlEditor.mode = b.dataset.v;
  $$('#tl-mode button').forEach((x) => x.classList.toggle('active', x === b));
});
$('#tl-zin').addEventListener('click', () => tlEditor.zoom(1 / 1.5));
$('#tl-zout').addEventListener('click', () => tlEditor.zoom(1.5));
$('#tl-fit').addEventListener('click', () => tlEditor.fitAll());
$('#tl-left').addEventListener('click', () => tlEditor.scrollBy(-tlEditor.canvas.clientWidth * tlEditor.msPerPx * 0.6));
$('#tl-right').addEventListener('click', () => tlEditor.scrollBy(tlEditor.canvas.clientWidth * tlEditor.msPerPx * 0.6));
$('#tl-sel-t').addEventListener('change', (e) => tlEditor.updateSelected(Number(e.target.value) * 1000, NaN));
$('#tl-sel-x').addEventListener('change', (e) => tlEditor.updateSelected(NaN, Number(e.target.value)));
$('#tl-sel-del').addEventListener('click', () => tlEditor.deleteSelected());
$('#tl-clear').addEventListener('click', async () => {
  if (await confirmBox('Clear timeline?', 'All points will be removed.', 'Clear')) tlEditor.set([]), (cr.points = []), updateCreatePreview();
});
$('#tl-append').addEventListener('click', async () => {
  const d = await modal('Append pattern', `
    <div class="block" style="border-left-width:1px">
      <div class="row">
        <label class="fld"><span>Length (s)</span><input type="number" name="dur" value="20" min="1"></label>
        <label class="fld"><span>Speed (spm)</span><input type="number" name="spm" value="60" min="5" max="300"></label>
      </div>
      <div class="row">
        <label class="fld"><span>Bottom</span><input type="number" name="lo" value="0" min="0" max="100"></label>
        <label class="fld"><span>Top</span><input type="number" name="hi" value="100" min="0" max="100"></label>
      </div>
      <div class="row"><label class="fld"><span>Style</span><select name="style">${Object.entries(STYLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label></div>
    </div>`, 'Append');
  if (!d) return;
  const f = (n) => $(`[name=${n}]`, d).value;
  const start = cr.points.length ? cr.points[cr.points.length - 1].t + 300 : 0;
  const add = compileBlocks([strokes(+f('dur'), +f('spm'), +f('lo'), +f('hi'), f('style'))], start, Math.random);
  cr.points = [...cr.points, ...add];
  tlEditor.set(cr.points);
  tlEditor.fitAll();
  updateCreatePreview();
});

// ---------------- settings ----------------
const pctLabel = (v) => `${v}%`;
const settingSliders = [
  ['set-maxspeed', () => settings.maxSpeed, (v) => (settings.maxSpeed = v), (v) => (v >= 100 ? 'no limit' : v + '%')],
  ['set-ease', () => settings.easeInSec, (v) => (settings.easeInSec = v), (v) => (v ? `${v} s` : 'off')],
  ['set-maxmin', () => settings.maxSessionMin, (v) => (settings.maxSessionMin = v), (v) => (v ? `${v} min` : 'no limit')],
  ['set-cool', () => settings.tooClose.cooldownSec, (v) => (settings.tooClose.cooldownSec = v), (v) => `${v} s`],
  ['set-rewind', () => settings.tooClose.rewindSec, (v) => (settings.tooClose.rewindSec = v), (v) => (v ? `${v} s` : 'none')],
  ['set-slow', () => settings.tooClose.slowdownPct, (v) => (settings.tooClose.slowdownPct = v), (v) => (v ? pctLabel(v) : 'none')],
];
function renderSettings() {
  $('#set-key').value = settings.connectionKey;
  $('#set-appid').value = settings.appId;
  for (const [id, get, , fmt] of settingSliders) {
    $('#' + id).value = get();
    $(`#${id}-val`).textContent = fmt(get());
  }
  $$('#set-coolstyle button').forEach((b) => b.classList.toggle('active', b.dataset.v === settings.tooClose.style));
}
for (const [id, , set, fmt] of settingSliders) {
  $('#' + id).addEventListener('input', (e) => {
    const v = Number(e.target.value);
    set(v);
    $(`#${id}-val`).textContent = fmt(v);
    saveSettings(settings);
    if (id === 'set-maxspeed' && engine.state === 'manual' && engine.manualVel > v) engine.setManualVelocity(v);
  });
}
$('#set-coolstyle').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.tooClose.style = b.dataset.v;
  saveSettings(settings);
  renderSettings();
});
$('#set-show').addEventListener('change', (e) => {
  $('#set-key').type = $('#set-appid').type = e.target.checked ? 'text' : 'password';
});
$('#set-connect').addEventListener('click', () => {
  // pasted keys often carry spaces, line breaks or a "Bearer " prefix
  const clean = (v) => v.replace(/^\s*bearer\s+/i, '').replace(/[\s\u200b-\u200d\ufeff]+/g, '');
  settings.connectionKey = clean($('#set-key').value);
  settings.appId = clean($('#set-appid').value);
  $('#set-key').value = settings.connectionKey;
  $('#set-appid').value = settings.appId;
  saveSettings(settings);
  connect(true);
});
$('#set-demo').addEventListener('click', async () => {
  if (engine.state !== 'idle') await engine.stop();
  engine.setDriver(new SimDriver());
  setPill('demo', 'Demo mode');
  $('#conn-detail').textContent = 'Demo mode: everything works on screen, nothing is sent to a device. Press "Connect & test" to use your Handy.';
  toast('Demo mode');
});
$('#bk-export').addEventListener('click', () => download(`motion-studio-backup-${new Date().toISOString().slice(0, 10)}.json`, backupData(settings, library)));
$('#bk-import').addEventListener('click', async () => {
  const [f] = await pickFile('.json');
  if (!f) return;
  try {
    const data = JSON.parse(f.text);
    if (data.app !== 'handy-control' || !Array.isArray(data.library)) throw new Error('Not a Motion Studio backup file');
    const d = await confirmBox('Import backup?', `Adds ${data.library.length} scripts (scripts with the same ID are replaced) and restores safety settings. Your keys are kept.`, 'Import');
    if (!d) return;
    for (const s of data.library) {
      const i = library.findIndex((x) => x.id === s.id);
      if (i >= 0) library[i] = s; else library.push(s);
    }
    saveLibrary(library);
    Object.assign(settings, { ...data.settings, connectionKey: settings.connectionKey, appId: settings.appId });
    saveSettings(settings);
    renderSettings();
    syncStrokeUI();
    renderLibrary();
    toast('Backup imported');
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------------- boot ----------------
renderSettings();
syncStrokeUI();
renderPresets();
setRdParams({ minutes: 15, chaos: 40, spmMin: 40, spmMax: 140, lo: 0, hi: 100, arc: 'flat' });
newCreate();
renderLibrary();
updateNow();
let startTab = 'play';
try { startTab = localStorage.getItem('handyctl.tab') || 'play'; } catch {}
showTab(startTab);
connect(false);

// Stop the device if the page is closed mid-session.
window.addEventListener('pagehide', () => { if (engine.state !== 'idle') engine.stop(); });
