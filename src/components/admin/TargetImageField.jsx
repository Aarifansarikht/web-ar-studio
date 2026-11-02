import { useState } from 'react';
import FileDrop from '../common/FileDrop.jsx';
import Icon from '../common/Icon.jsx';
import { TARGET_ACCEPT, inspectImageTarget } from '../../services/imageTargetService.js';
import { formatBytes } from '../../utils/format.js';
import styles from './ExperienceForm.module.css';

/** Target picker for 8th Wall, which derives tracking data from the image. */
export default function TargetImageField({ previewUrl, compiled, saved, onCompiled, onBusyChange, error }) {
  const [busy, setBusy] = useState(false);
  const [targetError, setTargetError] = useState('');

  const handleFile = async (file) => {
    setTargetError('');
    setBusy(true);
    onBusyChange?.(true);
    try {
      onCompiled(await inspectImageTarget(file));
    } catch (err) {
      setTargetError(err.message || 'The target image could not be used.');
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  const dims = compiled ?? saved;
  return (
    <div className={styles.targetField}>
      {busy ? (
        <div className={styles.compiling} role="status">
          <span className="spinner" />
          <div>
            <strong>Checking target image…</strong>
            <p className="hint">Preparing this image for 8th Wall tracking.</p>
          </div>
        </div>
      ) : previewUrl ? (
        <div className={styles.targetPreview}>
          <div className={styles.targetImageWrap}><img src={previewUrl} alt="Target" /></div>
          <div className={styles.targetMeta}>
            <dl className={styles.stats}>
              <div><dt>Target size</dt><dd>{dims.width && dims.height ? `${dims.width}×${dims.height}` : '—'}</dd></div>
              {compiled?.file && <div><dt>File</dt><dd>{formatBytes(compiled.file.size)}</dd></div>}
            </dl>
            {compiled && <div className="alert alert-success"><Icon name="check" /><div>Target image ready for 8th Wall tracking.</div></div>}
            <FileDrop compact accept={TARGET_ACCEPT} onFile={handleFile} title="Replace target image" hint="The new image will replace the current 8th Wall target" icon="refresh" />
          </div>
        </div>
      ) : (
        <FileDrop accept={TARGET_ACCEPT} onFile={handleFile} title="Upload the image visitors will scan" hint="JPG, PNG or WebP · min 300px · detailed, high-contrast artwork tracks best" icon="target" />
      )}
      {(targetError || error) && <div className="alert alert-danger" role="alert"><Icon name="alert" /><div>{targetError || error}</div></div>}
    </div>
  );
}
