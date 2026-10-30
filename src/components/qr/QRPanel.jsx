import { useRef } from 'react';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import Icon from '../common/Icon.jsx';
import { useToast } from '../common/Toast.jsx';
import { copyText, downloadQrPng } from '../../services/qrService.js';
import { URL_KIND_TONE, buildExperienceUrl, classifyUrl } from '../../utils/url.js';
import styles from './QRPanel.module.css';

/**
 * QR code + share actions for one experience's public AR URL, or for any
 * other public link (`url` + `name`, e.g. the gallery).
 */
export default function QRPanel({ experience, url: customUrl, name, title = 'QR code' }) {
  const toast = useToast();
  const exportRef = useRef(null);
  const url = customUrl ?? buildExperienceUrl(experience.id);
  const urlInfo = classifyUrl(url);
  const isDraft = experience ? experience.status !== 'published' : false;

  const onCopy = async () => {
    try {
      await copyText(url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy the link — select it manually.');
    }
  };

  const onDownload = () => {
    try {
      downloadQrPng(exportRef.current, name ?? experience.name);
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <section className={`card ${styles.panel}`} aria-label={title}>
      <header className={styles.head}>
        <h2>
          <Icon name="qr" size={18} /> {title}
        </h2>
        <span className={`badge badge-${URL_KIND_TONE[urlInfo.kind]}`}>{urlInfo.label}</span>
      </header>

      <div className={styles.qrWrap}>
        <QRCodeSVG value={url} size={208} level="M" marginSize={2} title={`QR code for ${url}`} />
      </div>
      {/* High-resolution canvas used only for the PNG download. */}
      <QRCodeCanvas ref={exportRef} value={url} size={1024} level="M" marginSize={4} className={styles.exportCanvas} />

      <div className={styles.urlRow}>
        <code className={styles.url} title={url}>
          {url}
        </code>
        <button type="button" className="btn btn-secondary btn-sm btn-icon" onClick={onCopy} aria-label="Copy link">
          <Icon name="copy" />
        </button>
      </div>

      <div className={styles.actions}>
        <button type="button" className="btn btn-primary" onClick={onDownload}>
          <Icon name="download" /> Download PNG
        </button>
        <a className="btn btn-secondary" href={url} target="_blank" rel="noopener noreferrer">
          <Icon name="external" /> Open
        </a>
      </div>

      {urlInfo.kind !== 'production' && (
        <div className={`alert ${urlInfo.kind === 'lan' ? 'alert-warning' : 'alert-danger'}`}>
          <Icon name="alert" />
          <div>{urlInfo.message}</div>
        </div>
      )}
      {isDraft && (
        <div className="alert alert-info">
          <Icon name="info" />
          <div>This experience is a draft. Visitors will see “not published” until you publish it.</div>
        </div>
      )}
    </section>
  );
}
