/* Wiedergabe über die Web-Audio-Schnittstelle (eingebauter Synthesizer, funktioniert offline). */
'use strict';

class Player {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.notes = [];      // [{pitch, on, off}] in Millisekunden, nach "on" sortiert
    this.playing = false;
    this.rate = 1;
    this.instrument = 'piano';
    this.live = new Set();
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (!this.master) {
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.comp);
    }
  }

  voice(midi, t0, t1, gain = 1) {
    const ctx = this.ctx;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const env = ctx.createGain();
    env.gain.value = 0;
    let out = env;
    const peak = 0.2 * gain;
    const oscs = [];
    const add = (type, mult, gain) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(env);
      oscs.push(o);
    };
    let release = 0.06;
    env.gain.setValueAtTime(0, t0);
    switch (this.instrument) {
      case 'organ':
        add('sine', 1, 0.6); add('sine', 2, 0.3); add('sine', 3, 0.15); add('sine', 4, 0.08);
        env.gain.linearRampToValueAtTime(peak, t0 + 0.02);
        break;
      case 'flute':
        add('sine', 1, 0.9); add('triangle', 2, 0.08);
        env.gain.linearRampToValueAtTime(peak * 1.1, t0 + 0.06);
        release = 0.09;
        break;
      case 'pluck': {
        add('sawtooth', 1, 0.7); add('square', 2, 0.1);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(Math.min(9000, f * 8), t0);
        lp.frequency.setTargetAtTime(f * 1.5, t0, 0.15);
        env.connect(lp);
        out = lp;
        env.gain.linearRampToValueAtTime(peak * 1.2, t0 + 0.003);
        env.gain.setTargetAtTime(0.0001, t0 + 0.003, 0.35);
        break;
      }
      default: {  // Klavier
        add('triangle', 1, 0.75); add('sine', 2, 0.22); add('sine', 3, 0.07);
        const tau = Math.max(0.25, 1.4 - (midi - 36) * 0.018);
        env.gain.linearRampToValueAtTime(peak * 1.3, t0 + 0.005);
        env.gain.setTargetAtTime(0.0001, t0 + 0.005, tau);
        release = 0.08;
      }
    }
    const end = Math.max(t1, t0 + 0.05);
    env.gain.setTargetAtTime(0, end, release / 3);
    out.connect(this.master);
    for (const o of oscs) {
      o.start(t0);
      o.stop(end + release * 4);
      this.live.add(o);
      o.onended = () => this.live.delete(o);
    }
  }

  /** Kurzer Einzelton als Rückmeldung beim Bearbeiten. */
  blip(midi) {
    this.ensure();
    const t = this.ctx.currentTime + 0.01;
    this.voice(midi, t, t + 0.35);
  }

  now() {
    if (!this.playing) return 0;
    return this.fromMs + (this.ctx.currentTime - this.t0) * 1000 * this.rate;
  }

  play(fromMs, endMs, onEnd) {
    this.stop();
    this.ensure();
    this.playing = true;
    this.fromMs = fromMs;
    this.endMs = endMs;
    this.t0 = this.ctx.currentTime + 0.12;
    this.onEnd = onEnd;
    this.idx = this.notes.findIndex(n => n.on >= fromMs - 0.5);
    if (this.idx < 0) this.idx = this.notes.length;
    const tick = () => {
      const horizon = this.ctx.currentTime + 0.3;
      while (this.idx < this.notes.length) {
        const n = this.notes[this.idx];
        const t = this.t0 + (n.on - this.fromMs) / 1000 / this.rate;
        if (t > horizon) break;
        const tg = this.trackGain ? this.trackGain(n.tracks) : 1;
        if (tg > 0) this.voice(n.pitch, t, this.t0 + (n.off - this.fromMs) / 1000 / this.rate, (n.gain ?? 1) * tg);
        this.idx++;
      }
      if (this.now() > this.endMs + 400) {
        const cb = this.onEnd;
        this.stop();
        if (cb) cb();
      }
    };
    tick();
    this.timer = setInterval(tick, 30);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    if (this.master) {
      const m = this.master;
      this.master = null;
      m.gain.setTargetAtTime(0, this.ctx.currentTime, 0.015);
      setTimeout(() => m.disconnect(), 150);
    }
    for (const o of this.live) { try { o.stop(this.ctx.currentTime + 0.1); } catch (e) { /* schon beendet */ } }
    this.live.clear();
  }
}
