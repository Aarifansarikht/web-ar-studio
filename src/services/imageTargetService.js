import { loadMindAR } from '../ar/loadMindAR.js';

/**
 * MindAR cannot track a raw image: it needs a compiled `.mind` file holding the
 * image's feature descriptors (for detection) and tracking templates. We
 * compile in the admin's browser with MindAR's own Compiler (TensorFlow.js +
 * a web worker), then upload the result alongside the image.
 */

export const TARGET_ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';
const TARGET_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_TARGET_BYTES = 15 * 1024 * 1024;
const MIN_SIDE = 300;
// Larger images compile slowly without improving tracking (MindAR tracks on a
// 256px pyramid level); this also keeps the .mind file small.
const MAX_COMPILE_SIDE = 1024;

export class TargetError extends Error {}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new TargetError('The image could not be decoded. Try exporting it again as JPG or PNG.'));
    };
    img.src = url;
  });
}

function toCompileCanvas(img) {
  const scale = Math.min(1, MAX_COMPILE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Flatten transparency onto white, as a print would look.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function luminanceStdDev(canvas) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  let sumSq = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += l;
    sumSq += l * l;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean));
}

/** Validate the file before the (slow) compile step. */
export function validateTargetFile(file) {
  if (!file) throw new TargetError('Choose a target image.');
  if (!TARGET_TYPES.includes(file.type)) throw new TargetError('Target image must be a JPG, PNG or WebP file.');
  if (file.size > MAX_TARGET_BYTES) throw new TargetError('Target image must be smaller than 15 MB.');
}

/**
 * Compile an image into MindAR tracking data and grade its trackability.
 * @param {File} file
 * @param {(fraction: number) => void} [onProgress]
 */
export async function compileImageTarget(file, onProgress) {
  validateTargetFile(file);
  const img = await loadImage(file);
  if (Math.min(img.naturalWidth, img.naturalHeight) < MIN_SIDE) {
    throw new TargetError(`Target image is too small. The shortest side must be at least ${MIN_SIDE}px.`);
  }

  const canvas = toCompileCanvas(img);
  const contrast = luminanceStdDev(canvas);

  let Compiler;
  try {
    ({ Compiler } = await loadMindAR());
  } catch {
    throw new TargetError('The MindAR compiler could not be loaded. Check your connection and try again.');
  }

  const compiler = new Compiler();
  let dataList;
  try {
    dataList = await compiler.compileImageTargets([canvas], (percent) =>
      onProgress?.(Math.min(1, percent / 100)),
    );
  } catch (err) {
    console.error(err);
    throw new TargetError('Compiling the image target failed. WebGL may be unavailable in this browser.');
  }
  const buffer = compiler.exportData();
  const [data] = dataList;

  const matchingCount = data.matchingData.reduce(
    (n, level) => n + level.maximaPoints.length + level.minimaPoints.length,
    0,
  );
  const trackingLevel = data.trackingData[0];
  const trackingCount = trackingLevel?.points.length ?? 0;
  const trackingPoints = (trackingLevel?.points ?? []).map((p) => ({
    x: p.x / trackingLevel.width,
    y: p.y / trackingLevel.height,
  }));

  // Heuristic grading. MindAR needs both distinctive keypoints (to detect the
  // image) and well-spread tracking templates (to follow it). Calibrated on
  // test images: a smooth gradient wallpaper yields ~1 tracking point (fails),
  // a detailed photo ~30 points / ~1800 features (tracks reliably).
  let quality = 'good';
  if (trackingCount < 10 || matchingCount < 200) quality = 'poor';
  else if (trackingCount < 25 || matchingCount < 600) quality = 'fair';

  const warnings = [];
  if (contrast < 32) warnings.push('Low contrast: increase contrast or add darker/lighter details.');
  const aspect = canvas.width / canvas.height;
  if (aspect > 3 || aspect < 1 / 3) warnings.push('Very elongated images are harder to track; prefer closer to square.');
  if (quality === 'poor') {
    warnings.push(
      'Few distinctive features. Avoid large flat areas, plain gradients, small text-only designs and repeating patterns.',
    );
  }

  return {
    mindBlob: new Blob([buffer], { type: 'application/octet-stream' }),
    width: canvas.width,
    height: canvas.height,
    quality,
    featureCount: matchingCount,
    trackingCount,
    trackingPoints,
    warnings,
  };
}
