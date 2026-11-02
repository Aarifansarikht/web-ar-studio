import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import ARSplash from '../components/ar/ARSplash.jsx';
import ARHud from '../components/ar/ARHud.jsx';
import ARMessage from '../components/ar/ARMessage.jsx';
import { useExperiencePreload } from '../hooks/useExperiencePreload.js';
import { useWebAR } from '../hooks/useWebAR.js';
import { detectARSupportIssue } from '../ar/environment.js';
import { getPublicExperience, listPublicExperiences } from '../services/experienceService.js';
import styles from '../components/ar/AR.module.css';

/** Header and splash copy for the gallery link (one QR code for many artworks). */
function galleryInfo(experiences) {
  const first = experiences[0];
  return {
    id: 'gallery',
    name: 'AR Gallery',
    description: `Point your camera at any of the ${experiences.length} artworks. Each one comes to life on its own.`,
    brand: { name: 'AR Gallery', accentColor: first?.brand?.accentColor || '#1f6fff', logoUrl: null, coverUrl: first?.brand?.coverUrl ?? null },
    target: first?.target,
    hotspots: [],
    content: {},
  };
}

/**
 * Public AR page opened from a QR code.
 *   /ar/:id    one experience
 *   /gallery   every published artwork in one session (?ids=a,b,c picks and orders them):
 *              whichever artwork is in view shows its own content.
 */
export default function ARExperience({ gallery = false }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const idsParam = params.get('ids') || '';
  const [load, setLoad] = useState({ loading: true, error: null, experiences: null });
  const [attempt, setAttempt] = useState(0);
  const containerRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    const opts = { signal: controller.signal };
    setLoad({ loading: true, error: null, experiences: null });
    const ids = idsParam.split(',').map((x) => x.trim()).filter(Boolean);
    (gallery ? listPublicExperiences({ ...opts, ids }) : getPublicExperience(id, opts).then((e) => [e]))
      .then((experiences) => {
        if (!experiences.length) throw Object.assign(new Error('No published artworks.'), { status: 404 });
        setLoad({ loading: false, error: null, experiences });
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setLoad({ loading: false, error, experiences: null });
      });
    return () => controller.abort();
  }, [id, gallery, idsParam, attempt]);

  const experiences = load.experiences;
  const info = useMemo(() => (experiences ? (gallery ? galleryInfo(experiences) : experiences[0]) : null), [experiences, gallery]);
  const preload = useExperiencePreload(experiences);
  const ar = useWebAR({ containerRef, experiences, assets: preload.assets });
  const supportIssue = useMemo(() => detectARSupportIssue(), []);
  // In a gallery, the HUD follows the artwork in view once one was found.
  const hudExperience = gallery && ar.status !== 'scanning' && ar.status !== 'starting' ? ar.activeExperience : info;

  useEffect(() => {
    document.title = info ? `${info.name} · AR` : 'AR Experience';
  }, [info]);

  // Lock page scrolling / zooming gestures while on the AR page.
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prev;
    };
  }, []);

  // Called directly from the Start tap so permission prompts count as user-initiated.
  const start = useCallback(() => ar.start(), [ar]);

  const accent = hudExperience?.brand?.accentColor || '#e5173f';
  const inSession = ['starting', 'scanning', 'tracking', 'searching'].includes(ar.status);

  let overlay = null;
  if (load.loading) {
    overlay = (
      <div className={styles.loadingScreen} role="status">
        <span className={styles.loader} />
        <span>Loading experience…</span>
      </div>
    );
  } else if (load.error) {
    const notFound = load.error.status === 404;
    overlay = (
      <ARMessage
        code="engine"
        title={notFound ? 'Experience not available' : 'Could not load experience'}
        message={
          notFound
            ? gallery
              ? 'This gallery has no published artworks.'
              : 'This AR experience does not exist or is no longer published.'
            : `${load.error.message} Check your connection and try again.`
        }
        onRetry={notFound ? undefined : () => setAttempt((n) => n + 1)}
      />
    );
  } else if (ar.status === 'error') {
    overlay = (
      <ARMessage
        code={ar.error?.code}
        message={ar.error?.message}
        onRetry={['insecure', 'unsupported', 'in-app-browser', 'no-webgl'].includes(ar.error?.code) ? undefined : start}
        onBack={ar.stop}
      />
    );
  } else if (inSession) {
    overlay = <ARHud experience={hudExperience} ar={ar} onClose={ar.stop} />;
  } else {
    overlay = (
      <ARSplash
        experience={info}
        artworks={gallery ? experiences : null}
        progress={preload.progress}
        ready={Boolean(preload.assets)}
        loadError={preload.error}
        onRetry={preload.retry}
        supportIssue={supportIssue}
        onStart={start}
      />
    );
  }

  return (
    <div className={styles.root} style={{ '--accent': accent }}>
      {/* Camera video + WebGL canvas are mounted here by the tracking session. */}
      <div
        ref={containerRef}
        className={`${styles.stage} ${ar.fullscreen ? styles.stageDim : ''}`}
        aria-hidden={!inSession}
      />
      {overlay}
    </div>
  );
}
