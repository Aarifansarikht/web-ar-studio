import { useState } from 'react';
import Icon from '../common/Icon.jsx';
import FileDrop from '../common/FileDrop.jsx';
import { useToast } from '../common/Toast.jsx';
import TargetImageField from './TargetImageField.jsx';
import ContentField from './ContentField.jsx';
import PlacementControls from './PlacementControls.jsx';
import PlacementPreview from './PlacementPreview.jsx';
import HotspotEditor from './HotspotEditor.jsx';
import { useObjectUrl } from '../../hooks/useObjectUrl.js';
import {
  createEmptyDraft,
  createExperience,
  updateExperience,
} from '../../services/experienceService.js';
import { assetUrl } from '../../utils/url.js';
import styles from './ExperienceForm.module.css';

const LOGO_ACCEPT = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';

function toDraft(exp) {
  if (!exp) return createEmptyDraft();
  const base = createEmptyDraft();
  return {
    ...base,
    name: exp.name,
    description: exp.description ?? '',
    status: exp.status,
    brand: { ...base.brand, ...exp.brand, removeLogo: false },
    target: { ...base.target, ...exp.target },
    content: { ...base.content, ...exp.content },
    placement: { ...base.placement, ...exp.placement },
    hotspots: exp.hotspots ?? [],
  };
}

