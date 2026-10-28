import { Link } from 'react-router-dom';
import Icon from '../components/common/Icon.jsx';
import StateView from '../components/common/StateView.jsx';

export default function NotFound() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100%' }}>
      <StateView
        icon="alert"
        title="Page not found"
        action={
          <Link to="/admin" className="btn btn-primary">
            <Icon name="arrowLeft" /> Go to dashboard
          </Link>
        }
      >
        The page you are looking for does not exist.
      </StateView>
    </div>
  );
}
