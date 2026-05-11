import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { Layout } from './components/shell/Layout';

const AgentFlowPage = lazy(() => import('./pages/AgentFlowPage'));
const OrgGraphPage = lazy(() => import('./pages/OrgGraphPage'));
const ScoresPage = lazy(() => import('./pages/ScoresPage'));
const IngestPage = lazy(() => import('./pages/IngestPage'));
const ObservabilityPage = lazy(() => import('./pages/ObservabilityPage'));
const InvokePage = lazy(() => import('./pages/InvokePage'));
const CapabilitiesPage = lazy(() => import('./pages/CapabilitiesPage'));
const CodeInterpreterDemoPage = lazy(() => import('./pages/CodeInterpreterDemoPage'));
const ExplorePage = lazy(() => import('./pages/ExplorePage'));

function Loading() {
  return <div style={{ padding: 24, color: '#94a3b8' }}>Loading...</div>;
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/agents" replace />} />
        <Route path="agents" element={<Suspense fallback={<Loading />}><AgentFlowPage /></Suspense>} />
        <Route path="graph" element={<Suspense fallback={<Loading />}><OrgGraphPage /></Suspense>} />
        <Route path="search" element={<Navigate to="/invoke" replace />} />
        <Route path="invoke" element={<Suspense fallback={<Loading />}><InvokePage /></Suspense>} />
        <Route path="scores" element={<Suspense fallback={<Loading />}><ScoresPage /></Suspense>} />
        <Route path="ingest" element={<Suspense fallback={<Loading />}><IngestPage /></Suspense>} />
        <Route path="observability" element={<Suspense fallback={<Loading />}><ObservabilityPage /></Suspense>} />
        <Route path="capabilities" element={<Suspense fallback={<Loading />}><CapabilitiesPage /></Suspense>} />
        <Route path="code-interpreter" element={<Suspense fallback={<Loading />}><CodeInterpreterDemoPage /></Suspense>} />
        <Route path="explore" element={<Suspense fallback={<Loading />}><ExplorePage /></Suspense>} />
      </Route>
    </Routes>
  );
}
