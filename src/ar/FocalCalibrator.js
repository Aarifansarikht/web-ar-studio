/**
 * Measures the phone camera's focal length (field of view) from tracking.
 *
 * MindAR has no camera calibration: it assumes a fixed lens. With the wrong
 * focal length, tilted views get the wrong perspective and content slides off
 * the image's corners. Phones differ (≈ 60–75° across the long side), so the
 * focal length is estimated while the visitor uses the experience.
 *
 * Each tracked frame gives point correspondences between the flat target
 * (known rectangle) and the camera image. Their homography H = K·[r1 r2 t]
 * constrains the focal length f (K = diag(f, f, 1) about the image centre),
 * because r1 and r2 are orthogonal and of equal length (Zhang's planar
 * calibration). A seen-at-an-angle frame yields an estimate; a head-on frame
 * does not (no perspective), so only sufficiently tilted frames are used and
 * the median of many estimates is taken.
 */

const MIN_POINTS = 12;
const MIN_TILT = 0.25; // perspective strength needed for a usable estimate (~15°)
const FOV_RANGE_DEG = [40, 95]; // plausible field of view across the long side
const MIN_ESTIMATES = 25;
const MAX_ESTIMATES = 120;
const MAX_SPREAD = 0.12; // interquartile range / median needed to trust the result
const STORAGE_KEY = 'webar.cameraFovLong';

export class FocalCalibrator {
  /**
   * @param {{width: number, height: number}} input tracker input size (px)
   * @param {number} focal current focal length (px, tracker input)
   */
  constructor(input, focal) {
    this.w = input.width;
    this.h = input.height;
    this.longSide = Math.max(this.w, this.h);
    this.focal = focal;
    this.estimates = [];
    const [lo, hi] = FOV_RANGE_DEG.map((d) => this.longSide / 2 / Math.tan(((d / 2) * Math.PI) / 180));
    this.fMin = hi; // wider view = shorter focal length
    this.fMax = lo;
  }

  /** Field of view across the long side (deg) for a focal length (px). */
  fovFor(focal) {
    return (2 * Math.atan(this.longSide / 2 / focal) * 180) / Math.PI;
  }

  /**
   * Add one tracked frame.
   * @param {{x: number, y: number}[]} world target-plane points (target px)
   * @param {{x: number, y: number}[]} screen matching camera-image points (input px)
   * @param {number} targetWidth target width (px), for normalisation
   */
  observe(world, screen, targetWidth) {
    if (world.length < MIN_POINTS) return;
    const H = homography(
      world.map((p) => [p.x / targetWidth, p.y / targetWidth]),
      screen.map((p) => [p.x - this.w / 2, p.y - this.h / 2]),
    );
    if (!H) return;
    const [a1, b1, c1] = [H[0], H[3], H[6]];
    const [a2, b2, c2] = [H[1], H[4], H[7]];
    // Perspective strength relative to the current focal length (0 = head-on).
    const tilt = (Math.hypot(c1, c2) * this.focal) / Math.max(1e-9, Math.hypot(a1, b1, a2, b2) / Math.SQRT2);
    if (tilt < MIN_TILT) return;
    // r1 ⊥ r2:      (a1 a2 + b1 b2)/f² + c1 c2 = 0
    // |r1| = |r2|:  (a1² + b1² − a2² − b2²)/f² + (c1² − c2²) = 0
    const cands = [];
    const d1 = c1 * c2;
    const d2 = c1 * c1 - c2 * c2;
    const scale = (c1 * c1 + c2 * c2) * 0.15;
    if (Math.abs(d1) > scale) cands.push(-(a1 * a2 + b1 * b2) / d1);
    if (Math.abs(d2) > scale) cands.push(-(a1 * a1 + b1 * b1 - a2 * a2 - b2 * b2) / d2);
    for (const f2 of cands) {
      if (!(f2 > 0)) continue;
      const f = Math.sqrt(f2);
      if (f >= this.fMin && f <= this.fMax) this.estimates.push(f);
    }
    if (this.estimates.length > MAX_ESTIMATES) this.estimates.splice(0, this.estimates.length - MAX_ESTIMATES);
  }

  /** Converged focal length (px), or null while there is not enough consistent data. */
  result() {
    if (this.estimates.length < MIN_ESTIMATES) return null;
    const s = [...this.estimates].sort((x, y) => x - y);
    const q = (p) => s[Math.floor(p * (s.length - 1))];
    const median = q(0.5);
    if ((q(0.75) - q(0.25)) / median > MAX_SPREAD) return null;
    return median;
  }

  /** Remember the measured field of view for this device. */
  static save(fovLongDeg) {
    try {
      localStorage.setItem(STORAGE_KEY, String(Math.round(fovLongDeg * 10) / 10));
    } catch {
      // storage unavailable (private mode): calibrate again next time
    }
  }

  /** Previously measured field of view (deg, long side), if any. */
  static load() {
    try {
      const v = Number(localStorage.getItem(STORAGE_KEY));
      return v >= FOV_RANGE_DEG[0] && v <= FOV_RANGE_DEG[1] ? v : null;
    } catch {
      return null;
    }
  }
}

/**
 * Homography (row-major 3×3, h33 = 1) mapping src → dst by normalised DLT
 * (least squares). Returns null if degenerate.
 */
function homography(src, dst) {
  const norm = (pts) => {
    const n = pts.length;
    let mx = 0;
    let my = 0;
    for (const [x, y] of pts) {
      mx += x / n;
      my += y / n;
    }
    let d = 0;
    for (const [x, y] of pts) d += Math.hypot(x - mx, y - my) / n;
    const s = d > 0 ? Math.SQRT2 / d : 1;
    return { pts: pts.map(([x, y]) => [(x - mx) * s, (y - my) * s]), T: [s, 0, -mx * s, 0, s, -my * s, 0, 0, 1] };
  };
  const A = norm(src);
  const B = norm(dst);
  // Normal equations for 8 unknowns.
  const M = Array.from({ length: 8 }, () => new Array(9).fill(0));
  const addRow = (r, rhs) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) M[i][j] += r[i] * r[j];
      M[i][8] += r[i] * rhs;
    }
  };
  for (let k = 0; k < A.pts.length; k++) {
    const [x, y] = A.pts[k];
    const [u, v] = B.pts[k];
    addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(M);
  if (!h) return null;
  const Hn = [...h, 1];
  // H = T_dst⁻¹ · Hn · T_src
  const Tdi = invert3(B.T);
  if (!Tdi) return null;
  const H = mul3(mul3(Tdi, Hn), A.T);
  return H.map((v) => v / H[8]);
}

function solve(M) {
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function mul3(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}
