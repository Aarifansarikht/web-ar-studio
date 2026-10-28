import { useRef, useState } from 'react';
import FileDrop from '../common/FileDrop.jsx';
import Icon from '../common/Icon.jsx';
import { TARGET_ACCEPT, compileImageTarget } from '../../services/imageTargetService.js';
import { formatBytes } from '../../utils/format.js';
import styles from './ExperienceForm.module.css';

const QUALITY = {
  good: { tone: 'success', label: 'Good tracking quality' },
  fair: { tone: 'warning', label: 'Fair tracking quality' },
  poor: { tone: 'danger', label: 'Poor tracking quality' },
};

/**
 * Target image picker. Selecting an image immediately compiles it into MindAR
 * tracking data and reports the result (or error) to the parent form.
 *
 * @param {object} props
 * @param {string|null} props.previewUrl Current image (new upload or saved one)
 * @param {object|null} props.compiled Result of the last compile in this session
 * @param {{quality: string|null, featureCount: number, width: number, height: number}} props.saved
 * @param {(result: object|null) => void} props.onCompiled
 * @param {(busy: boolean) => void} props.onBusyChange
 */
export default function TargetImageField({ previewUrl, compiled, saved, onCompiled, onBusyChange, error }) {
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [compileError, setCompileError] = useState('');
  const [showPoints, setShowPoints] = useState(true);
  const jobRef = useRef(0);

  const handleFile = async (file) => {
    const job = ++jobRef.current;
    setCompileError('');
    setProgress(0);
    setBusy(true);
    onBusyChange?.(true);
    try {
      const result = await compileImageTarget(file, (p) => job === jobRef.current && setProgress(p));
      if (job !== jobRef.current) return;
      onCompiled({ ...result, file });
    } catch (err) {
      if (job !== jobRef.current) return;
      setCompileError(err.message || 'Compilation failed.');
    } finally {
      if (job === jobRef.current) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  };

  const quality = compiled?.quality ?? saved.quality;
  const featureCount = compiled?.featureCount ?? saved.featureCount;
  const dims = compiled ?? saved;

  return (
    <div className={styles.targetField}>
      {busy ? (
        <div className={styles.compiling} role="status">
          <span className="spinner" />
          <div>
            <strong>Compiling tracking data… {Math.round(progress * 100)}%</strong>
            <p className="hint">Extracting image features with MindAR. This runs in your browser.</p>
            <div className="progress">
              <span style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        </div>
      ) : previewUrl ? (
        <div className={styles.targetPreview}>
          <div className={styles.targetImageWrap}>
            <img src={previewUrl} alt="Target" />
            {showPoints && compiled?.trackingPoints && (
              <svg className={styles.points} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                {compiled.trackingPoints.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r="0.008" />
                ))}
              </svg>
            )}
          </div>
          <div className={styles.targetMeta}>
            {quality && (
              <span className={`badge badge-${QUALITY[quality].tone}`}>{QUALITY[quality].label}</span>
            )}
            <dl className={styles.stats}>
              <div>
                <dt>Features</dt>
                <dd>{featureCount || '—'}</dd>
              </div>
              {compiled && (
                <div>
                  <dt>Tracking points</dt>
                  <dd>{compiled.trackingCount}</dd>
                </div>
              )}
              <div>
                <dt>Tracking size</dt>
                <dd>{dims.width && dims.height ? `${dims.width}×${dims.height}` : '—'}</dd>
              </div>
              {compiled?.file && (
                <div>
                  <dt>File</dt>
                  <dd>{formatBytes(compiled.file.size)}</dd>
                </div>
              )}
              {compiled?.mindBlob && (
                <div>
                  <dt>.mind data</dt>
                  <dd>{formatBytes(compiled.mindBlob.size)}</dd>
                </div>
              )}
            </dl>
            {compiled?.trackingPoints && (
              <label className="checkbox">
                <input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} />
                Show tracking points
              </label>
            )}
            {compiled?.warnings?.map((w) => (
              <div key={w} className="alert alert-warning">
                <Icon name="alert" />
                <div>{w}</div>
              </div>
            ))}
            {compiled && (
              <div className="alert alert-success">
                <Icon name="check" />
                <div>Tracking data compiled. It will be uploaded with the experience.</div>
              </div>
            )}
            <FileDrop
              compact
              accept={TARGET_ACCEPT}
              onFile={handleFile}
              title="Replace target image"
              hint="The new image will be recompiled"
              icon="refresh"
            />
          </div>
        </div>
      ) : (
        <FileDrop
          accept={TARGET_ACCEPT}
          onFile={handleFile}
          title="Upload the image visitors will scan"
          hint="JPG, PNG or WebP · min 300px · detailed, high-contrast artwork tracks best"
          icon="target"
        />
      )}
      {(compileError || error) && (
        <div className="alert alert-danger" role="alert">
          <Icon name="alert" />
          <div>{compileError || error}</div>
        </div>
      )}
    </div>
  );
}