function Section({ step, title, description, children, aside }) {
  return (
    <section className={`card ${styles.section}`}>
      <header className={styles.sectionHead}>
        <span className={styles.step}>{step}</span>
        <div>
          <h2>{title}</h2>
          {description && <p className="hint">{description}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

/**
 * Create / edit form for an AR experience.
 * @param {{ mode: 'create'|'edit', initial?: object, onSaved: (exp: object) => void }} props
 */
export default function ExperienceForm({ mode, initial = null, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState(() => toDraft(initial));
  const [target, setTarget] = useState(null); // freshly compiled target (this session)
  const [contentFile, setContentFile] = useState(null);
  const [logoFile, setLogoFile] = useState(null);
  const [coverFile, setCoverFile] = useState(null);
  const [compiling, setCompiling] = useState(false);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const targetPreviewUrl = useObjectUrl(target?.file) ?? assetUrl(draft.target.imageUrl);
  const contentObjectUrl = useObjectUrl(contentFile);
  const logoObjectUrl = useObjectUrl(logoFile);
  const savedContentMatches = initial && initial.content.type === draft.content.type;
  const contentUrl = contentObjectUrl ?? (savedContentMatches ? assetUrl(initial.content.url) : null);
  const logoUrl = logoObjectUrl ?? (draft.brand.removeLogo ? null : assetUrl(draft.brand.logoUrl));
  const coverObjectUrl = useObjectUrl(coverFile);
  const coverUrl = coverObjectUrl ?? (draft.brand.removeCover ? null : assetUrl(draft.brand.coverUrl));
  const targetAspect = draft.target.width && draft.target.height ? draft.target.height / draft.target.width : 0.75;

  const patch = (key, value) => setDraft((d) => ({ ...d, [key]: { ...d[key], ...value } }));
  const clearError = (key) => setErrors((e) => ({ ...e, [key]: undefined }));

  const onCompiled = (result) => {
    setTarget(result);
    clearError('target');
    setDraft((d) => ({
      ...d,
      target: {
        ...d.target,
        width: result.width,
        height: result.height,
        quality: result.quality,
        featureCount: result.featureCount,
      },
    }));
  };

  const onContentType = (change) => {
    if (change.type && change.type !== draft.content.type) setContentFile(null);
    patch('content', change);
    clearError('content');
  };

  const validate = () => {
    const next = {};
    if (!draft.name.trim()) next.name = 'Give the experience a name.';
    if (!target && !draft.target.mindUrl) next.target = 'Upload and compile a target image.';
    if (!contentFile && !savedContentMatches) next.content = 'Upload the AR content file.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (compiling) return;
    if (!validate()) {
      toast.error('Please fix the highlighted fields.');
      return;
    }
    setSaving(true);
    setUploadProgress(0);
    const files = {
      targetImage: target?.file,
      targetMind: target?.mindBlob,
      content: contentFile,
      logo: logoFile,
      cover: coverFile,
    };
    const payload = { ...draft, hotspots: draft.hotspots.map((h) => ({ ...h, label: h.label.trim() })) };
    // When editing, publication is controlled from the side panel; the server keeps the current status.
    if (mode === 'edit') delete payload.status;
    try {
      const saved =
        mode === 'create'
          ? await createExperience(payload, files, setUploadProgress)
          : await updateExperience(initial.id, payload, files, setUploadProgress);
      setTarget(null);
      setContentFile(null);
      setLogoFile(null);
      setCoverFile(null);
      setDraft(toDraft(saved));
      onSaved(saved);
    } catch (err) {
      toast.error(err.message || 'Saving failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <Section step="1" title="Details" description="Shown to visitors on the landing screen.">
        <div className="field">
          <label className="label" htmlFor="name">
            Experience name
          </label>
          <input
            id="name"
            className="input"
            value={draft.name}
            maxLength={80}
            placeholder="e.g. Spring poster campaign"
            aria-invalid={Boolean(errors.name)}
            onChange={(e) => {
              setDraft((d) => ({ ...d, name: e.target.value }));
              clearError('name');
            }}
          />
          {errors.name && <span className={styles.error}>{errors.name}</span>}
        </div>
        <div className="field">
          <label className="label" htmlFor="description">
            Description <span className="hint">(optional)</span>
          </label>
          <textarea
            id="description"
            className="textarea"
            value={draft.description}
            maxLength={400}
            placeholder="A short line explaining what visitors will see."
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </div>
        {mode === 'create' && (
        <div className="field">
          <span className="label">Visibility</span>
          <div className={styles.segmented} role="radiogroup" aria-label="Visibility">
            {[
              { v: 'published', label: 'Published', icon: 'globe' },
              { v: 'draft', label: 'Draft', icon: 'lock' },
            ].map((o) => (
              <button
                key={o.v}
                type="button"
                role="radio"
                aria-checked={draft.status === o.v}
                className={draft.status === o.v ? styles.segActive : undefined}
                onClick={() => setDraft((d) => ({ ...d, status: o.v }))}
              >
                <Icon name={o.icon} size={16} /> {o.label}
              </button>
            ))}
          </div>
        </div>
        )}
      </Section>

      <Section
        step="2"
        title="Target image"
        description="The poster, packaging or print that visitors point their camera at. It is compiled into MindAR tracking data."
      >
        <TargetImageField
          previewUrl={targetPreviewUrl}
          compiled={target}
          saved={draft.target}
          onCompiled={onCompiled}
          onBusyChange={setCompiling}
          error={errors.target}
        />
      </Section>

      <Section step="3" title="AR content" description="What appears anchored on the target once it is recognised.">
        <ContentField
          content={draft.content}
          file={contentFile}
          savedFileName={savedContentMatches ? initial.content.fileName : null}
          onChange={onContentType}
          onFile={(f) => {
            setContentFile(f);
            clearError('content');
          }}
          error={errors.content}
        />
      </Section>

      <Section
        step="4"
        title="Placement"
        description="Position the content relative to the target. Units are target widths (1.0 = full image width)."
      >
        <div className={styles.placementGrid}>
          <PlacementPreview
            targetUrl={targetPreviewUrl}
            targetAspect={targetAspect}
            content={draft.content}
            contentUrl={contentUrl}
            placement={draft.placement}
            hotspots={draft.hotspots}
            accentColor={draft.brand.accentColor}
          />
          <PlacementControls placement={draft.placement} onChange={(p) => patch('placement', p)} />
        </div>
      </Section>

      <Section
        step="5"
        title="Hotspots"
        description="Optional tappable markers on the target that reveal a label, e.g. product features."
      >
        <HotspotEditor
          imageUrl={targetPreviewUrl}
          hotspots={draft.hotspots}
          accentColor={draft.brand.accentColor}
          onChange={(hotspots) => setDraft((d) => ({ ...d, hotspots }))}
        />
      </Section>

      <Section step="6" title="Branding" description="Header shown on the loading screen and during AR.">
        <div className={styles.brandGrid}>
          <div className="field">
            <label className="label" htmlFor="brandName">
              Brand name
            </label>
            <input
              id="brandName"
              className="input"
              maxLength={40}
              value={draft.brand.name}
              placeholder="Shown when no logo is uploaded"
              onChange={(e) => patch('brand', { name: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="accent">
              Accent colour
            </label>
            <div className={styles.colorRow}>
              <input
                id="accent"
                type="color"
                value={draft.brand.accentColor}
                onChange={(e) => patch('brand', { accentColor: e.target.value })}
              />
              <code>{draft.brand.accentColor}</code>
            </div>
          </div>
        </div>
        <div className="field">
          <span className="label">Logo</span>
          {logoUrl ? (
            <div className={styles.logoRow}>
              <div className={styles.logoPreview}>
                <img src={logoUrl} alt="Logo preview" />
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setLogoFile(null);
                  patch('brand', { removeLogo: true });
                }}
              >
                <Icon name="trash" /> Remove
              </button>
            </div>
          ) : (
            <FileDrop
              compact
              accept={LOGO_ACCEPT}
              onFile={(f) => {
                setLogoFile(f);
                patch('brand', { removeLogo: false });
              }}
              title="Upload logo"
              hint="PNG with transparency, light-coloured for the dark header"
              icon="image"
            />
          )}
        </div>
        <div className="field">
          <span className="label">
            Splash image <span className="hint">(optional, defaults to the target image)</span>
          </span>
          {coverUrl ? (
            <div className={styles.logoRow}>
              <div className={styles.coverPreview}>
                <img src={coverUrl} alt="Splash image preview" />
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setCoverFile(null);
                  patch('brand', { removeCover: true });
                }}
              >
                <Icon name="trash" /> Remove
              </button>
            </div>
          ) : (
            <FileDrop
              compact
              accept={LOGO_ACCEPT}
              onFile={(f) => {
                setCoverFile(f);
                patch('brand', { removeCover: false });
              }}
              title="Upload splash image"
              hint="Portrait hero shown behind the preloading screen, e.g. a product close-up (1080×1920)"
              icon="image"
            />
          )}
        </div>
      </Section>

      <div className={styles.actionBar}>
        {saving && (
          <div className={styles.uploadStatus}>
            <span>{uploadProgress < 1 ? `Uploading… ${Math.round(uploadProgress * 100)}%` : 'Saving…'}</span>
            <div className="progress">
              <span style={{ width: `${uploadProgress * 100}%` }} />
            </div>
          </div>
        )}
        {compiling && <span className="hint">Waiting for target compilation…</span>}
        <button type="submit" className="btn btn-primary btn-lg" disabled={saving || compiling}>
          {saving ? <span className="spinner" /> : <Icon name="check" />}
          {mode === 'create' ? 'Create experience' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
