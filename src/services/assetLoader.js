/** Download helpers with byte-level progress, used by the AR preloader. */

export class AssetLoadError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

const RETRIES = 2;
const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

async function fetchOnce(url, { onProgress, signal, label }) {
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new AssetLoadError(`Network error while downloading the ${label}.`, { retryable: true });
  }
  if (!res.ok) {
    throw new AssetLoadError(`The ${label} could not be downloaded (HTTP ${res.status}).`, {
      retryable: res.status >= 500,
    });
  }

  const total = Number(res.headers.get('Content-Length')) || 0;
  const type = res.headers.get('Content-Type') || '';
  try {
    if (!res.body || !total) {
      onProgress?.(null);
      const blob = await res.blob();
      onProgress?.(1);
      return blob;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(Math.min(1, loaded / total));
    }
    return new Blob(chunks, { type });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Connection dropped mid-download.
    throw new AssetLoadError(`Network error while downloading the ${label}.`, { retryable: true });
  }
}

/**
 * Fetch a URL fully, reporting progress as a 0..1 fraction (or `null` when the
 * server does not send Content-Length). Transient failures (network errors,
 * dropped connections, 5xx) are retried with backoff — common on mobile data.
 * @returns {Promise<Blob>}
 */
export async function fetchWithProgress(url, { onProgress, signal, label = 'asset' } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce(url, { onProgress, signal, label });
    } catch (err) {
      if (err.name === 'AbortError' || !err.retryable || attempt >= RETRIES) throw err;
      onProgress?.(0);
      await wait(600 * (attempt + 1), signal);
    }
  }
}
