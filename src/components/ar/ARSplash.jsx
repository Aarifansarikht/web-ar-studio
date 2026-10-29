import Icon from '../common/Icon.jsx';
import BrandHeader from './BrandHeader.jsx';
import { assetUrl } from '../../utils/url.js';
import styles from './AR.module.css';

/**
 * Landing screen opened from the QR code: brand header, hero image and a
 * "Preloading" bar while assets download, then the Start AR button.
 * The camera is NOT requested here.
 */
export default function ARSplash({ experience, progress, ready, loadError, onRetry, supportIssue, onStart }) {
  const pct = Math.round(progress * 100);

  return (
    <div className={styles.splash}>
      <img
        className={styles.splashBg}
        src={assetUrl(experience.brand?.coverUrl || experience.target.imageUrl)}
        alt=""
        aria-hidden="true"
      />
      <div className={styles.splashShade} />

      <header className={styles.splashHeader}>
        <BrandHeader brand={experience.brand} />
      </header>

      <div className={styles.splashBody}>
        <div className={styles.splashCopy}>
          <h1>{experience.name}</h1>
          {experience.description && <p>{experience.description}</p>}
        </div>

        {loadError ? (
          <div className={styles.splashPanel} role="alert">
            <p className={styles.panelError}>
              <Icon name="alert" size={18} /> {loadError.message || 'The experience could not be loaded.'}
            </p>
            <button className={styles.primaryBtn} onClick={onRetry}>
              <Icon name="refresh" size={18} /> Try again
            </button>
          </div>
        ) : !ready ? (
          <div className={styles.preload} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Preloading">
            <div className={styles.preloadBar}>
              <span style={{ width: `${Math.max(4, pct)}%` }} />
            </div>
            <span className={styles.preloadLabel}>Preloading {pct}%</span>
          </div>
        ) : supportIssue ? (
          <div className={styles.splashPanel} role="alert">
            <p className={styles.panelError}>
              <Icon name="alert" size={18} /> {supportIssue.message}
            </p>
          </div>
        ) : (
          <div className={styles.splashPanel}>
            <button className={styles.primaryBtn} onClick={onStart} autoFocus>
              <Icon name="camera" size={20} /> Start AR
            </button>
            <p className={styles.splashHint}>
              <Icon name="target" size={16} /> Point your camera at the artwork, even just part of it. You&apos;ll be asked for camera access.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
