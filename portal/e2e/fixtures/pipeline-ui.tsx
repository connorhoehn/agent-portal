import '@connorhoehnslalom/ui-components/styles.css';
import '../../src/app.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router';
import { GatewayContext, type GatewayContextValue } from '@connorhoehnslalom/realtime-modules/client';
import { DensityProvider } from '@connorhoehnslalom/ui-components/shared';
import { SessionProvider } from '../../src/lib/auth';
import DefinitionsPage from '../../src/pages/pipelines/DefinitionsPage';
import RunsPage from '../../src/pages/pipelines/RunsPage';
import ApprovalsPage from '../../src/pages/pipelines/ApprovalsPage';
import ArtifactsPage from '../../src/pages/pipelines/ArtifactsPage';
import RunbooksPage from '../../src/pages/pipelines/RunbooksPage';
import QueuesPage from '../../src/pages/pipelines/QueuesPage';
import SourcesPage from '../../src/pages/pipelines/SourcesPage';
import ConfigurationPage from '../../src/pages/pipelines/ConfigurationPage';
import ActivityPage from '../../src/pages/pipelines/ActivityPage';
import RunDetailPage from '../../src/pages/pipelines/RunDetailPage';

const gateway = { connectionState: 'disconnected', sessionEpoch: 0, rest: null, send: () => {}, onMessage: () => () => {} } as unknown as GatewayContextValue;

createRoot(document.getElementById('root')!).render(<BrowserRouter><SessionProvider><GatewayContext.Provider value={gateway}><DensityProvider density="compact">
  <main style={{ padding: 16, minWidth: 0 }} data-tenant="pipelines"><Routes>
    <Route path="/pipelines/definitions" element={<DefinitionsPage />} />
    <Route path="/pipelines/runs" element={<RunsPage />} />
    <Route path="/pipelines/runs/:id" element={<RunDetailPage />} />
    <Route path="/pipelines/approvals" element={<ApprovalsPage />} />
    <Route path="/pipelines/artifacts" element={<ArtifactsPage />} />
    <Route path="/pipelines/runbooks" element={<RunbooksPage />} />
    <Route path="/pipelines/queues" element={<QueuesPage />} />
    <Route path="/pipelines/configuration" element={<ConfigurationPage />} />
    <Route path="/pipelines/activity" element={<ActivityPage />} />
    {(['agents', 'bots', 'commands'] as const).map(source => <Route key={source} path={'/pipelines/'+source} element={<SourcesPage source={source} />} />)}
  </Routes></main>
</DensityProvider></GatewayContext.Provider></SessionProvider></BrowserRouter>);
