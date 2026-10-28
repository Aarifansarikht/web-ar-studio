import { useEffect, useState } from 'react';
import Icon from '../common/Icon.jsx';
import BrandHeader from './BrandHeader.jsx';
import { assetUrl } from '../../utils/url.js';
import styles from './AR.module.css';

/** Overlay shown on top of the live camera view during an AR session. */
export default function ARHud({ experience, ar, everFound, onClose }) {
  const { status } = ar;
  const scanning = status === 'scanning';
  const tracking = status === 'tracking';
  const hasHotspots = experience.hotspots?.length > 0;
  const [showTapHint, setShowTapHint] = useState(false);

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
      </header>

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
            {everFound ? 'Move your camera over the target image' : 'Point your camera at the image'}
          </p>
        )}
        {tracking && showTapHint && (
          <p className={styles.hint} role="status">
            <Icon name="pin" size={18} /> Tap the dots to explore
          </p>
        )}
        {tracking && ar.activeHotspot && (
          // The label itself is drawn on the target in 3D; announce it for screen readers.
          <p className="visually-hidden" role="status">
            {ar.activeHotspot.label}
          </p>
        )}
      </div>

      {tracking && ar.videoBlocked && (
        <button className={styles.playOverlay} onClick={ar.resumeVideo}>
          <Icon name="play" size={28} />
          <span>Tap to play video</span>
        </button>
      )}

      {ar.hasVideo && (tracking || scanning) && !ar.videoBlocked && (
        <button
          className={`${styles.iconBtn} ${styles.muteBtn}`}
          onClick={ar.toggleMute}
          aria-label={ar.muted ? 'Turn sound on' : 'Mute'}
          aria-pressed={!ar.muted}
        >
          <Icon name={ar.muted ? 'volumeOff' : 'volume'} size={20} />
        </button>
      )}
    </div>
  );
}
