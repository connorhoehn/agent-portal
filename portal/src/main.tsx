import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ThemeProvider } from '@connorhoehn/ui-components';
import '@connorhoehn/ui-components/styles.css';
import { App } from './App';
import './app.css';

createRoot(document.getElementById('root')!).render(
  <ThemeProvider preset="light">
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </ThemeProvider>
);
