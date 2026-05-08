import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { Layout } from './components/shell/Layout';

const AgentFlowPage = lazy(() => import('./pages/AgentFlowPage'));
const OrgGraphPage = lazy(() => import('./pages/OrgGraphPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const ScoresPage = lazy(() => import('./pages/ScoresPage'));
const IngestPage = lazy(() => import('./pages/IngestPage'));
const ObservabilityPage = lazy(() => import('./pages/ObservabilityPage'));
const InvokePage = lazy(() => import('./pages/InvokePage'));

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
        <Route path="search" element={<Suspense fallback={<Loading />}><SearchPage /></Suspense>} />
        <Route path="invoke" element={<Suspense fallback={<Loading />}><InvokePage /></Suspense>} />
        <Route path="scores" element={<Suspense fallback={<Loading />}><ScoresPage /></Suspense>} />
        <Route path="ingest" element={<Suspense fallback={<Loading />}><IngestPage /></Suspense>} />
        <Route path="observability" element={<Suspense fallback={<Loading />}><ObservabilityPage /></Suspense>} />
      </Route>
    </Routes>
  );
}
