import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import ARSplash from '../components/ar/ARSplash.jsx';
import ARHud from '../components/ar/ARHud.jsx';
import ARMessage from '../components/ar/ARMessage.jsx';
import { useExperiencePreload } from '../hooks/useExperiencePreload.js';
import { useWebAR } from '../hooks/useWebAR.js';
import { detectARSupportIssue } from '../ar/environment.js';
import { getPublicExperience } from '../services/experienceService.js';
import styles from '../components/ar/AR.module.css';

/** Public page opened from the QR code: /ar/:id */
export default function ARExperience() {
  const { id } = useParams();
  const [load, setLoad] = useState({ loading: true, error: null, experience: null });
  const [attempt, setAttempt] = useState(0);
  const containerRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ loading: true, error: null, experience: null });
    getPublicExperience(id, { signal: controller.signal })
      .then((experience) => setLoad({ loading: false, error: null, experience }))
      .catch((error) => {
        if (error.name !== 'AbortError') setLoad({ loading: false, error, experience: null });
      });
    return () => controller.abort();
  }, [id, attempt]);

  const experience = load.experience;
  const preload = useExperiencePreload(experience);
  const ar = useWebAR({ containerRef, experience, assets: preload.assets });
  const supportIssue = useMemo(() => detectARSupportIssue(), []);

  useEffect(() => {
    document.title = experience ? `${experience.name} · AR` : 'AR Experience';
  }, [experience]);

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

  const accent = experience?.brand?.accentColor || '#e5173f';
  const inSession = ['starting', 'scanning', 'tracking', 'holding', 'searching'].includes(ar.status);

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
            ? 'This AR experience does not exist or is no longer published.'
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
    overlay = <ARHud experience={experience} ar={ar} onClose={ar.stop} />;
  } else {
    overlay = (
      <ARSplash
        experience={experience}
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
