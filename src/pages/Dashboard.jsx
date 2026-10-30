import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/common/Icon.jsx';
import StateView from '../components/common/StateView.jsx';
import ExperienceCard from '../components/admin/ExperienceCard.jsx';
import { AUTH_UPDATED_EVENT } from '../components/admin/AdminAuthGate.jsx';
import ReadOnlyNotice from '../components/admin/ReadOnlyNotice.jsx';
import QRPanel from '../components/qr/QRPanel.jsx';
import { useDataSource } from '../hooks/useDataSource.js';
import { listExperiences } from '../services/experienceService.js';
import { assetUrl, buildGalleryUrl, classifyUrl, getPublicBaseUrl } from '../utils/url.js';
import styles from './AdminPages.module.css';

export default function Dashboard() {
  const [state, setState] = useState({ loading: true, error: null, items: [] });
  const urlInfo = classifyUrl(getPublicBaseUrl());
  const source = useDataSource();

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    listExperiences()
      .then((items) => setState({ loading: false, error: null, items }))
      .catch((error) => setState({ loading: false, error, items: [] }));
  }, []);

  useEffect(() => {
    document.title = 'Experiences · WebAR Studio';
    load();
    window.addEventListener(AUTH_UPDATED_EVENT, load);
    return () => window.removeEventListener(AUTH_UPDATED_EVENT, load);
  }, [load]);

  const publishedItems = state.items.filter((e) => e.status === 'published');
  const published = publishedItems.length;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Experiences</h1>
          <p className={styles.sub}>Create image-tracked AR experiences and share them with a QR code.</p>
        </div>
        {source === 'api' && (
          <Link to="/admin/experiences/new" className="btn btn-primary">
            <Icon name="plus" /> New experience
          </Link>
        )}
      </header>

      {source === 'static' && <ReadOnlyNotice />}

      {urlInfo.kind !== 'production' && (
        <div className={`alert ${urlInfo.kind === 'lan' ? 'alert-warning' : 'alert-danger'} ${styles.banner}`}>
          <Icon name="alert" />
          <div>
            <strong>QR codes currently use {getPublicBaseUrl()}</strong>
            {urlInfo.message}
          </div>
        </div>
      )}

      <div className={styles.stats}>
        <div className={`card ${styles.stat}`}>
          <span>Total experiences</span>
          <strong>{state.loading ? '—' : state.items.length}</strong>
        </div>
        <div className={`card ${styles.stat}`}>
          <span>Published</span>
          <strong>{state.loading ? '—' : published}</strong>
        </div>
        <div className={`card ${styles.stat}`}>
          <span>Drafts</span>
          <strong>{state.loading ? '—' : state.items.length - published}</strong>
        </div>
      </div>

      {state.loading ? (
        <div className={styles.grid} aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`card ${styles.skeletonCard}`}>
              <div className="skeleton" style={{ aspectRatio: '16/10', borderRadius: 0 }} />
              <div className="skeleton" style={{ height: 16, margin: '16px 16px 8px', width: '60%' }} />
              <div className="skeleton" style={{ height: 12, margin: '0 16px 16px', width: '40%' }} />
            </div>
          ))}
        </div>
      ) : state.error ? (
        <div className="card">
          <StateView
            icon="alert"
            tone="danger"
            title="Could not load experiences"
            action={
              <button className="btn btn-secondary" onClick={load}>
                <Icon name="refresh" /> Retry
              </button>
            }
          >
            {state.error.message}
            {state.error.status === 0 && ' Is the API server running (npm run dev)?'}
          </StateView>
        </div>
      ) : state.items.length === 0 ? (
        <div className="card">
          <StateView
            icon="sparkle"
            tone="accent"
            title="No experiences yet"
            action={
              <Link to="/admin/experiences/new" className="btn btn-primary">
                <Icon name="plus" /> Create your first experience
              </Link>
            }
          >
            Upload a poster or product image, attach a video, image or 3D model, and get a QR code that opens the AR
            experience on any modern phone.
          </StateView>
        </div>
      ) : (
        <>
          {published > 1 && (
            <section className={styles.gallery} aria-labelledby="gallery-title">
              <div className={styles.galleryCopy}>
                <h2 id="gallery-title">
                  <Icon name="sparkle" size={18} /> Gallery: one QR code for every artwork
                </h2>
                <p>
                  Visitors scan this code once, then point the camera at any published artwork. Each one plays its
                  own AR content, like a museum audio guide. Put it at the entrance or beside the artworks.
                </p>
                <ul className={styles.galleryThumbs}>
                  {publishedItems.map((e) => (
                    <li key={e.id} title={e.name}>
                      <img src={assetUrl(e.target.imageUrl)} alt={e.name} loading="lazy" />
                    </li>
                  ))}
                </ul>
              </div>
              <QRPanel url={buildGalleryUrl()} name="AR Gallery" title="Gallery QR code" />
            </section>
          )}
          <div className={styles.grid}>
            {state.items.map((exp) => (
              <ExperienceCard key={exp.id} experience={exp} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
