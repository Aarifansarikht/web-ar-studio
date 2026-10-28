import { useEffect, useState } from 'react';
import Icon from '../common/Icon.jsx';
import { AUTH_REQUIRED_EVENT, setAdminToken } from '../../services/apiClient.js';
import { checkAdminAuth } from '../../services/experienceService.js';
import styles from './AdminAuthGate.module.css';

export const AUTH_UPDATED_EVENT = 'webar:auth-updated';

/** Modal asking for the ADMIN_TOKEN whenever the API answers 401. */
export default function AdminAuthGate() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onRequired = () => setOpen(true);
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired);
  }, []);

  if (!open) return null;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setAdminToken(token.trim());
    try {
      await checkAdminAuth();
      setOpen(false);
      setToken('');
      window.dispatchEvent(new Event(AUTH_UPDATED_EVENT));
    } catch (err) {
      setError(err.status === 401 ? 'That token is not valid.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <form className={`card ${styles.modal}`} onSubmit={submit}>
        <div className={styles.icon}>
          <Icon name="lock" size={22} />
        </div>
        <h2 id="auth-title">Admin access</h2>
        <p className="hint">Enter the ADMIN_TOKEN configured on the server. It is stored in this browser only.</p>
        <input
          className="input"
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Admin token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-invalid={Boolean(error)}
        />
        {error && <p className={styles.error}>{error}</p>}
        <button className="btn btn-primary btn-block" disabled={!token.trim() || busy}>
          {busy ? <span className="spinner" /> : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
