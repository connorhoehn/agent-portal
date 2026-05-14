import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import '@connorhoehnslalom/ui-components/styles.css';
import { ToastProvider } from '@connorhoehnslalom/ui-components/shared';
import { App } from './App';
import { SessionProvider } from './lib/auth';
import './app.css';

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </ToastProvider>
);
