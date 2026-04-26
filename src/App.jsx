import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Listen from './pages/Listen';
import { DEFAULT_ROOM } from './lib/localStore';

const HowItWorks = lazy(() => import('./pages/HowItWorks'));

const JABER_HOST_ROOM = {
  ...DEFAULT_ROOM,
  isHost: true,
};

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Listen />} />
      <Route path="/__jaber-room" element={<Listen forcedRoom={JABER_HOST_ROOM} />} />
      <Route
        path="/how-it-works"
        element={
          <Suspense fallback={<div className="min-h-screen bg-black" />}>
            <HowItWorks />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
