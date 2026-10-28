import Icon, { CONTENT_ICONS } from '../common/Icon.jsx';
import { assetUrl } from '../../utils/url.js';
import styles from './ExperienceForm.module.css';

const TYPE_LABEL = { video: 'Video', image: 'Image', model: '3D model' };

/** Read-only overview of an experience (used on static hosting). */
export default function ExperienceSummary({ experience: exp }) {
  return (
    <section className={`card ${styles.section}`}>
      {exp.description && <p className="hint" style={{ marginBottom: 16 }}>{exp.description}</p>}
      <div className={styles.targetPreview}>
        <div className={styles.targetImageWrap}>
          <img src={assetUrl(exp.target.imageUrl)} alt="Target image" />
        </div>
        <div className={styles.targetMeta}>
          <dl className={styles.stats}>
            <div>
              <dt>Content</dt>
              <dd>
                <Icon name={CONTENT_ICONS[exp.content.type]} size={14} /> {TYPE_LABEL[exp.content.type]}
              </dd>
            </div>
            <div>
              <dt>Tracking quality</dt>
              <dd>{exp.target.quality ?? '—'}</dd>
            </div>
            <div>
              <dt>Features</dt>
              <dd>{exp.target.featureCount || '—'}</dd>
            </div>
            <div>
              <dt>Hotspots</dt>
              <dd>{exp.hotspots.length}</dd>
            </div>
          </dl>
          {exp.hotspots.length > 0 && (
            <ol className={styles.hotspotList}>
              {exp.hotspots.map((h, i) => (
                <li key={h.id}>
                  <span className={styles.hotspotIndex}>{i + 1}</span>
                  <span>{h.label}</span>
                  <span />
                </li>
              ))}
            </ol>
          )}
          <a className="btn btn-secondary" href={assetUrl(exp.target.imageUrl)} download target="_blank" rel="noopener noreferrer">
            <Icon name="download" /> Download target image (print this)
          </a>
        </div>
      </div>
    </section>
  );
}
