import { useEffect, useRef, useState } from 'react';
import Icon from '../common/Icon.jsx';
import BrandHeader from './BrandHeader.jsx';
import styles from './AR.module.css';

// A short loss of tracking (camera moved away briefly) must not interrupt the
// experience: no UI reacts until the image has been out of view this long.
const LOST_HINT_DELAY_MS = 1500;

/** Overlay shown on top of the live camera view during an AR session. */
export default function ARHud({ experience, ar, onClose }) {
  const { status } = ar;
  const scanning = status === 'scanning' && !ar.fullscreen;
  const tracking = status === 'tracking';
  // After the first lock the content stays on screen; the scan UI never returns.
  const active = tracking || ar.fullscreen;
  const hasHotspots = experience.hotspots?.length > 0;
  const [showTapHint, setShowTapHint] = useState(false);
  const [showLostHint, setShowLostHint] = useState(false);
  const tapHintShown = useRef(false);

  // Suggest tapping hotspots once per session, on the first lock only.
  useEffect(() => {
    if (!tracking || !hasHotspots || tapHintShown.current) return undefined;
    tapHintShown.current = true;
    setShowTapHint(true);
    const t = setTimeout(() => setShowTapHint(false), 4000);
    return () => clearTimeout(t);
  }, [tracking, hasHotspots]);

  // Only guide the user back after a real absence, not a brief look away.
  useEffect(() => {
    if (status !== 'searching') {
      setShowLostHint(false);
      return undefined;
    }
    const t = setTimeout(() => setShowLostHint(true), LOST_HINT_DELAY_MS);
    return () => clearTimeout(t);
  }, [status]);

  return (
    <div className={styles.hud}>
      <header className={styles.hudTop}>
        <BrandHeader brand={experience.brand} compact />
        <button className={styles.iconBtn} onClick={onClose} aria-label="Close AR and turn off camera">
          <Icon name="x" size={22} />
        </button>
      </header>

      {ar.stats && (
        <div className={styles.debugStats} aria-hidden="true">
          tracker {ar.stats.trackFps} fps · {ar.stats.tracking ? 'locked' : 'searching'}
          <br />
          wobble {ar.stats.wobbleRaw}px → {ar.stats.wobbleShown}px · {ar.stats.trackLevel}
        </div>
      )}

      {status === 'starting' && (
        <div className={styles.centerStatus} role="status">
          <span className={styles.loader} />
          <span>Starting camera…</span>
        </div>
      )}

      <div className={styles.hudBottom}>
        {/* No scan frame: any part of the image (even one corner) is recognised. */}
        {scanning && (
          <p className={styles.hint} role="status">
            <Icon name="camera" size={18} />
            Point your camera at the artwork
          </p>
        )}
        {showLostHint && !ar.fullscreen && (
          <p className={styles.hint} role="status">
            <Icon name="target" size={18} />
            Point at the artwork to continue
          </p>
        )}
        {active && showTapHint && (
          <p className={styles.hint} role="status">
            <Icon name="pin" size={18} /> Tap the dots to explore
          </p>
        )}
        {active && ar.activeHotspot && (
          // The label itself is drawn on the target in 3D; announce it for screen readers.
          <p className="visually-hidden" role="status">
            {ar.activeHotspot.label}
          </p>
        )}
      </div>

      {active && ar.videoBlocked && (
        <button className={styles.playOverlay} onClick={ar.resumeVideo}>
          <Icon name="play" size={28} />
          <span>Tap to play video</span>
        </button>
      )}

      <div className={styles.sideControls}>
        {active && (
          <button
            className={styles.iconBtn}
            onClick={ar.toggleFullscreen}
            aria-label={ar.fullscreen ? 'Return to AR view' : 'Show full screen'}
            aria-pressed={ar.fullscreen}
          >
            <Icon name={ar.fullscreen ? 'shrink' : 'expand'} size={20} />
          </button>
        )}
        {ar.hasVideo && (active || scanning) && !ar.videoBlocked && (
          <button
            className={styles.iconBtn}
            onClick={ar.toggleMute}
            aria-label={ar.muted ? 'Turn sound on' : 'Mute'}
            aria-pressed={!ar.muted}
          >
            <Icon name={ar.muted ? 'volumeOff' : 'volume'} size={20} />
          </button>
        )}
      </div>
    </div>
  );
}
