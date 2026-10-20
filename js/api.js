// Device drivers.
//  - V3Driver: Handy REST API v3 (firmware 4+). Streams points with HSP; live playback-rate.
//  - V2Driver: Handy API v2 (firmware 3). Uploads a funscript and plays it with HSSP.
//  - SimDriver: no device; everything is shown on screen only.
//
// Common interface (positions are 0-100, times in ms of script time):
//   connect() -> {api, fw, model}
//   startStream(timeline, fromT, rate, shape)   shape(points, prevPoint, rate) applies safety caps
//   feed(scriptT)            called ~4x/sec while playing (push more points if needed)
//   setRate(rate, scriptT)
//   stopStream()
//   hampStart(velocity 0-100) / hampVelocity(v) / hampStop()
//   setStroke(min, max)      device-level stroke limits
//   stopAll()                emergency stop: everything, ignoring errors
//   syncTime()               returns server-time estimate offset (optional)

import { toFunscript } from './scripts.js';

const V3 = 'https://www.handyfeeling.com/api/handy-rest/v3';
const V2 = 'https://www.handyfeeling.com/api/handy/v2';
const HOSTING = 'https://www.handyfeeling.com/api/hosting/v2';

export class ApiError extends Error {
  constructor(message, info) {
    super(message);
    this.info = info;
  }
}

async function call(url, { method = 'GET', headers = {}, body, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let rsp;
  try {
    rsp = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ApiError(e.name === 'AbortError' ? 'Request timed out' : 'Network error — check your internet connection');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await rsp.json(); } catch { /* empty body */ }
  if (!rsp.ok) {
    const msg = data?.error?.message || data?.message || `${rsp.status} ${rsp.statusText}`;
    throw new ApiError(rsp.status === 401 || rsp.status === 403 ? `Not authorized (${msg}) — check your Application ID` : msg, data);
  }
  if (data?.error) {
    const e = data.error;
    if (e.connected === false) throw new ApiError('Handy is not connected to Wi-Fi/server. Is it on and in Wi-Fi mode?', e);
    throw new ApiError(e.message || e.name || 'Device error', e);
  }
  return data;
}

// Estimate server clock offset (server = Date.now() + offset).
async function measureOffset(fetchTime, samples = 8) {
  const s = [];
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    try {
      const st = await fetchTime();
      const t1 = Date.now();
      s.push({ rtd: t1 - t0, offset: st + (t1 - t0) / 2 - t1 });
    } catch { /* skip */ }
  }
  if (!s.length) return { offset: 0, rtd: 0 };
  s.sort((a, b) => a.rtd - b.rtd);
  const keep = s.slice(0, Math.max(1, s.length - 2));
  return {
    offset: keep.reduce((a, b) => a + b.offset, 0) / keep.length,
    rtd: keep.reduce((a, b) => a + b.rtd, 0) / keep.length,
  };
}

// ======================= V3 =======================
export class V3Driver {
  constructor(key, appId) {
    this.key = key;
    this.appId = appId;
    this.offset = 0;
    this.rtd = 0;
    this.stream = null;
    this.mode = null;
    this.name = 'v3';
    this.auth = 'bearer'; // or 'apikey' — Handy accepts the ID either way depending on token type
  }
  h() {
    return this.auth === 'apikey'
      ? { 'X-Connection-Key': this.key, 'X-Api-Key': this.appId }
      : { 'X-Connection-Key': this.key, Authorization: `Bearer ${this.appId}` };
  }
  req(path, opts = {}) {
    return call(V3 + path, { ...opts, headers: { ...this.h(), ...(opts.headers || {}) } });
  }
  put(path, body) {
    return this.req(path, { method: 'PUT', body: body ?? {} });
  }
  async connect() {
    let c;
    try {
      c = await this.req('/connected');
    } catch (e) {
      if (!/authorized/i.test(e.message)) throw e;
      this.auth = 'apikey';
      c = await this.req('/connected');
    }
    if (!(c?.result?.connected ?? c?.connected)) throw new ApiError('Handy is not online. Make sure it is powered on and connected to Wi-Fi (LED should be blue/purple).');
    const info = (await this.req('/info')).result || {};
    await this.syncTime();
    return { api: 'v3', fw: info.fw_version, model: info.hw_model_name, fwStatus: info.fw_status };
  }
  async syncTime() {
    const r = await measureOffset(async () => (await call(V3 + '/servertime')).server_time);
    this.offset = r.offset;
    this.rtd = r.rtd;
    return r;
  }
  serverNow() {
    return Math.round(Date.now() + this.offset);
  }
  async setMode(m) {
    if (this.mode === m) return;
    await this.put('/mode2', { mode: m });
    this.mode = m;
  }

