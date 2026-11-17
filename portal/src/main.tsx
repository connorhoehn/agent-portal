import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import '@connorhoehn/ui-components/styles.css';
import { DensityProvider, ToastProvider } from '@connorhoehn/ui-components/shared';
import { App } from './App';
import { SessionProvider } from './lib/auth';
import { initTheme } from './lib/preferences';
import './app.css';
import './animations.css';

// Day/night before first paint — a saved dark pref flashing light is a bug.
initTheme();

// The candidate's page (/join, row I2.1) is not part of the app: the person opening it is not a user. It mounts
// in place of the session provider and the app, so no session read, sign-in redirect, realtime socket or staff
// data hook runs for a guest (pages/JoinPage.tsx).
const JoinPage = lazy(() => import('./pages/JoinPage'));
const guest = window.location.pathname === '/join';

createRoot(document.getElementById('root')!).render(
  <DensityProvider density="compact">
    <ToastProvider>
      {guest ? (
        <Suspense fallback={null}><JoinPage /></Suspense>
      ) : (
      <BrowserRouter>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
      )}
    </ToastProvider>
  </DensityProvider>
);
