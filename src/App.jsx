import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AdminLayout from './components/admin/AdminLayout.jsx';
import StateView from './components/common/StateView.jsx';
import NotFound from './pages/NotFound.jsx';

// Admin and AR pages are split so visitors scanning a QR code never download
// the admin bundle, and admins only load the AR engine when compiling targets.
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const CreateExperience = lazy(() => import('./pages/CreateExperience.jsx'));
const ManageExperience = lazy(() => import('./pages/ManageExperience.jsx'));
const ARExperience = lazy(() => import('./pages/ARExperience.jsx'));

const adminFallback = <StateView loading title="Loading…" />;

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route
          index
          element={
            <Suspense fallback={adminFallback}>
              <Dashboard />
            </Suspense>
          }
        />
        <Route
          path="experiences/new"
          element={
            <Suspense fallback={adminFallback}>
              <CreateExperience />
            </Suspense>
          }
        />
        <Route
          path="experiences/:id"
          element={
            <Suspense fallback={adminFallback}>
              <ManageExperience />
            </Suspense>
          }
        />
      </Route>
      <Route
        path="/ar/:id"
        element={
          <Suspense fallback={<div style={{ position: 'fixed', inset: 0, background: '#07080b' }} />}>
            <ARExperience />
          </Suspense>
        }
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
