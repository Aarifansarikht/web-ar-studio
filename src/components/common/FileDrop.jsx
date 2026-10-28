import { useId, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import styles from './FileDrop.module.css';

/** Click-or-drop file picker. */
export default function FileDrop({ accept, onFile, disabled, title, hint, icon = 'upload', compact = false }) {
  const inputRef = useRef(null);
  const id = useId();
  const [over, setOver] = useState(false);

  const pick = (files) => {
    const file = files?.[0];
    if (file && !disabled) onFile(file);
  };

  return (
    <label
      htmlFor={id}
      className={`${styles.drop} ${over ? styles.over : ''} ${compact ? styles.compact : ''} ${disabled ? styles.disabled : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        pick(e.dataTransfer.files);
      }}
    >
      <input
        id={id}
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled}
        className="visually-hidden"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = '';
        }}
      />
      <span className={styles.icon}>
        <Icon name={icon} size={20} />
      </span>
      <span className={styles.text}>
        <strong>{title}</strong>
        {hint && <span>{hint}</span>}
      </span>
    </label>
  );
}
