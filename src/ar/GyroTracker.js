import * as THREE from 'three';

/**
 * Phone gyroscope for steadier image tracking (camera-only tracking is noisy;
 * the gyroscope measures the phone's rotation precisely at 60+ Hz).
 *
 * It integrates `devicemotion` rotation rates into the phone's orientation
 * over time, so the session can express tracked poses in a world frame where
 * the artwork's orientation is constant, smooth them over a long window and
 * rotate them back with the exact phone rotation at display time.
 *
 * Self-calibrating: browsers and devices differ in axis order, signs, screen
 * orientation handling and sensor latency. Every candidate mapping from the
 * reported rates to the camera frame (4 screen rotations × 2 signs) and every
 * latency in LAGS is integrated in parallel and scored against the rotation
 * the image tracker itself observes. The gyroscope is used only once one
 * candidate agrees clearly; if agreement degrades it is switched off again.
 *
 * Scoring is noise-tolerant: over the last second of tracked frames, the
 * artwork's orientation expressed in the world frame (gyroscope orientation ×
 * tracked orientation) is constant for the right candidate, apart from
 * tracker noise, while it follows the phone's motion for a wrong one. The
 * score is that world-frame spread divided by the camera-frame spread.
 */

const HISTORY_S = 3;
const LAGS = [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12]; // s: sensor vs camera-frame timing
const WINDOW_S = 1; // tracked frames compared at once
const BIN_S = 0.2; // average tracked orientations in bins first (tracker noise)
const MIN_SPREAD_RAD = THREE.MathUtils.degToRad(2.5); // camera-frame motion needed to score
const EVAL_EVERY = 4; // evaluate every n tracked frames
const ENABLE_SCORE = 0.5; // world spread / camera spread to switch on
const DISABLE_SCORE = 0.8; // ...and to switch off again
const MIN_SAMPLES = 6;
const SCORE_DECAY = 0.85;

