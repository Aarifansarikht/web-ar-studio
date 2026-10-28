import { DEFAULT_PLACEMENT } from '../../services/experienceService.js';
import Icon from '../common/Icon.jsx';
import styles from './ExperienceForm.module.css';

const CONTROLS = [
  { key: 'scale', label: 'Scale', min: 0.1, max: 3, step: 0.01, unit: '×' },
  { key: 'offsetX', label: 'Offset X', min: -1, max: 1, step: 0.01 },
  { key: 'offsetY', label: 'Offset Y', min: -1, max: 1, step: 0.01 },
  { key: 'offsetZ', label: 'Offset Z (depth)', min: -0.5, max: 1.5, step: 0.01 },
  { key: 'rotationX', label: 'Rotate X', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'rotationY', label: 'Rotate Y', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'rotationZ', label: 'Rotate Z', min: -180, max: 180, step: 1, unit: '°' },
];

/** Offsets are in target widths: 1.0 = the full width of the target image. */
export default function PlacementControls({ placement, onChange }) {
  return (
    <div className={styles.placement}>
      {CONTROLS.map((c) => (
        <div key={c.key} className={styles.slider}>
          <label htmlFor={`pl-${c.key}`}>{c.label}</label>
          <input
            id={`pl-${c.key}`}
            type="range"
            min={c.min}
            max={c.max}
            step={c.step}
            value={placement[c.key]}
            onChange={(e) => onChange({ [c.key]: Number(e.target.value) })}
          />
          <output htmlFor={`pl-${c.key}`}>
            {Number(placement[c.key]).toFixed(c.step < 1 ? 2 : 0)}
            {c.unit ?? ''}
          </output>
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ ...DEFAULT_PLACEMENT })}>
        <Icon name="refresh" /> Reset placement
      </button>
    </div>
  );
}
