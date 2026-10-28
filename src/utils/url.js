import { API_BASE_URL, PUBLIC_APP_URL } from '../config.js';

/** Base URL used for shareable links and QR codes. */
export function getPublicBaseUrl() {
  return PUBLIC_APP_URL || window.location.origin;
}

export function isPublicUrlConfigured() {
  return Boolean(PUBLIC_APP_URL);
}

export function buildExperienceUrl(id) {
  return `${getPublicBaseUrl()}/ar/${encodeURIComponent(id)}`;
}

/** Resolve a server-relative asset path (e.g. /uploads/...) to an absolute URL. */
export function assetUrl(path) {
  if (!path) return null;
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  return `${API_BASE_URL || window.location.origin}${path}`;
}

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

/**
 * Classify a URL so the admin can tell whether a QR code will actually work
 * on a visitor's phone.
 * @returns {{kind: 'production'|'local'|'lan'|'insecure', label: string, message: string}}
 */
export function classifyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'local', label: 'Invalid URL', message: 'The public URL is not a valid absolute URL.' };
  }
  const host = parsed.hostname;
  const https = parsed.protocol === 'https:';

  if (host === 'localhost' || host === '[::1]' || host.startsWith('127.') || host.endsWith('.localhost')) {
    return {
      kind: 'local',
      label: 'Local only',
      message:
        'This link points to localhost, so phones cannot open it. Set VITE_PUBLIC_APP_URL to your deployed HTTPS URL (or a LAN/tunnel URL for testing).',
    };
  }
  if (PRIVATE_IPV4.test(host) || host.endsWith('.local')) {
    return {
      kind: 'lan',
      label: https ? 'LAN (testing)' : 'LAN · HTTP',
      message: https
        ? 'Works only for devices on the same network, and they must accept the self-signed certificate. Use a deployed HTTPS URL for production.'
        : 'Phones block the camera on non-HTTPS pages. Enable VITE_DEV_HTTPS=true or use an HTTPS tunnel for device testing.',
    };
  }
  if (!https) {
    return {
      kind: 'insecure',
      label: 'Not HTTPS',
      message: 'Mobile browsers only allow camera access over HTTPS. Use an https:// public URL.',
    };
  }
  return { kind: 'production', label: 'Public HTTPS', message: 'Ready to share: this link is publicly reachable over HTTPS.' };
}

/** Badge tone for each URL classification. */
export const URL_KIND_TONE = { production: 'success', lan: 'warning', local: 'danger', insecure: 'danger' };
