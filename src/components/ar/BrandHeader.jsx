import { assetUrl } from '../../utils/url.js';
import styles from './AR.module.css';

/**
 * Angled "glass tab" header hanging from the top edge, as in the reference:
 * logo (or brand name) with the accent "AR Experience" tagline underneath.
 */
export default function BrandHeader({ brand, compact = false }) {
  const logo = assetUrl(brand?.logoUrl);
  return (
    <div className={`${styles.tab} ${compact ? styles.tabCompact : ''}`}>
      <svg className={styles.tabShape} viewBox="0 0 320 72" preserveAspectRatio="none" aria-hidden="true">
        <path className={styles.tabFill} d="M0 0H320L294 72H26Z" />
        <path className={styles.tabEdge} d="M9 0L33 64H287L311 0" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className={`${styles.brand} ${compact ? styles.brandCompact : ''}`}>
        {logo ? (
          <img src={logo} alt={brand?.name || 'Logo'} className={styles.brandLogo} />
        ) : (
          <span className={styles.brandName}>{brand?.name || 'WebAR'}</span>
        )}
        <span className={styles.brandTag}>AR Experience</span>
      </div>
    </div>
  );
}
