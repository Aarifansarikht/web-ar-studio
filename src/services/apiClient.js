import { API_BASE_URL } from '../config.js';

const TOKEN_KEY = 'webar.adminToken';
export const AUTH_REQUIRED_EVENT = 'webar:auth-required';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function getAdminToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setAdminToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode) — token lives for this page only.
  }
}

function authHeaders(auth) {
  const token = auth ? getAdminToken() : '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function toError(status, body) {
  if (status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  const message =
    (body && typeof body === 'object' && body.error) ||
    (status === 0 ? 'Network error: the server could not be reached.' : `Request failed (${status}).`);
  return new ApiError(status, message);
}

/**
 * JSON request helper.
 * @param {string} path API path, e.g. `/api/experiences`
 */
export async function apiRequest(path, { method = 'GET', json, auth = true, signal } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      signal,
      headers: {
        ...authHeaders(auth),
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw toError(0);
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw toError(res.status, body);
  return body;
}

/**
 * Multipart upload with progress (XHR, since fetch has no upload progress).
 * @param {(fraction: number) => void} [onProgress]
 */
export function apiUpload(path, { method = 'POST', formData, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `${API_BASE_URL}${path}`);
    const headers = authHeaders(true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(toError(xhr.status, xhr.response));
    };
    xhr.onerror = () => reject(toError(0));
    xhr.send(formData);
  });
}
