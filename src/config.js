const trimSlash = (s) => (s || '').trim().replace(/\/+$/, '');

/** Public HTTPS base URL that QR codes point to (see README). */
export const PUBLIC_APP_URL = trimSlash(import.meta.env.VITE_PUBLIC_APP_URL);

/** API origin when it differs from the frontend origin. Empty = same origin. */
export const API_BASE_URL = trimSlash(import.meta.env.VITE_API_BASE_URL);
