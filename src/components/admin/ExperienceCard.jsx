import { Link } from 'react-router-dom';
import Icon, { CONTENT_ICONS } from '../common/Icon.jsx';
import { useToast } from '../common/Toast.jsx';
import { copyText } from '../../services/qrService.js';
import { assetUrl, buildExperienceUrl } from '../../utils/url.js';
import { formatDate } from '../../utils/format.js';
import styles from './ExperienceCard.module.css';

const TYPE_LABEL = { video: 'Video', image: 'Image', model: '3D model' };

export default function ExperienceCard({ experience }) {
  const toast = useToast();
  const url = buildExperienceUrl(experience.id);
  const published = experience.status === 'published';

  return (
    <article className={`card ${styles.card}`}>
      <Link to={`/admin/experiences/${experience.id}`} className={styles.thumb} aria-label={`Manage ${experience.name}`}>
        <img src={assetUrl(experience.target.imageUrl)} alt="" loading="lazy" />
        <span className={styles.type}>
          <Icon name={CONTENT_ICONS[experience.content.type]} size={14} />
          {TYPE_LABEL[experience.content.type]}
        </span>
      </Link>
      <div className={styles.body}>
        <div className={styles.titleRow}>
          <h3 title={experience.name}>{experience.name}</h3>
          <span className={`badge ${published ? 'badge-success' : ''}`}>{published ? 'Published' : 'Draft'}</span>
        </div>
        <p className={styles.meta}>
          Updated {formatDate(experience.updatedAt)}
          {experience.hotspots?.length ? ` · ${experience.hotspots.length} hotspots` : ''}
        </p>
      </div>
      <footer className={styles.actions}>
        <Link to={`/admin/experiences/${experience.id}`} className="btn btn-secondary btn-sm">
          <Icon name="qr" /> Manage
        </Link>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          aria-label="Copy link"
          title="Copy link"
          onClick={() =>
            copyText(url).then(
              () => toast.success('Link copied'),
              () => toast.error('Copy failed'),
            )
          }
        >
          <Icon name="link" />
        </button>
        <a
          className="btn btn-ghost btn-sm btn-icon"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open experience in a new tab"
          title="Open experience"
        >
          <Icon name="external" />
        </a>
      </footer>
    </article>
  );
}
