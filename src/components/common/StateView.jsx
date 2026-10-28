import Icon from './Icon.jsx';
import styles from './StateView.module.css';

/** Centered empty / error / loading state. */
export default function StateView({ icon = 'info', tone = 'neutral', title, children, action, loading = false }) {
  return (
    <div className={`${styles.wrap} ${styles[tone]}`}>
      <div className={styles.icon}>{loading ? <span className="spinner" /> : <Icon name={icon} size={26} />}</div>
      {title && <h3 className={styles.title}>{title}</h3>}
      {children && <div className={styles.body}>{children}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
