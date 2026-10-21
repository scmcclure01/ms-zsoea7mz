// Playback engine: owns the clock, the current script timeline, safety caps,
// "Too close" cooldowns and the session timer. Talks to whichever driver is active.

import { Timeline, shapePoints } from './scripts.js?v=202610201921';
import { SimDriver } from './api.js?v=202610201921';

export class Engine extends EventTarget {
  constructor(settings) {
    super();
    this.settings = settings;
    this.driver = new SimDriver();
    this.state = 'idle'; // idle | playing | cooldown | manual
    this.script = null;
    this.tl = null;
    this.rate = 1;
    this.anchorT = 0; // script time at anchorWall
    this.anchorWall = 0;
    this.sessionStart = 0;
    this.cooldownEnd = 0;
    this.manualVel = 30;
    this.busy = Promise.resolve();
    this.lastPoll = 0;
    this.timer = setInterval(() => this.tick(), 250);
  }

  // ---------- helpers ----------
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  error(e) {
    this.emit('error', e?.message || String(e));
  }
  get t() {
    if (this.state !== 'playing') return this.anchorT;
    return this.anchorT + (performance.now() - this.anchorWall) * this.rate;
  }
  setAnchor(t) {
    this.anchorT = t;
    this.anchorWall = performance.now();
  }
  get maxRate() {
    return 2;
  }
  shaper() {
    const s = this.settings;
    // speed cap: 100% ≈ 400 position-units/s (a full stroke in ~0.25 s)
    const maxVel = s.maxSpeed >= 100 ? Infinity : (s.maxSpeed / 100) * 400;
    const easeMs = (s.easeInSec || 0) * 1000;
    return (pts, prev, rate) => shapePoints(pts, prev, { maxVel, easeMs, rate });
  }
  // Serialize device commands so rapid taps don't interleave.
  queue(fn) {
    const p = this.busy.then(fn, fn);
    this.busy = p.catch((e) => this.error(e));
    return this.busy;
  }

  setDriver(d) {
    this.driver = d;
  }

  // ---------- script playback ----------
  play(script, fromT = 0) {
    this.script = script;
    this.tl = new Timeline(script);
    this.rate = 1;
    this.sessionStart = performance.now();
    return this.startAt(fromT);
  }
  startAt(fromT) {
    const wasManual = this.state === 'manual';
    this.state = 'playing';
    this.setAnchor(fromT);
    this.emit('state');
    return this.queue(async () => {
      if (wasManual) await this.driver.hampStop().catch(() => {});
      await this.driver.startStream(this.tl, fromT, this.rate, this.shaper());
      // re-anchor once the device actually starts (network delay)
      if (this.state === 'playing') this.setAnchor(fromT);
    }).catch(() => {});
  }
  setRate(rate) {
    const t = this.t;
    this.rate = Math.max(0.25, Math.min(this.maxRate, rate));
    this.setAnchor(t);
    this.emit('state');
    if (this.state === 'playing') {
      clearTimeout(this.rateTimer);
      // debounce: drivers that need a re-upload shouldn't be spammed while dragging
      this.rateTimer = setTimeout(() => this.queue(() => this.driver.setRate(this.rate, this.t)), this.driver.name === 'v2' ? 600 : 120);
    }
  }
  async stop() {
    clearTimeout(this.rateTimer);
    this.state = 'idle';
    this.setAnchor(0);
    this.emit('state');
    // Emergency stop bypasses the queue. Anything still in flight (e.g. a play
    // command mid-request) gets a second stop once it settles.
    const pending = this.busy;
    this.busy = Promise.resolve();
    try {
      await this.driver.stopAll();
    } catch (e) {
      this.error(e);
    }
    pending.then(() => {
      if (this.state === 'idle') this.driver.stopAll().catch(() => {});
    });
  }

