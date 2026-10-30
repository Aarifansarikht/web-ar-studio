import { useCallback, useEffect, useState } from 'react';
import { loadMindAR } from '../ar/loadMindAR.js';
import { mergeMindBuffers } from '../ar/mergeTargets.js';
import { fetchWithProgress } from '../services/assetLoader.js';
import { assetUrl } from '../utils/url.js';

// Relative share of the progress bar for each download.
const WEIGHTS = { engine: 0.3, mind: 0.15, content: 0.55 };

/**
 * Downloads everything the AR session needs (tracking engine, compiled
 * targets, AR content) before the camera is requested, with combined
 * progress. Takes one or more experiences (gallery); their compiled targets
 * are merged so target i is experiences[i].
 * Blob URLs are revoked when the experiences change or the page unmounts.
 * @returns {{progress: number, assets: {mindBuffer: ArrayBuffer, contentUrls: string[]}|null, error: Error|null, retry: () => void}}
 */
export function useExperiencePreload(experiences) {
  const [state, setState] = useState({ progress: 0, assets: null, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!experiences?.length) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const objectUrls = [];
    const n = experiences.length;
    const parts = { engine: 0, mind: new Array(n).fill(0), content: new Array(n).fill(0) };
    const share = (v) => (Array.isArray(v) ? v.reduce((a, b) => a + b, 0) / v.length : v);
    const report = () => {
      if (signal.aborted) return;
      const progress = Object.entries(parts).reduce((sum, [k, v]) => sum + share(v) * WEIGHTS[k], 0);
      setState((s) => ({ ...s, progress }));
    };
    const track = (key, i) => (fraction) => {
      if (fraction !== null) {
        if (i === undefined) parts[key] = fraction;
        else parts[key][i] = fraction;
      }
      report();
    };

    setState({ progress: 0, assets: null, error: null });

    (async () => {
      try {
        const [, mindBlobs, contentBlobs] = await Promise.all([
          loadMindAR()
            .catch(() => {
              throw new Error('The AR engine could not be downloaded. Check your connection.');
            })
            .then(() => track('engine')(1)),
          Promise.all(
            experiences.map((e, i) =>
              fetchWithProgress(assetUrl(e.target.mindUrl), { signal, label: 'tracking data', onProgress: track('mind', i) }),
            ),
          ),
          Promise.all(
            experiences.map((e, i) =>
              fetchWithProgress(assetUrl(e.content.url), { signal, label: 'AR content', onProgress: track('content', i) }),
            ),
          ),
        ]);
        const mindBuffer = mergeMindBuffers(await Promise.all(mindBlobs.map((b) => b.arrayBuffer())));
        const contentUrls = contentBlobs.map((b) => {
          const url = URL.createObjectURL(b);
          objectUrls.push(url);
          return url;
        });
        if (signal.aborted) return;
        setState({ progress: 1, assets: { mindBuffer, contentUrls }, error: null });
      } catch (err) {
        if (err.name === 'AbortError' || signal.aborted) return;
        setState((s) => ({ ...s, error: err }));
      }
    })();

    return () => {
      controller.abort();
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [experiences, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
