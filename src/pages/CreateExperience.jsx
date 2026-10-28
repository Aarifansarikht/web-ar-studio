import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from '../components/common/Icon.jsx';
import { useToast } from '../components/common/Toast.jsx';
import ExperienceForm from '../components/admin/ExperienceForm.jsx';
import styles from './AdminPages.module.css';

export default function CreateExperience() {
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    document.title = 'New experience · WebAR Studio';
  }, []);

  return (
    <div className={`${styles.page} ${styles.narrow}`}>
      <header className={styles.header}>
        <div>
          <Link to="/admin" className={styles.back}>
            <Icon name="arrowLeft" size={16} /> Experiences
          </Link>
          <h1>New experience</h1>
          <p className={styles.sub}>Upload a target image, attach AR content, and publish to get a QR code.</p>
        </div>
      </header>
      <ExperienceForm
        mode="create"
        onSaved={(exp) => {
          toast.success('Experience created — your QR code is ready');
          navigate(`/admin/experiences/${exp.id}`);
        }}
      />
    </div>
  );
}