  // ---------- Too close ----------
  tooClose() {
    const s = this.settings.tooClose;
    if (this.state === 'cooldown') {
      // pressing again extends the cooldown
      this.cooldownEnd = performance.now() + s.cooldownSec * 1000;
      this.emit('state');
      return;
    }
    if (this.state !== 'playing' && this.state !== 'manual') return;
    const wasManual = this.state === 'manual';
    const now = this.t;
    const resumeFrom = wasManual ? null : Math.max(0, now - (s.rewindSec || 0) * 1000);
    // A true pause keeps the device's place in the script; anything else needs a fresh start.
    this.pauseMode = !wasManual && s.style !== 'gentle' && resumeFrom === now;
    this.resumeFrom = resumeFrom;
    this.resumeManual = wasManual;
    this.state = 'cooldown';
    this.cooldownEnd = performance.now() + s.cooldownSec * 1000;
    this.setAnchor(resumeFrom ?? 0);
    this.emit('state');
    if (this.pauseMode) {
      this.queue(() => this.driver.pause());
      return;
    }
    this.queue(async () => {
      await this.driver.stopAll();
      if (s.style === 'gentle') await this.driver.hampStart(Math.min(12, this.settings.maxSpeed));
    });
  }
  endCooldown() {
    if (this.state !== 'cooldown') return;
    const s = this.settings.tooClose;
    // Always resume at the same speed the user was at.
    if (this.resumeManual) {
      this.state = 'idle';
      this.startManual(this.manualVel);
      return;
    }
    if (this.pauseMode) {
      const from = this.resumeFrom ?? 0;
      const rate = this.rate;
      this.state = 'playing';
      this.setAnchor(from);
      this.emit('state');
      this.queue(async () => {
        await this.driver.resume(from);
        // re-assert the playback rate in case the device reset it while paused
        await this.driver.setRate(rate, from).catch(() => {});
        if (this.state === 'playing') this.setAnchor(from);
      });
      return;
    }
    if (s.style === 'gentle') this.queue(() => this.driver.hampStop());
    this.state = 'idle';
    this.startAt(this.resumeFrom ?? 0);
  }
  // "Resume now" from the cooldown screen
  resumeNow() {
    if (this.state === 'cooldown') this.endCooldown();
  }

  // ---------- manual (HAMP) ----------
  startManual(vel) {
    this.manualVel = Math.min(vel, this.settings.maxSpeed);
    const wasPlaying = this.state === 'playing';
    this.state = 'manual';
    this.script = null;
    this.tl = null;
    this.sessionStart = this.sessionStart && wasPlaying ? this.sessionStart : performance.now();
    this.emit('state');
    return this.queue(async () => {
      if (wasPlaying) await this.driver.stopStream().catch(() => {});
      await this.driver.hampStart(this.manualVel);
    });
  }
  setManualVelocity(vel) {
    this.manualVel = Math.min(vel, this.settings.maxSpeed);
    this.emit('state');
    if (this.state !== 'manual') return;
    clearTimeout(this.velTimer);
    this.velTimer = setTimeout(() => this.queue(() => this.driver.hampVelocity(this.manualVel)), 120);
  }

  setStroke(min, max) {
    clearTimeout(this.strokeTimer);
    this.strokeTimer = setTimeout(() => this.queue(() => this.driver.setStroke(min, max)), 200);
  }

  // ---------- clock ----------
  async tick() {
    const now = performance.now();
    const maxMin = this.settings.maxSessionMin;
    if (this.state !== 'idle' && maxMin > 0 && now - this.sessionStart > maxMin * 60000) {
      this.emit('notice', `Session limit of ${maxMin} min reached — stopped.`);
      await this.stop();
      return;
    }
    if (this.state === 'cooldown' && now >= this.cooldownEnd) this.endCooldown();
    if (this.state === 'playing' && this.tl) {
      const t = this.t;
      if (!this.tl.endless && t > this.tl.duration + 500) {
        this.emit('notice', 'Script finished.');
        await this.stop();
        return;
      }
      this.driver.feed(t).catch((e) => this.error(e));
      // occasional drift correction from the device's own clock
      if (now - this.lastPoll > 4000) {
        this.lastPoll = now;
        this.driver.pollState().then((st) => {
          if (st && st.playing && this.state === 'playing' && Number.isFinite(st.t) && Math.abs(st.t - this.t) > 400) this.setAnchor(st.t);
        });
      }
    }
    this.emit('tick');
  }

  position() {
    if (!this.tl || this.state !== 'playing') return null;
    return this.tl.positionAt(this.t);
  }
}
