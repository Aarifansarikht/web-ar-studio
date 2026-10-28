import Icon from '../common/Icon.jsx';
import styles from './AR.module.css';

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const TITLES = {
  'permission-denied': 'Camera access needed',
  'no-camera': 'No camera found',
  'camera-busy': 'Camera unavailable',
  insecure: 'Secure connection required',
  'in-app-browser': 'Open in your browser',
  unsupported: 'Browser not supported',
  'no-webgl': 'Graphics not supported',
  engine: 'AR could not start',
};

function Tips({ code }) {
  if (code === 'permission-denied') {
    return isIOS() ? (
      <ol className={styles.tips}>
        <li>
          Tap <b>aA</b> in Safari&apos;s address bar → <b>Website Settings</b>.
        </li>
        <li>
          Set <b>Camera</b> to <b>Allow</b>, then tap Try again.
        </li>
      </ol>
    ) : (
      <ol className={styles.tips}>
        <li>Tap the icon left of the address bar → <b>Permissions</b>.</li>
        <li>
          Allow <b>Camera</b>, then tap Try again.
        </li>
      </ol>
    );
  }
  if (code === 'in-app-browser') {
    return (
      <ol className={styles.tips}>
        <li>
          Tap the <b>⋯</b> or share menu.
        </li>
        <li>
          Choose <b>Open in Safari</b> / <b>Open in Chrome</b>.
        </li>
      </ol>
    );
  }
  if (code === 'unsupported') {
    return <p className={styles.tipText}>Use the latest Safari on iPhone/iPad or Chrome on Android.</p>;
  }
  return null;
}

/** Full-screen message for AR errors and missing experiences. */
export default function ARMessage({ code, title, message, onRetry, onBack, backLabel = 'Back' }) {
  return (
    <div className={styles.message} role="alert">
      <div className={styles.messageCard}>
        <span className={styles.messageIcon}>
          <Icon name={code === 'permission-denied' ? 'camera' : 'alert'} size={26} />
        </span>
        <h2>{title || TITLES[code] || 'Something went wrong'}</h2>
        <p>{message}</p>
        <Tips code={code} />
        <div className={styles.messageActions}>
          {onRetry && (
            <button className={styles.primaryBtn} onClick={onRetry}>
              <Icon name="refresh" size={18} /> Try again
            </button>
          )}
          {onBack && (
            <button className={styles.secondaryBtn} onClick={onBack}>
              {backLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