const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class GyroTracker {
  constructor() {
    // Candidate k: screen rotation (k % 4) * 90°, sign (k < 4 ? +1 : -1).
    this.candidates = [];
    for (let k = 0; k < 8; k++) {
      const turn = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -(k % 4) * (Math.PI / 2));
      this.candidates.push({ turn, sign: k < 4 ? 1 : -1 });
    }
    this.history = []; // { t, q: Quaternion[8] } – integrated orientation per candidate
    this.lastT = null;
    this.state = 'off'; // 'off' (no sensor), 'calibrating', 'on'
    this.best = null; // { k, lag }
    this.scores = new Map(); // `${k}:${lag}` -> { err, motion, n }
    this._prevTrack = []; // recent tracked orientations { t, q }
    this._w = new THREE.Vector3();
    this._dq = new THREE.Quaternion();
    this._onMotion = (e) => this.#onMotion(e);
  }

  start() {
    if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return;
    window.addEventListener('devicemotion', this._onMotion);
  }

  stop() {
    if (typeof window !== 'undefined') window.removeEventListener('devicemotion', this._onMotion);
    this.history = [];
    this.state = 'off';
  }

  /** True when the gyroscope is calibrated and agrees with the tracker. */
  get enabled() {
    return this.state === 'on';
  }

  get lag() {
    return this.best?.lag ?? 0;
  }

  #onMotion(e) {
    const r = e.rotationRate;
    if (!r || r.alpha === null || r.beta === null || r.gamma === null) return;
    // Event time on the performance.now() clock (old browsers used epoch ms).
    let t = e.timeStamp / 1000;
    const now = performance.now() / 1000;
    if (!Number.isFinite(t) || Math.abs(t - now) > 1) t = now;
    if (this.state === 'off') this.state = 'calibrating';
    const deg = Math.PI / 180;
    // Device frame: beta about x, gamma about y, alpha about z (deg/s).
    const wx = r.beta * deg;
    const wy = r.gamma * deg;
    const wz = r.alpha * deg;
    if (this.lastT === null || t <= this.lastT || t - this.lastT > 0.25) {
      // First sample or a gap: restart integration from identity.
      this.history = [{ t, q: this.candidates.map(() => new THREE.Quaternion()) }];
      this.lastT = t;
      return;
    }
    const dt = t - this.lastT;
    this.lastT = t;
    const prev = this.history[this.history.length - 1];
    const q = this.candidates.map((c, k) => {
      // Body angular velocity in the camera frame for this candidate.
      this._w.set(wx, wy, wz).applyQuaternion(c.turn).multiplyScalar(c.sign);
      const angle = this._w.length() * dt;
      const out = prev.q[k].clone();
      if (angle > 1e-9) out.multiply(this._dq.setFromAxisAngle(this._w.normalize(), angle));
      return out;
    });
    this.history.push({ t, q });
    while (this.history.length > 2 && this.history[0].t < t - HISTORY_S) this.history.shift();
  }

  /** Integrated phone orientation (candidate k) at time t, interpolated. */
  orientationAt(t, k = this.best?.k ?? 0, out = new THREE.Quaternion()) {
    const H = this.history;
    if (!H.length) return out.identity();
    if (t <= H[0].t) return out.copy(H[0].q[k]);
    const last = H[H.length - 1];
    if (t >= last.t) return out.copy(last.q[k]);
    let i = H.length - 2;
    while (i > 0 && H[i].t > t) i--;
    const a = H[i];
    const b = H[i + 1];
    return out.slerpQuaternions(a.q[k], b.q[k], (t - a.t) / Math.max(1e-6, b.t - a.t));
  }

  /**
   * Calibration input: the tracked target orientation (camera frame) of a
   * camera frame captured at time t.
   */
  observe(t, targetQ) {
    if (this.history.length < 2) return;
    const P = this._prevTrack;
    P.push({ t, q: targetQ.clone() });
    while (P.length > 1 && P[0].t < t - WINDOW_S) P.shift();
    this._sinceEval = (this._sinceEval ?? 0) + 1;
    if (this._sinceEval < EVAL_EVERY || P.length < 8) return;
    this._sinceEval = 0;
    const bins = binned(P, t);
    if (bins.length < 4) return;
    const camSpread = spread(bins.map((bin) => mean(bin.map((p) => p.q))));
    if (camSpread < MIN_SPREAD_RAD) return; // not enough motion to tell candidates apart
    const g = new THREE.Quaternion();
    let best = null;
    for (let k = 0; k < this.candidates.length; k++) {
      for (const lag of LAGS) {
        const world = bins.map((bin) => mean(bin.map((p) => this.orientationAt(p.t - lag, k, g).clone().multiply(p.q))));
        const ratio = spread(world) / camSpread;
        const key = `${k}:${lag}`;
        const sc = this.scores.get(key) ?? { sum: 0, w: 0, n: 0 };
        sc.sum = sc.sum * SCORE_DECAY + ratio;
        sc.w = sc.w * SCORE_DECAY + 1;
        sc.n += 1;
        this.scores.set(key, sc);
        const score = sc.sum / sc.w;
        if (!best || score < best.score) best = { k, lag, score, n: sc.n };
      }
    }
    this.lastScore = best.score;
    // Mappings that differ only about an axis the phone has not turned around
    // score alike; any of them is right for the motion so far, and the choice
    // keeps being re-evaluated as more motion is observed.
    const clear = best.score < ENABLE_SCORE && best.n >= MIN_SAMPLES;
    if (this.state !== 'on' && clear) {
      this.best = best;
      this.state = 'on';
    } else if (this.state === 'on') {
      if (clear) this.best = best;
      else if (best.score > DISABLE_SCORE) this.state = 'calibrating';
    }
  }
}

/**
 * iOS Safari only delivers motion events after permission, which must be
 * requested from a user gesture (call this synchronously in the Start tap).
 * Elsewhere this resolves immediately. Never throws.
 */
export function requestMotionAccess() {
  const DME = typeof window !== 'undefined' ? window.DeviceMotionEvent : undefined;
  if (typeof DME?.requestPermission !== 'function') return Promise.resolve('granted');
  return DME.requestPermission().catch(() => 'denied');
}

/** Tracked samples grouped into BIN_S-long bins ending at t (bins with ≥ 2 samples). */
function binned(P, t) {
  const bins = [];
  for (const p of P) {
    const i = Math.floor((t - p.t) / BIN_S);
    (bins[i] ??= []).push(p);
  }
  return bins.filter((b) => b && b.length >= 2);
}

/** Average orientation (sign-aligned quaternion mean). */
function mean(qs) {
  const m = new THREE.Vector4();
  const ref = qs[0];
  for (const q of qs) {
    const sgn = q.x * ref.x + q.y * ref.y + q.z * ref.z + q.w * ref.w < 0 ? -1 : 1;
    m.x += q.x * sgn;
    m.y += q.y * sgn;
    m.z += q.z * sgn;
    m.w += q.w * sgn;
  }
  return new THREE.Quaternion(m.x, m.y, m.z, m.w).normalize();
}

/** Mean angle (rad) of a set of orientations from their average orientation. */
function spread(qs) {
  const avg = mean(qs);
  let sum = 0;
  for (const q of qs) sum += 2 * Math.acos(Math.min(1, Math.abs(avg.x * q.x + avg.y * q.y + avg.z * q.z + avg.w * q.w)));
  return sum / qs.length;
}
