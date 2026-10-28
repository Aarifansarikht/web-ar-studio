import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Icon from '../components/common/Icon.jsx';
import StateView from '../components/common/StateView.jsx';
import { useToast } from '../components/common/Toast.jsx';
import ExperienceForm from '../components/admin/ExperienceForm.jsx';
import QRPanel from '../components/qr/QRPanel.jsx';
import ReadOnlyNotice from '../components/admin/ReadOnlyNotice.jsx';
import ExperienceSummary from '../components/admin/ExperienceSummary.jsx';
import { useDataSource } from '../hooks/useDataSource.js';
import { AUTH_UPDATED_EVENT } from '../components/admin/AdminAuthGate.jsx';
import { deleteExperience, getExperience, setExperienceStatus } from '../services/experienceService.js';
import { formatDate } from '../utils/format.js';
import styles from './AdminPages.module.css';

export default function ManageExperience() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [state, setState] = useState({ loading: true, error: null, experience: null });
  const [busy, setBusy] = useState(false);
  const source = useDataSource();
  // Remount the form after each save so it starts from the server's copy.
  const [formKey, setFormKey] = useState(0);

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    getExperience(id)
      .then((experience) => setState({ loading: false, error: null, experience }))
      .catch((error) => setState({ loading: false, error, experience: null }));
  }, [id]);

  useEffect(() => {
    load();
    window.addEventListener(AUTH_UPDATED_EVENT, load);
    return () => window.removeEventListener(AUTH_UPDATED_EVENT, load);
  }, [load]);

  const exp = state.experience;
  useEffect(() => {
    if (exp) document.title = `${exp.name} · WebAR Studio`;
  }, [exp]);

  const toggleStatus = async () => {
    setBusy(true);
    try {
      const next = await setExperienceStatus(id, exp.status === 'published' ? 'draft' : 'published');
      setState((s) => ({ ...s, experience: next }));
      toast.success(next.status === 'published' ? 'Experience published' : 'Experience moved to drafts');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${exp.name}”? Its QR code will stop working. This cannot be undone.`)) return;
    setBusy(true);
    try {
      await deleteExperience(id);
      toast.success('Experience deleted');
      navigate('/admin');
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };

  if (state.loading && !exp) {
    return (
      <div className={styles.page}>
        <StateView loading title="Loading experience…" />
      </div>
    );
  }
  if (state.error) {
    return (
      <div className={styles.page}>
        <div className="card">
          <StateView
            icon="alert"
            tone="danger"
            title={state.error.status === 404 ? 'Experience not found' : 'Could not load experience'}
            action={
              <>
                <Link to="/admin" className="btn btn-secondary">
                  <Icon name="arrowLeft" /> Back to experiences
                </Link>
                {state.error.status !== 404 && (
                  <button className="btn btn-primary" onClick={load}>
                    <Icon name="refresh" /> Retry
                  </button>
                )}
              </>
            }
          >
            {state.error.message}
          </StateView>
        </div>
      </div>
    );
  }

  const published = exp.status === 'published';
  const readOnly = source !== 'api'; // also true while the data source is being detected

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link to="/admin" className={styles.back}>
            <Icon name="arrowLeft" size={16} /> Experiences
          </Link>
          <div className={styles.titleRow}>
            <h1>{exp.name}</h1>
            <span className={`badge ${published ? 'badge-success' : ''}`}>{published ? 'Published' : 'Draft'}</span>
          </div>
          <p className={styles.sub}>
            ID <code>{exp.id}</code> · created {formatDate(exp.createdAt)} · updated {formatDate(exp.updatedAt)}
          </p>
        </div>
      </header>

      <div className={styles.manageGrid}>
        <div className={styles.manageMain}>
          {source === null ? null : readOnly ? (
            <>
              <ReadOnlyNotice />
              <ExperienceSummary experience={exp} />
            </>
          ) : (
          <ExperienceForm
            key={formKey}
            mode="edit"
            initial={exp}
            onSaved={(saved) => {
              setState((s) => ({ ...s, experience: saved }));
              setFormKey((k) => k + 1);
              toast.success('Changes saved');
            }}
          />
          )}
        </div>

        <aside className={styles.manageAside}>
          <QRPanel experience={exp} />
          {!readOnly && (
            <>

          <section className={`card ${styles.sideCard}`}>
            <h2>Publication</h2>
            <p className="hint">
              {published
                ? 'Anyone with the link or QR code can open this experience.'
                : 'Only admins can see this experience. The public link shows “not published”.'}
            </p>
            <button className={`btn ${published ? 'btn-secondary' : 'btn-primary'}`} onClick={toggleStatus} disabled={busy}>
              <Icon name={published ? 'lock' : 'globe'} />
              {published ? 'Unpublish' : 'Publish'}
            </button>
          </section>

          <section className={`card ${styles.sideCard}`}>
            <h2>Danger zone</h2>
            <p className="hint">Deleting removes the experience and all uploaded files.</p>
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              <Icon name="trash" /> Delete experience
            </button>
          </section>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
