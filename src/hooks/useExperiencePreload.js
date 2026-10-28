import { useCallback, useEffect, useState } from 'react';
import { loadMindAR } from '../ar/loadMindAR.js';
import { fetchWithProgress } from '../services/assetLoader.js';
import { assetUrl } from '../utils/url.js';

// Relative share of the progress bar for each download.
const WEIGHTS = { engine: 0.3, mind: 0.15, content: 0.55 };

/**
 * Downloads everything the AR session needs (tracking engine, compiled target,
 * AR content) before the camera is requested, with combined progress.
 * Blob URLs are revoked when the experience changes or the page unmounts.
 */
export function useExperiencePreload(experience) {
  const [state, setState] = useState({ progress: 0, assets: null, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!experience) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const objectUrls = [];
    const parts = { engine: 0, mind: 0, content: 0 };
    const report = () => {
      if (signal.aborted) return;
      const progress = Object.entries(parts).reduce((sum, [k, v]) => sum + v * WEIGHTS[k], 0);
      setState((s) => ({ ...s, progress }));
    };
    const track = (key) => (fraction) => {
      if (fraction !== null) parts[key] = fraction;
      report();
    };

    setState({ progress: 0, assets: null, error: null });

    (async () => {
      try {
        const [, mindBlob, contentBlob] = await Promise.all([
          loadMindAR()
            .catch(() => {
              throw new Error('The AR engine could not be downloaded. Check your connection.');
            })
            .then(() => track('engine')(1)),
          fetchWithProgress(assetUrl(experience.target.mindUrl), {
            signal,
            label: 'tracking data',
            onProgress: track('mind'),
          }),
          fetchWithProgress(assetUrl(experience.content.url), {
            signal,
            label: 'AR content',
            onProgress: track('content'),
          }),
        ]);
        const mindBuffer = await mindBlob.arrayBuffer();
        const contentUrl = URL.createObjectURL(contentBlob);
        objectUrls.push(contentUrl);
        if (signal.aborted) return;
        setState({ progress: 1, assets: { mindBuffer, contentUrl }, error: null });
      } catch (err) {
        if (err.name === 'AbortError' || signal.aborted) return;
        setState((s) => ({ ...s, error: err }));
      }
    })();

    return () => {
      controller.abort();
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [experience, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
