import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import Icon from '../common/Icon.jsx';
import AdminAuthGate from './AdminAuthGate.jsx';
import { getHealth } from '../../services/experienceService.js';
import { URL_KIND_TONE, classifyUrl, getPublicBaseUrl, isPublicUrlConfigured } from '../../utils/url.js';
import styles from './AdminLayout.module.css';

const AUTH_LABEL = {
  token: 'online · token auth',
  open: 'online · open (dev)',
  unconfigured: 'online · token not set',
  static: 'static hosting · read-only',
};

export default function AdminLayout() {
  const [health, setHealth] = useState(null);
  const baseUrl = getPublicBaseUrl();
  const urlInfo = classifyUrl(baseUrl);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch(() => setHealth({ ok: false }));
  }, []);

  const navClass = ({ isActive }) => (isActive ? styles.active : undefined);

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link to="/admin" className={styles.brand}>
          <span className={styles.logo}>
            <Icon name="target" size={18} strokeWidth={2.2} />
          </span>
          <span>
            WebAR <b>Studio</b>
          </span>
        </Link>

        <nav className={styles.nav} aria-label="Admin">
          <NavLink to="/admin" end className={navClass}>
            <Icon name="grid" size={18} /> Experiences
          </NavLink>
          <NavLink to="/admin/experiences/new" className={navClass}>
            <Icon name="plus" size={18} /> New experience
          </NavLink>
        </nav>

        <div className={styles.envCard}>
          <div className={styles.envRow}>
            <span className={styles.envLabel}>QR base URL</span>
            <span className={`badge badge-${URL_KIND_TONE[urlInfo.kind]}`}>{urlInfo.label}</span>
          </div>
          <code className={styles.envUrl} title={baseUrl}>
            {baseUrl}
          </code>
          {!isPublicUrlConfigured() && (
            <p className={styles.envNote}>VITE_PUBLIC_APP_URL is not set, so this browser&apos;s origin is used.</p>
          )}
          <div className={styles.envRow}>
            <span className={styles.envLabel}>API</span>
            {health === null ? (
              <span className={styles.envMuted}>checking…</span>
            ) : health.ok ? (
              <span className={styles.envMuted}>{AUTH_LABEL[health.adminAuth]}</span>
            ) : (
              <span className={styles.envError}>offline</span>
            )}
          </div>
        </div>
      </aside>

      <main className={styles.main}>
        <Outlet />
      </main>
      <AdminAuthGate />
    </div>
  );
}