  // ---- HSP streaming ----
  async startStream(tl, fromT, rate, shape) {
    const myId = Math.floor(Math.random() * 4e9) + 1;
    const s = { id: myId, tl, rate, shape, idx: Math.max(0, tl.indexAt(fromT) - 1), sent: 0, prev: null, pushing: false, maxPoints: 1000, lastPoll: 0, alive: true };
    this.stream = s;
    await this.setMode(4);
    const st = (await this.put('/hsp/setup', { stream_id: myId })).result;
    if (st?.max_points) s.maxPoints = st.max_points;
    const first = this.nextChunk(s, 40);
    await this.put('/hsp/play', {
      start_time: Math.max(0, Math.round(fromT)),
      server_time: this.serverNow(),
      playback_rate: rate,
      pause_on_starving: true,
      loop: false,
      add: first,
    });
  }
  nextChunk(s, n = 100) {
    const tl = s.tl;
    tl.ensure((tl.points[s.idx]?.t ?? 0) + 120000);
    const raw = tl.points.slice(s.idx, s.idx + n);
    s.idx += raw.length;
    const pts = s.shape(raw, s.prev, s.rate);
    if (pts.length) s.prev = pts[pts.length - 1];
    s.sent += pts.length;
    return { points: pts, flush: false, tail_point_stream_index: Math.max(1, s.sent) };
  }
  async feed(scriptT) {
    const s = this.stream;
    if (!s || s.pushing) return;
    s.pushing = true;
    try {
      const tl = s.tl;
      // keep ~25 s of (playback) time buffered, bounded by device buffer size
      const ahead = 25000 * Math.max(1, s.rate);
      let loops = 0;
      while (s.alive && loops++ < 4) {
        const pushedT = tl.points[s.idx - 1]?.t ?? 0;
        const playedIdx = tl.indexAt(scriptT);
        const buffered = s.idx - playedIdx;
        if (pushedT - scriptT > ahead || buffered > s.maxPoints - 120) break;
        if (s.idx >= tl.points.length) {
          tl.ensure(pushedT + 120000);
          if (s.idx >= tl.points.length) break; // finite script fully sent
        }
        const chunk = this.nextChunk(s, 100);
        if (!chunk.points.length) break;
        if (this.stream !== s) break;
        await this.put('/hsp/add', chunk);
      }
    } finally {
      s.pushing = false;
    }
  }
  async pollState() {
    try {
      const st = (await this.req('/hsp/state')).result;
      return st ? { t: st.current_time, playing: st.play_state === 1 || st.play_state === 4 } : null;
    } catch {
      return null;
    }
  }
  async setRate(rate) {
    if (this.stream) this.stream.rate = rate;
    await this.put('/hsp/playbackrate', { playback_rate: rate });
  }
  pause() {
    return this.put('/hsp/pause');
  }
  async resume(scriptT) {
    try {
      await this.put('/hsp/resume', { pick_up: false });
    } catch {
      // if the device lost the paused stream, restart it at the same spot
      const s = this.stream;
      if (s) await this.startStream(s.tl, scriptT, s.rate, s.shape);
    }
  }
  async stopStream() {
    if (this.stream) this.stream.alive = false;
    this.stream = null;
    await this.put('/hsp/stop');
  }

  // ---- HAMP (manual) ----
  async hampStart(v) {
    await this.setMode(0);
    await this.put('/hamp/velocity', { velocity: v / 100 });
    await this.put('/hamp/start');
  }
  hampVelocity(v) {
    return this.put('/hamp/velocity', { velocity: v / 100 });
  }
  hampStop() {
    return this.put('/hamp/stop');
  }
  setStroke(min, max) {
    return this.put('/slider/stroke', { min: min / 100, max: max / 100 });
  }
  async stopAll() {
    if (this.stream) this.stream.alive = false;
    this.stream = null;
    await Promise.allSettled([this.put('/hsp/stop'), this.put('/hamp/stop')]);
  }
}

