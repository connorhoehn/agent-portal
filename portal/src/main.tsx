import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import '@connorhoehnslalom/ui-components/styles.css';
import { ToastProvider } from '@connorhoehnslalom/ui-components/shared';
import { App } from './App';
import { SessionProvider } from './lib/auth';
import { initTheme } from './lib/preferences';
import './app.css';
import './animations.css';

// Day/night before first paint — a saved dark pref flashing light is a bug.
initTheme();

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </ToastProvider>
);
