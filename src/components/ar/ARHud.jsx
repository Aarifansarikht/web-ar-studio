import { useEffect, useState } from 'react';
import Icon from '../common/Icon.jsx';
import BrandHeader from './BrandHeader.jsx';
import { assetUrl } from '../../utils/url.js';
import styles from './AR.module.css';

const CHIP = {
  tracking: { label: 'Tracking', tone: 'live' },
  holding: { label: 'Extended tracking', tone: 'hold' },
  searching: { label: 'Searching', tone: 'hold' },
  fullscreen: { label: 'Full screen', tone: 'live' },
};

/** Overlay shown on top of the live camera view during an AR session. */
export default function ARHud({ experience, ar, onClose }) {
  const { status } = ar;
  const scanning = status === 'scanning' && !ar.fullscreen;
  const tracking = status === 'tracking';
  // After the first lock the content stays on screen; the scan UI never returns.
  const active = tracking || status === 'holding' || ar.fullscreen;
  const hasHotspots = experience.hotspots?.length > 0;
  const [showTapHint, setShowTapHint] = useState(false);
  const chip = ar.fullscreen ? CHIP.fullscreen : CHIP[status];

  // Briefly suggest tapping hotspots the first time the target is found.
  useEffect(() => {
    if (!tracking || !hasHotspots) return undefined;
    setShowTapHint(true);
    const t = setTimeout(() => setShowTapHint(false), 4000);
    return () => clearTimeout(t);
  }, [tracking, hasHotspots]);

  const aspect = experience.target.width && experience.target.height
    ? experience.target.width / experience.target.height
    : 1;

  return (
    <div className={styles.hud}>
      <header className={styles.hudTop}>
        <BrandHeader brand={experience.brand} compact />
        <button className={styles.iconBtn} onClick={onClose} aria-label="Close AR and turn off camera">
          <Icon name="x" size={22} />
        </button>
        {chip && (
          <span key={chip.label} className={`${styles.statusChip} ${styles[chip.tone]}`} role="status">
            <i />
            {chip.label}
          </span>
        )}
      </header>

      {ar.stats && (
        <div className={styles.debugStats} aria-hidden="true">
          tracker {ar.stats.trackFps} fps · {ar.stats.tracking ? 'locked' : 'searching'}
        </div>
      )}

      {status === 'starting' && (
        <div className={styles.centerStatus} role="status">
          <span className={styles.loader} />
          <span>Starting camera…</span>
        </div>
      )}

      {scanning && (
        <div className={styles.scanArea} aria-hidden="true">
          <div className={styles.scanFrame} style={{ aspectRatio: aspect }}>
            <img src={assetUrl(experience.target.imageUrl)} alt="" />
            <i className={styles.c1} />
            <i className={styles.c2} />
            <i className={styles.c3} />
            <i className={styles.c4} />
            <span className={styles.scanLine} />
          </div>
        </div>
      )}

      <div className={styles.hudBottom}>
        {scanning && (
          <p className={styles.hint} role="status">
            <Icon name="camera" size={18} />
            Point your camera at the image
          </p>
        )}
        {status === 'searching' && !ar.fullscreen && (
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
