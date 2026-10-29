import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Tunes MindAR 1.2.5's image tracker (constants inside its prebuilt bundle):
 *  - Track on the finer 256px template level (index 0) instead of the 128px
 *    one: about twice the tracking points and detail, so the target stays
 *    locked when only part of it is in view (walking up close to a poster).
 *  - Widen the per-frame search radius (10 → 12 px) so faster hand movement
 *    doesn't drop the lock at the finer level.
 * Works with existing .mind files (both levels are always compiled).
 * MINDAR_TRACK_LEVEL=1 restores MindAR's default (for A/B testing).
 */
function mindarTrackingTuning(level) {
  const ORIGINAL = 'Z5 = 6, B5 = 1, H5 = 10, _5 = 1, U5 = 0.8, Y5 = 1,';
  return {
    name: 'mindar-tracking-tuning',
    enforce: 'pre',
    transform(code, id) {
      if (!/mind-ar[\\/]dist[\\/]controller-mGt1s8dJ\.js$/.test(id)) return null;
      if (!code.includes(ORIGINAL)) {
        throw new Error('[mindar-tracking-tuning] tracker constants not found — mind-ar version changed? Re-check the patch.');
      }
      const tuned = level === 1 ? ORIGINAL : 'Z5 = 6, B5 = 1, H5 = 12, _5 = 1, U5 = 0.8, Y5 = 0,';
      return { code: code.replace(ORIGINAL, tuned), map: null };
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const useHttps = env.VITE_DEV_HTTPS === 'true';
  const apiTarget = `http://localhost:${env.PORT || 8787}`;
  const trackLevel = Number(process.env.MINDAR_TRACK_LEVEL ?? 0);

  return {
    plugins: [mindarTrackingTuning(trackLevel), react(), ...(useHttps ? [basicSsl()] : [])],
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
