import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Tunes MindAR 1.2.5's image tracker (code inside its prebuilt bundle):
 *  - Allow a second tracker on the finer 256px template level (MindAR only
 *    uses the 128px level). The session switches between them by the image's
 *    apparent size: 128px is far more stable at normal viewing distances
 *    (measured pose noise p90 3.7° vs 42° at 256px), while 256px keeps the
 *    lock when you walk up close and only part of the image is in view.
 *  - Widen the per-frame search radius (10 → 12 px) for faster hand movement.
 *  - Detect in a 512px window instead of 256px. MindAR searches for the
 *    target in one square window per frame, stepping through a 3×3 grid; at
 *    256px the grid only covers the frame centre and needs up to 9 frames, so
 *    re-finding the image after the camera moved away was slow. A 512px window
 *    (largest power of two that fits the frame) covers the whole frame in 3.
 *  - Recognise the image from a partial view (e.g. one corner). The matcher
 *    (inside MindAR's web worker, embedded as base64) votes for where the
 *    image centre lands, but only accepts votes in ±1.2 frame sizes around the
 *    frame's top-left corner, so a close-up of the top-left or bottom-left of
 *    the image (centre beyond the right/bottom edge) was never recognised.
 *    The vote range now extends two frame sizes beyond every edge.
 *  - Let the session decide when the tracking loop starts its next frame
 *    (controller.nextFrameHook): as soon as the camera delivers a new frame,
 *    instead of waiting for the next screen refresh after every frame.
 * Works with existing .mind files (both levels are always compiled).
 * MINDAR_TRACK_LEVEL=1 restores MindAR's defaults (for A/B testing).
 */
function mindarTrackingTuning(level, detectWindow) {
  const WORKER_RE = /const IC = "([A-Za-z0-9+/=]+)"/;
  const HOUGH_ORIGINAL = 'i=t*1.2,h=-i,l=s*1.2,u=-l,';
  const HOUGH_TUNED = 'i=t+2*Math.max(t,s),h=-2*Math.max(t,s),l=s+2*Math.max(t,s),u=-2*Math.max(t,s),';
  const patchWorker = (code) =>
    code.replace(WORKER_RE, (_, b64) => {
      const src = Buffer.from(b64, 'base64').toString('utf8');
      if (!src.includes(HOUGH_ORIGINAL)) throw new Error('[mindar-tracking-tuning] matcher code not found in worker.');
      return `const IC = "${Buffer.from(src.replace(HOUGH_ORIGINAL, HOUGH_TUNED), 'utf8').toString('base64')}"`;
    });
  const ORIGINAL = 'Z5 = 6, B5 = 1, H5 = 10, _5 = 1, U5 = 0.8, Y5 = 1,';
  const CROP_ORIGINAL = 'let o = Math.min(t, e) / 2, r = Math.pow(2, Math.round(Math.log(o) / Math.log(2)));';
  const CROP_TUNED = 'let o = Math.min(t, e), r = Math.pow(2, Math.floor(Math.log(o) / Math.log(2)));';
  const LEVEL_ORIGINAL = 'this.trackingKeyframeList.push(e[l][Y5]);';
  const LEVEL_TUNED = 'this.trackingKeyframeList.push(e[l][globalThis.__mindarTrackLevel ?? Y5]);';
  const WAIT_ORIGINAL = 'this.onUpdate({ type: "processDone" }), await rd.nextFrame();';
  const WAIT_TUNED = 'this.onUpdate({ type: "processDone" }), await (this.nextFrameHook ? this.nextFrameHook() : rd.nextFrame());';
  return {
    name: 'mindar-tracking-tuning',
    enforce: 'pre',
    transform(code, id) {
      // Dev requests carry a version query (?v=…); production ids don't.
      if (!/mind-ar[\\/]dist[\\/]controller-mGt1s8dJ\.js$/.test(id.split('?')[0])) return null;
      if (!code.includes(ORIGINAL) || !code.includes(CROP_ORIGINAL) || !code.includes(LEVEL_ORIGINAL) || !code.includes(WAIT_ORIGINAL) || !WORKER_RE.test(code)) {
        throw new Error('[mindar-tracking-tuning] tracker code not found — mind-ar version changed? Re-check the patch.');
      }
      if (level === 1) return null;
      const tuned = patchWorker(code)
        .replace(ORIGINAL, 'Z5 = 6, B5 = 1, H5 = 12, _5 = 1, U5 = 0.8, Y5 = 1,')
        .replace(CROP_ORIGINAL, detectWindow === 'small' ? CROP_ORIGINAL : CROP_TUNED)
        .replace(LEVEL_ORIGINAL, LEVEL_TUNED)
        .replace(WAIT_ORIGINAL, WAIT_TUNED);
      return { code: tuned, map: null };
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const useHttps = env.VITE_DEV_HTTPS === 'true';
  const apiTarget = `http://localhost:${env.PORT || 8787}`;
  const trackLevel = Number(process.env.MINDAR_TRACK_LEVEL ?? 0);

  return {
    plugins: [mindarTrackingTuning(trackLevel, process.env.MINDAR_DETECT_WINDOW), react(), ...(useHttps ? [basicSsl()] : [])],
    define: {
      // Vercel sets VERCEL=1 at build time: there is no API there, so the app
      // reads the exported static data directly instead of probing /api.
      __STATIC_HOST__: JSON.stringify(process.env.VERCEL === '1' || env.VITE_STATIC_HOST === 'true'),
    },
    // Serve mind-ar unbundled in dev so the tracking tuning above applies.
    optimizeDeps: { exclude: ['mind-ar'] },
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': apiTarget,
        '/uploads': apiTarget,
      },
    },
    preview: {
      host: true,
      proxy: {
        '/api': apiTarget,
        '/uploads': apiTarget,
      },
    },
    build: {
      // MindAR bundles TensorFlow.js, which is large but only loaded lazily
      // on the AR page and the target compiler.
      chunkSizeWarningLimit: 4000,
    },
  };
});
