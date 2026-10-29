/** Browser capability checks and camera error classification for WebAR. */

export class ARError extends Error {
  /**
   * @param {'insecure'|'unsupported'|'no-webgl'|'in-app-browser'|'permission-denied'|'no-camera'|'camera-busy'|'busy'|'engine'} code
   */
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

const IN_APP_BROWSER = /FBAN|FBAV|Instagram|LinkedInApp|Snapchat|BytedanceWebview|musical_ly|Line\//i;

export function isInAppBrowser() {
  return IN_APP_BROWSER.test(navigator.userAgent || '');
}

export function hasWebGL() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const ok = Boolean(gl);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Returns the first blocking problem preventing AR in this browser, or null.
 * Does NOT request camera permission.
 */
export function detectARSupportIssue() {
  if (!window.isSecureContext) {
    return new ARError(
      'insecure',
      'Camera access requires a secure (HTTPS) connection. Open this experience from its https:// link.',
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    if (isInAppBrowser()) {
      return new ARError(
        'in-app-browser',
        'This in-app browser cannot use the camera. Open the link in Safari or Chrome.',
      );
    }
    return new ARError(
      'unsupported',
      'This browser does not support camera access. Use the latest Safari (iOS) or Chrome (Android).',
    );
  }
  if (!hasWebGL()) {
    return new ARError('no-webgl', 'WebGL is not available, so 3D content cannot be displayed on this device.');
  }
  return null;
}

/**
 * Ask for motion-sensor access (used for gyro-assisted extended tracking).
 * iOS only allows this from a user gesture, so call it synchronously at the
 * start of a tap handler. Resolves to false if unavailable or denied; AR still
 * works, content then simply holds its last screen position when tracking is lost.
 * @returns {Promise<boolean>}
 */
export function requestOrientationAccess() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return Promise.resolve(false);
  if (typeof DOE.requestPermission === 'function') {
    return DOE.requestPermission()
      .then((state) => state === 'granted')
      .catch(() => false);
  }
  return Promise.resolve(true);
}

/** Map a getUserMedia rejection to a user-facing ARError. */
export function classifyCameraError(err) {
  const name = err?.name || '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new ARError(
        'permission-denied',
        'Camera access was blocked. Allow camera access for this site in your browser settings, then try again.',
        err,
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new ARError('no-camera', 'No usable camera was found on this device.', err);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new ARError(
        'camera-busy',
        'The camera is being used by another app or tab. Close it and try again.',
        err,
      );
    case 'SecurityError':
      return new ARError('insecure', 'Camera access is blocked on insecure (non-HTTPS) pages.', err);
    default:
      return new ARError('unsupported', 'The camera could not be started on this browser.', err);
  }
}
