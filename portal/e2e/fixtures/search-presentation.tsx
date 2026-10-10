import '../../src/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router';
import { SidePaneProvider } from '@connorhoehnslalom/ui-components';
import { SessionProvider } from '../../src/lib/auth';
import SearchPage from '../../src/pages/search/SearchPage';

document.documentElement.dataset.tenant = 'orgiq';
if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
function Fixture() {
  const here = useLocation();
  return <div className="h-screen min-w-0"><output className="sr-only" data-testid="fixture-route">{here.pathname + here.search}</output><SearchPage /></div>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><SessionProvider><SidePaneProvider><Fixture /></SidePaneProvider></SessionProvider></BrowserRouter></StrictMode>);
