import '../../src/app.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import QueuesPage from '../../src/pages/pipelines/QueuesPage';
createRoot(document.getElementById('root')!).render(<BrowserRouter><main style={{ padding: 24 }}><QueuesPage /></main></BrowserRouter>);
