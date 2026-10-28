import FileDrop from '../common/FileDrop.jsx';
import Icon, { CONTENT_ICONS } from '../common/Icon.jsx';
import { CONTENT_TYPES } from '../../services/experienceService.js';
import { formatBytes } from '../../utils/format.js';
import styles from './ExperienceForm.module.css';

const HINTS = {
  video: 'MP4 (H.264) plays everywhere. Same aspect ratio as the target works best for overlays.',
  image: 'JPG, PNG or WebP. Transparent PNGs are supported.',
  model: 'Self-contained .glb recommended (.gltf must embed its textures). Draco & Meshopt supported.',
};

export default function ContentField({ content, file, savedFileName, onChange, onFile, error }) {
  const typeInfo = CONTENT_TYPES.find((t) => t.value === content.type);
  const currentName = file?.name ?? savedFileName;

  return (
    <div className={styles.stack}>
      <div className={styles.segmented} role="radiogroup" aria-label="AR content type">
        {CONTENT_TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={content.type === t.value}
            className={content.type === t.value ? styles.segActive : undefined}
            onClick={() => onChange({ type: t.value })}
          >
            <Icon name={CONTENT_ICONS[t.value]} size={17} /> {t.label}
          </button>
        ))}
      </div>

      {currentName ? (
        <div className={styles.fileRow}>
          <span className={styles.fileIcon}>
            <Icon name={CONTENT_ICONS[content.type]} size={18} />
          </span>
          <div className={styles.fileInfo}>
            <strong title={currentName}>{currentName}</strong>
            <span>{file ? `${formatBytes(file.size)} · new upload` : 'Saved on server'}</span>
          </div>
          <FileDrop compact accept={typeInfo.accept} onFile={onFile} title="Replace" icon="refresh" />
        </div>
      ) : (
        <FileDrop
          accept={typeInfo.accept}
          onFile={onFile}
          title={`Upload ${typeInfo.label.toLowerCase()}`}
          hint={HINTS[content.type]}
          icon={CONTENT_ICONS[content.type]}
        />
      )}
      {error && (
        <div className="alert alert-danger" role="alert">
          <Icon name="alert" />
          <div>{error}</div>
        </div>
      )}

      <div className={styles.optionsRow}>
        {content.type !== 'model' && (
          <div className="field">
            <label className="label" htmlFor="fit">
              Size
            </label>
            <select
              id="fit"
              className="select"
              value={content.fit}
              onChange={(e) => onChange({ fit: e.target.value })}
            >
              <option value="target">Match target exactly (overlay)</option>
              <option value="natural">Keep {content.type}&apos;s own aspect ratio</option>
            </select>
          </div>
        )}
        {content.type === 'video' && (
          <div className={styles.checks}>
            <label className="checkbox">
              <input type="checkbox" checked={content.loop} onChange={(e) => onChange({ loop: e.target.checked })} />
              Loop video
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={content.startMuted}
                onChange={(e) => onChange({ startMuted: e.target.checked })}
              />
              Start muted (recommended for autoplay)
            </label>
          </div>
        )}
        {content.type === 'model' && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={content.playAnimations}
              onChange={(e) => onChange({ playAnimations: e.target.checked })}
            />
            Play embedded animations
          </label>
        )}
      </div>
    </div>
  );
}
