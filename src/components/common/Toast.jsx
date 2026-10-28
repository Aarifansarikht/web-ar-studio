import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import styles from './Toast.module.css';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const show = useCallback(
    (message, { tone = 'success', duration = 3200 } = {}) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, message, tone }]);
      setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const api = useMemo(
    () => ({
      success: (m, o) => show(m, { ...o, tone: 'success' }),
      error: (m, o) => show(m, { duration: 5000, ...o, tone: 'error' }),
      info: (m, o) => show(m, { ...o, tone: 'info' }),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.stack} role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`${styles.toast} ${styles[t.tone]}`}>
            <Icon name={t.tone === 'error' ? 'alert' : t.tone === 'info' ? 'info' : 'check'} size={18} />
            <span>{t.message}</span>
            <button className={styles.close} onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
