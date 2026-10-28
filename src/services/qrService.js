import { slugify } from '../utils/format.js';

/** Download a rendered QR canvas as a PNG file. */
export function downloadQrPng(canvas, experienceName) {
  if (!canvas) throw new Error('QR code is not ready yet.');
  const link = document.createElement('a');
  link.download = `${slugify(experienceName)}-qr.png`;
  link.href = canvas.toDataURL('image/png');
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Copy text to the clipboard, with a fallback for non-secure contexts. */
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Copy failed');
}
