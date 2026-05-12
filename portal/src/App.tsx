import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { Layout } from './components/shell/Layout';
import { RequireRole } from './lib/auth';

const AgentFlowPage = lazy(() => import('./pages/AgentFlowPage'));
const ScoresPage = lazy(() => import('./pages/ScoresPage'));
const InvokePage = lazy(() => import('./pages/InvokePage'));
const CodeInterpreterDemoPage = lazy(() => import('./pages/CodeInterpreterDemoPage'));
const ExplorePage = lazy(() => import('./pages/ExplorePage'));

// Ingest sub-pages
const IngestLayout = lazy(() => import('./pages/ingest/IngestLayout'));
const IngestSummaryPage = lazy(() => import('./pages/ingest/SummaryPage'));
const IngestCrawlPage = lazy(() => import('./pages/ingest/CrawlTargetsPage'));
const IngestHistoryPage = lazy(() => import('./pages/ingest/RunHistoryPage'));
const IngestSourcesPage = lazy(() => import('./pages/ingest/DataSourcesPage'));
const IngestStoragePage = lazy(() => import('./pages/ingest/StoragePage'));
const IngestSchedulesPage = lazy(() => import('./pages/ingest/SchedulesPage'));

// Capabilities sub-pages
const CapabilitiesLayout = lazy(() => import('./pages/capabilities/CapabilitiesLayout'));
const CapabilitiesSummaryPage = lazy(() => import('./pages/capabilities/SummaryPage'));
const CapabilitiesGuardrailsPage = lazy(() => import('./pages/capabilities/GuardrailsPage'));
const CapabilitiesCodeInterpreterPage = lazy(() => import('./pages/capabilities/CodeInterpreterPage'));
const CapabilitiesBrowserPage = lazy(() => import('./pages/capabilities/BrowserPage'));
const CapabilitiesMemoryPage = lazy(() => import('./pages/capabilities/MemoryPage'));

// Identity Management sub-pages (HRAdmin only)
const IdentityLayout = lazy(() => import('./pages/identity/IdentityLayout'));
const IdentityRolesPage = lazy(() => import('./pages/identity/RolesPage'));
const IdentityPoliciesPage = lazy(() => import('./pages/identity/PoliciesPage'));
const IdentitySchemaPage = lazy(() => import('./pages/identity/SchemaPage'));
const IdentityTestPage = lazy(() => import('./pages/identity/PolicyTestPage'));

// Observability sub-pages
const ObservabilityLayout = lazy(() => import('./pages/observability/ObservabilityLayout'));
const ObservabilitySummaryPage = lazy(() => import('./pages/observability/SummaryPage'));
const ObservabilityInvocationsPage = lazy(() => import('./pages/observability/InvocationsPage'));
const ObservabilityCapabilityEventsPage = lazy(() => import('./pages/observability/CapabilityEventsPage'));
const ObservabilityAgentMetricsPage = lazy(() => import('./pages/observability/AgentMetricsPage'));
const ObservabilitySessionsPage = lazy(() => import('./pages/observability/SessionsPage'));
const ObservabilityAuthzPage = lazy(() => import('./pages/observability/AuthzLogPage'));

function Loading() {
  return <div style={{ padding: 24, color: '#94a3b8' }}>Loading...</div>;
}

function Page({ element }: { element: React.ReactNode }) {
  return <Suspense fallback={<Loading />}>{element}</Suspense>;
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/agents" replace />} />
        <Route path="agents" element={<Page element={<AgentFlowPage />} />} />
        <Route path="graph" element={<Navigate to="/explore" replace />} />
        <Route path="search" element={<Navigate to="/invoke" replace />} />
        <Route path="invoke" element={<Page element={<InvokePage />} />} />
        <Route path="scores" element={<Page element={<ScoresPage />} />} />

        <Route path="ingest" element={
          <RequireRole roles={['hr-admin']} fallback={<Navigate to="/" replace />}>
            <Page element={<IngestLayout />} />
          </RequireRole>
        }>
          <Route index element={<Navigate to="summary" replace />} />
          <Route path="summary" element={<Page element={<IngestSummaryPage />} />} />
          <Route path="crawl" element={<Page element={<IngestCrawlPage />} />} />
          <Route path="history" element={<Page element={<IngestHistoryPage />} />} />
          <Route path="sources" element={<Page element={<IngestSourcesPage />} />} />
          <Route path="storage" element={<Page element={<IngestStoragePage />} />} />
          <Route path="schedules" element={<Page element={<IngestSchedulesPage />} />} />
        </Route>

        <Route path="observability" element={
          <RequireRole roles={['org-leader', 'hr-admin']} fallback={<Navigate to="/" replace />}>
            <Page element={<ObservabilityLayout />} />
          </RequireRole>
        }>
          <Route index element={<Navigate to="summary" replace />} />
          <Route path="summary" element={<Page element={<ObservabilitySummaryPage />} />} />
          <Route path="invocations" element={<Page element={<ObservabilityInvocationsPage />} />} />
          <Route path="capability-events" element={<Page element={<ObservabilityCapabilityEventsPage />} />} />
          <Route path="agents" element={<Page element={<ObservabilityAgentMetricsPage />} />} />
          <Route path="sessions" element={<Page element={<ObservabilitySessionsPage />} />} />
          <Route path="authz" element={<Page element={<ObservabilityAuthzPage />} />} />
        </Route>

        <Route path="capabilities" element={<Page element={<CapabilitiesLayout />} />}>
          <Route index element={<Navigate to="summary" replace />} />
          <Route path="summary" element={<Page element={<CapabilitiesSummaryPage />} />} />
          <Route path="guardrails" element={<Page element={<CapabilitiesGuardrailsPage />} />} />
          <Route path="code-interpreter" element={<Page element={<CapabilitiesCodeInterpreterPage />} />} />
          <Route path="browser" element={<Page element={<CapabilitiesBrowserPage />} />} />
          <Route path="memory" element={<Page element={<CapabilitiesMemoryPage />} />} />
        </Route>

        <Route path="identity" element={
          <RequireRole roles={['hr-admin']} fallback={<Navigate to="/" replace />}>
            <Page element={<IdentityLayout />} />
          </RequireRole>
        }>
          <Route index element={<Navigate to="roles" replace />} />
          <Route path="roles" element={<Page element={<IdentityRolesPage />} />} />
          <Route path="policies" element={<Page element={<IdentityPoliciesPage />} />} />
          <Route path="schema" element={<Page element={<IdentitySchemaPage />} />} />
          <Route path="test" element={<Page element={<IdentityTestPage />} />} />
        </Route>

        <Route path="code-interpreter" element={<Page element={<CodeInterpreterDemoPage />} />} />
        <Route path="explore" element={<Page element={<ExplorePage />} />} />
      </Route>
    </Routes>
  );
}
