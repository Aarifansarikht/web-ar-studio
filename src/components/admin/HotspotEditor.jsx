import { useRef } from 'react';
import Icon from '../common/Icon.jsx';
import styles from './ExperienceForm.module.css';

const MAX_HOTSPOTS = 20;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * Click on the target image to add a tappable hotspot; drag markers to move.
 * Coordinates are stored normalised (0..1) from the image's top-left corner.
 */
export default function HotspotEditor({ imageUrl, hotspots, onChange, accentColor }) {
  const surfaceRef = useRef(null);
  const dragRef = useRef(null);

  const toNormalized = (e) => {
    const rect = surfaceRef.current.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    };
  };

  const add = (e) => {
    if (dragRef.current?.moved || hotspots.length >= MAX_HOTSPOTS) return;
    const { x, y } = toNormalized(e);
    onChange([...hotspots, { id: newId(), label: `Feature ${hotspots.length + 1}`, x, y }]);
  };

  const update = (id, patch) => onChange(hotspots.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  const remove = (id) => onChange(hotspots.filter((h) => h.id !== id));

  const startDrag = (e, id) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id, moved: false };
  };
  const moveDrag = (e) => {
    if (!dragRef.current) return;
    dragRef.current.moved = true;
    update(dragRef.current.id, toNormalized(e));
  };
  const endDrag = (e) => {
    e.stopPropagation();
    // Keep `moved` until the click event that follows pointerup has been ignored.
    setTimeout(() => (dragRef.current = null), 0);
  };

  if (!imageUrl) {
    return <p className="hint">Upload a target image first, then click on it to place hotspots.</p>;
  }

  return (
    <div className={styles.hotspotEditor} style={{ '--hs-accent': accentColor }}>
      <div className={styles.hotspotSurface} ref={surfaceRef} onClick={add}>
        <img src={imageUrl} alt="Target — click to add a hotspot" draggable={false} />
        {hotspots.map((h, i) => (
          <button
            key={h.id}
            type="button"
            className={styles.hotspotDot}
            style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%` }}
            onPointerDown={(e) => startDrag(e, h.id)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Hotspot ${i + 1}: ${h.label}. Drag to move.`}
          >
            {i + 1}
          </button>
        ))}
      </div>
      <p className="hint">
        Click the image to add a hotspot ({hotspots.length}/{MAX_HOTSPOTS}). Drag numbers to reposition. Visitors tap the
        pulsing dots to reveal labels.
      </p>
      {hotspots.length > 0 && (
        <ol className={styles.hotspotList}>
          {hotspots.map((h, i) => (
            <li key={h.id}>
              <span className={styles.hotspotIndex}>{i + 1}</span>
              <input
                className="input"
                value={h.label}
                maxLength={40}
                onChange={(e) => update(h.id, { label: e.target.value })}
                aria-label={`Label for hotspot ${i + 1}`}
              />
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => remove(h.id)}
                aria-label={`Remove hotspot ${i + 1}`}
              >
                <Icon name="trash" />
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
