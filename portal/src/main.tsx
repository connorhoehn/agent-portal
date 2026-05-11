import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import '@connorhoehnslalom/ui-components/styles.css';
import { App } from './App';
import './app.css';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