// ======================= V2 =======================
export class V2Driver {
  constructor(key) {
    this.key = key;
    this.offset = 0;
    this.stream = null;
    this.mode = null;
    this.name = 'v2';
  }
  req(path, opts = {}) {
    return call(V2 + path, { ...opts, headers: { 'X-Connection-Key': this.key, ...(opts.headers || {}) } });
  }
  put(path, body) {
    return this.req(path, { method: 'PUT', body: body ?? {} });
  }
  async connect() {
    const c = await this.req('/connected');
    if (!c?.connected) throw new ApiError('Handy is not online. Make sure it is powered on and connected to Wi-Fi.');
    const info = await this.req('/info');
    await this.syncTime();
    return { api: 'v2', fw: info.fwVersion, model: info.model, fwStatus: info.fwStatus };
  }
  async syncTime() {
    const r = await measureOffset(async () => (await call(V2 + '/servertime')).serverTime);
    this.offset = r.offset;
    return r;
  }
  serverNow() {
    return Math.round(Date.now() + this.offset);
  }
  async setMode(m) {
    if (this.mode === m) return;
    await this.put('/mode', { mode: m });
    this.mode = m;
  }
  // Builds a chunk of script starting at fromT, re-timed by rate, uploads and plays it.
  async startStream(tl, fromT, rate, shape) {
    const span = 20 * 60000; // 20 minutes per upload for endless scripts
    tl.ensure(fromT + span);
    const i0 = Math.max(0, tl.indexAt(fromT) - 1);
    const raw = tl.points.slice(i0).filter((p) => p.t <= fromT + span);
    const shaped = shape(raw, null, rate);
    const pts = shaped.map((p) => ({ t: Math.max(0, Math.round((p.t - fromT) / rate)), x: p.x }));
    const s = { tl, fromT, rate, shape, endT: raw.length ? raw[raw.length - 1].t : fromT, restarting: false };
    this.stream = s;
    const fd = new FormData();
    fd.append('file', new Blob([JSON.stringify(toFunscript(pts))], { type: 'application/json' }), 'script.funscript');
    const up = await call(HOSTING + '/upload', { method: 'POST', body: fd, timeout: 20000 });
    await this.setMode(1);
    await this.put('/hssp/setup', { url: up.url });
    await this.put('/hssp/play', { estimatedServerTime: this.serverNow(), startTime: 0 });
  }
  async feed(scriptT) {
    const s = this.stream;
    if (!s || s.restarting || !s.tl.endless) return;
    if (s.endT - scriptT < 60000) {
      s.restarting = true;
      try { await this.startStream(s.tl, scriptT, s.rate, s.shape); } catch { s.restarting = false; }
    }
  }
  async pollState() { return null; }
  async setRate(rate, scriptT) {
    const s = this.stream;
    if (!s) return;
    await this.startStream(s.tl, scriptT, rate, s.shape);
  }
  async stopStream() {
    this.stream = null;
    await this.put('/hssp/stop');
  }
  pause() {
    return this.put('/hssp/stop');
  }
  async resume(scriptT) {
    const s = this.stream;
    if (s) await this.startStream(s.tl, scriptT, s.rate, s.shape);
  }
  async hampStart(v) {
    await this.setMode(0);
    await this.put('/hamp/velocity', { velocity: Math.round(v) });
    await this.put('/hamp/start');
  }
  hampVelocity(v) { return this.put('/hamp/velocity', { velocity: Math.round(v) }); }
  hampStop() { return this.put('/hamp/stop'); }
  setStroke(min, max) { return this.put('/slide', { min: Math.round(min), max: Math.round(max) }); }
  async stopAll() {
    this.stream = null;
    await Promise.allSettled([this.put('/hssp/stop'), this.put('/hamp/stop')]);
  }
}

// ======================= Simulator =======================
export class SimDriver {
  constructor() { this.name = 'demo'; }
  async connect() { return { api: 'demo', fw: '—', model: 'Simulator' }; }
  async startStream() {}
  async feed() {}
  async pollState() { return null; }
  async setRate() {}
  async pause() {}
  async resume() {}
  async stopStream() {}
  async hampStart() {}
  async hampVelocity() {}
  async hampStop() {}
  async setStroke() {}
  async stopAll() {}
}

// Pick the right driver for this device.
export async function autoConnect(key, appId) {
  if (!key) return { driver: new SimDriver(), info: await new SimDriver().connect() };
  let v3err = null;
  if (appId) {
    const d = new V3Driver(key, appId);
    try {
      const info = await d.connect();
      return { driver: d, info };
    } catch (e) {
      v3err = e;
    }
  }
  // Older firmware (3.x) works without an Application ID.
  const d2 = new V2Driver(key);
  let v2err = null;
  try {
    const info = await d2.connect();
    if (!String(info.fw || '').match(/^[4-9]/)) return { driver: d2, info };
    v2err = new ApiError(`Your Handy has firmware ${info.fw}, which needs an Application ID.`);
  } catch (e) {
    v2err = e;
  }
  if (v3err && /authorized/i.test(v3err.message)) {
    throw new ApiError('Handy rejected the Application ID. Make sure you copied the Application ID (not the Key), with no extra spaces, and that the token is active at user.handyfeeling.com.');
  }
  throw v3err || v2err;
}
