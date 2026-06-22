import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { Layout } from './components/shell/Layout';
import { RequireRole } from './lib/auth';
import { useSession } from './lib/auth';
import { GatewaySocketProvider } from '@connorhoehnslalom/realtime-modules/client/ws';

const AgentFlowPage = lazy(() => import('./pages/AgentFlowPage'));
const ScoresPage = lazy(() => import('./pages/ScoresPage'));
const ScoresCohortPage = lazy(() => import('./pages/ScoresCohortPage'));
const ScoresComparePage = lazy(() => import('./pages/ScoresComparePage'));
const DecisionsPage = lazy(() => import('./pages/DecisionsPage'));
const DecisionDetailPage = lazy(() => import('./pages/DecisionDetailPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetailPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const NewsroomLayout = lazy(() => import('./pages/newsroom/NewsroomLayout'));
const IqLayout = lazy(() => import('./pages/iq/IqLayout'));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const NewsroomHomePage = lazy(() => import('./pages/newsroom/HomePage'));
const NewsroomArticlesPage = lazy(() => import('./pages/newsroom/ArticlesPage'));
const NewsroomArticleDetailPage = lazy(() => import('./pages/newsroom/ArticleDetailPage'));
const NewsroomEntityDetailPage = lazy(() => import('./pages/newsroom/EntityDetailPage'));
const NewsroomBeatsPage = lazy(() => import('./pages/newsroom/BeatsPage'));
const NewsroomResearcherPage = lazy(() => import('./pages/newsroom/ResearcherPage'));
const NewsroomBriefsPage = lazy(() => import('./pages/newsroom/BriefsPage'));
const NewsroomHeadlinesPage = lazy(() => import('./pages/newsroom/HeadlinesPage'));
const KnowledgeBasePage = lazy(() => import('./pages/KnowledgeBasePage'));
const KBRegistryPage = lazy(() => import('./pages/admin/KBRegistryPage.js'));
const KBDetailPage = lazy(() => import('./pages/admin/KBDetailPage.js'));
const InvokePage = lazy(() => import('./pages/InvokePage'));
const CodeInterpreterDemoPage = lazy(() => import('./pages/CodeInterpreterDemoPage'));
const ExplorePage = lazy(() => import('./pages/ExplorePage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const CanaryPage = lazy(() => import('./pages/CanaryPage'));
const PromptStudioPage = lazy(() => import('./pages/capabilities/PromptsPage'));
const PromptHistoryPage = lazy(() => import('./pages/iq/PromptHistoryPage'));
const DiffPage = lazy(() => import('./pages/iq/DiffPage'));
const EvaluationsPage = lazy(() => import('./pages/iq/EvaluationsPage'));

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
const CapabilitiesPromptsPage = lazy(() => import('./pages/capabilities/PromptsPage'));
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
const ObservabilityInvocationSearchPage = lazy(() => import('./pages/observability/InvocationSearchPage'));
const ObservabilityInvocationDetailPage = lazy(() => import('./pages/observability/InvocationDetailPage'));
const ObservabilityCapabilityEventsPage = lazy(() => import('./pages/observability/CapabilityEventsPage'));
const ObservabilityAgentMetricsPage = lazy(() => import('./pages/observability/AgentMetricsPage'));
const ObservabilitySessionsPage = lazy(() => import('./pages/observability/SessionsPage'));
const ObservabilityAuthzPage = lazy(() => import('./pages/observability/AuthzLogPage'));
const ObservabilityDriftPage = lazy(() => import('./pages/observability/DriftPage'));
const ObservabilityOnCallPage = lazy(() => import('./pages/observability/OnCallPage'));
const ObservabilityQualityPage = lazy(() => import('./pages/observability/QualityPage'));
const ObservabilityCostPage = lazy(() => import('./pages/observability/CostPage'));
const ObservabilityCalibrationPage = lazy(() => import('./pages/observability/CalibrationPage'));
const ObservabilityModelComparePage = lazy(() => import('./pages/observability/ModelComparePage'));
const ObservabilityMemoryPage = lazy(() => import('./pages/observability/MemoryPage'));
const ObservabilityGuardrailRulesPage = lazy(() => import('./pages/observability/GuardrailRulesPage'));
const ObservabilityTrafficPage = lazy(() => import('./pages/observability/TrafficPage'));
const ObservabilityApprovalsPage = lazy(() => import('./pages/observability/ApprovalQueuePage'));
const ObservabilityHarnessLayout = lazy(() => import('./pages/observability/harness/HarnessLayout'));
const ObservabilityHarnessHomePage = lazy(() => import('./pages/observability/harness/HarnessHomePage'));
const ObservabilityHarnessRunDetailPage = lazy(() => import('./pages/observability/harness/RunDetailPage'));
const ObservabilityHarnessCompareRunsPage = lazy(() => import('./pages/observability/harness/CompareRunsPage'));

// ---------------------------------------------------------------------------
// Gateway WS URL — http(s)://host → ws(s)://host/ws
// ---------------------------------------------------------------------------

const _RAW_GATEWAY_URL: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_GATEWAY_URL ?? 'http://localhost:8080';

const GATEWAY_WS_URL = _RAW_GATEWAY_URL
  .replace(/^https:\/\//i, 'wss://')
  .replace(/^http:\/\//i, 'ws://')
  .replace(/\/$/, '') + '/ws';

// ---------------------------------------------------------------------------

function Loading() {
  return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading...</div>;
}

function Page({ element }: { element: React.ReactNode }) {
  return <Suspense fallback={<Loading />}>{element}</Suspense>;
}

function RootRedirect() {
  const { session, isLoading } = useSession();
  if (isLoading) return null;
  return <Navigate to={session?.tenant === 'newsroom' ? '/newsroom/home' : '/iq/agents'} replace />;
}

export function App() {
  return (
    <GatewaySocketProvider url={GATEWAY_WS_URL}>
    <Routes>
      {/* ── Backwards-compat redirects (outside Layout so they catch bare paths) ── */}
      <Route path="agents" element={<Navigate to="/iq/agents" replace />} />
      <Route path="search" element={<Navigate to="/iq/invoke" replace />} />
      <Route path="invoke" element={<Navigate to="/iq/invoke" replace />} />
      <Route path="scores" element={<Navigate to="/iq/scores" replace />} />
      <Route path="scores/cohorts" element={<Navigate to="/iq/scores/cohorts" replace />} />
      <Route path="scores/compare" element={<Navigate to="/iq/scores/compare" replace />} />
      <Route path="decisions" element={<Navigate to="/iq/projects" replace />} />
      <Route path="decisions/:id" element={<Navigate to="/iq/projects" replace />} />
      <Route path="projects" element={<Navigate to="/iq/projects" replace />} />
      <Route path="projects/:id" element={<Navigate to="/iq/projects" replace />} />
      <Route path="explore" element={<Navigate to="/iq/explore" replace />} />
      <Route path="graph" element={<Navigate to="/iq/explore" replace />} />
      <Route path="code-interpreter" element={<Navigate to="/iq/code-interpreter" replace />} />
      <Route path="knowledge-base" element={<Navigate to="/admin/knowledge-bases" replace />} />
      <Route path="observability/*" element={<Navigate to="/admin/observability" replace />} />
      <Route path="ingest/*" element={<Navigate to="/admin/ingest" replace />} />
      <Route path="capabilities/*" element={<Navigate to="/admin/capabilities" replace />} />
      <Route path="identity/*" element={<Navigate to="/admin/identity" replace />} />

      <Route element={<Layout />}>
        <Route index element={<RootRedirect />} />
        <Route path="settings" element={<Page element={<SettingsPage />} />} />

        {/* ── /newsroom/* — Newsroom tenant (unchanged) ── */}
        <Route path="newsroom" element={<Page element={<NewsroomLayout />} />}>
          <Route index element={<Navigate to="home" replace />} />
          <Route path="home" element={<Page element={<NewsroomHomePage />} />} />
          <Route path="articles" element={<Page element={<NewsroomArticlesPage />} />} />
          <Route path="articles/:id" element={<Page element={<NewsroomArticleDetailPage />} />} />
          <Route path="entities/:id" element={<Page element={<NewsroomEntityDetailPage />} />} />
          <Route path="beats" element={<Page element={<NewsroomBeatsPage />} />} />
          <Route path="researcher" element={<Page element={<NewsroomResearcherPage />} />} />
          <Route path="briefs" element={<Page element={<NewsroomBriefsPage />} />} />
          <Route path="headlines" element={<Page element={<NewsroomHeadlinesPage />} />} />
        </Route>

        {/* ── /iq/* — OrgIQ tenant pages ── */}
        <Route path="iq" element={<Page element={<IqLayout />} />}>
          <Route index element={<Navigate to="agents" replace />} />
          <Route path="agents" element={<Page element={<AgentFlowPage />} />} />
          <Route path="search" element={<Navigate to="/iq/invoke" replace />} />
          <Route path="invoke" element={<Page element={<InvokePage />} />} />
          <Route path="scores" element={<Page element={<ScoresPage />} />} />
          <Route path="scores/cohorts" element={<Page element={<ScoresCohortPage />} />} />
          <Route path="scores/compare" element={<Page element={<ScoresComparePage />} />} />
          <Route path="decisions" element={<Navigate to="/iq/projects" replace />} />
          <Route path="decisions/:id" element={<Navigate to="/iq/projects" replace />} />
          <Route path="projects" element={<Page element={<ProjectsPage />} />} />
          <Route path="projects/:id" element={<Page element={<ProjectDetailPage />} />} />
          <Route path="explore" element={<Page element={<ExplorePage />} />} />
          <Route path="code-interpreter" element={<Page element={<CodeInterpreterDemoPage />} />} />
          <Route path="canary" element={<Page element={<CanaryPage />} />} />
          <Route path="prompts" element={<Page element={<PromptStudioPage />} />} />
          <Route path="history" element={<Page element={<PromptHistoryPage />} />} />
          <Route path="diff" element={<Page element={<DiffPage />} />} />
          <Route path="evaluations" element={<Page element={<EvaluationsPage />} />} />
        </Route>

        {/* ── /admin/* — Admin / operations pages ── */}
        <Route path="admin" element={<Page element={<AdminLayout />} />}>
          <Route index element={<Navigate to="observability" replace />} />
          <Route path="knowledge-bases" element={<Page element={<KBRegistryPage />} />} />
          <Route path="knowledge-bases/:id" element={<Page element={<KBDetailPage />} />} />
          <Route path="knowledge-base" element={<Navigate to="/admin/knowledge-bases" replace />} />

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
            <Route path="oncall" element={<Page element={<ObservabilityOnCallPage />} />} />
            <Route path="summary" element={<Page element={<ObservabilitySummaryPage />} />} />
            <Route path="invocations" element={<Page element={<ObservabilityInvocationsPage />} />} />
            <Route path="invocations/search" element={<Page element={<ObservabilityInvocationSearchPage />} />} />
            <Route path="invocations/:invocationId" element={<Page element={<ObservabilityInvocationDetailPage />} />} />
            <Route path="capability-events" element={<Page element={<ObservabilityCapabilityEventsPage />} />} />
            <Route path="agents" element={<Page element={<ObservabilityAgentMetricsPage />} />} />
            <Route path="sessions" element={<Page element={<ObservabilitySessionsPage />} />} />
            <Route path="authz" element={<Page element={<ObservabilityAuthzPage />} />} />
            <Route path="drift" element={<Page element={<ObservabilityDriftPage />} />} />
            <Route path="quality" element={<Page element={<ObservabilityQualityPage />} />} />
            <Route path="cost" element={<Page element={<ObservabilityCostPage />} />} />
            <Route path="calibration" element={<Page element={<ObservabilityCalibrationPage />} />} />
            <Route path="model-compare" element={<Page element={<ObservabilityModelComparePage />} />} />
            <Route path="memory" element={<Page element={<ObservabilityMemoryPage />} />} />
            <Route path="guardrail-rules" element={<Page element={<ObservabilityGuardrailRulesPage />} />} />
            <Route path="traffic" element={<Page element={<ObservabilityTrafficPage />} />} />
            <Route path="approvals" element={<Page element={<ObservabilityApprovalsPage />} />} />
            <Route path="harness" element={<Page element={<ObservabilityHarnessLayout />} />}>
              <Route index element={<Page element={<ObservabilityHarnessHomePage />} />} />
              <Route path="runs/:runId" element={<Page element={<ObservabilityHarnessRunDetailPage />} />} />
              <Route path="compare/:runIdA/:runIdB" element={<Page element={<ObservabilityHarnessCompareRunsPage />} />} />
            </Route>
          </Route>

          <Route path="capabilities" element={<Page element={<CapabilitiesLayout />} />}>
            <Route index element={<Navigate to="summary" replace />} />
            <Route path="summary" element={<Page element={<CapabilitiesSummaryPage />} />} />
            <Route path="guardrails" element={<Page element={<CapabilitiesGuardrailsPage />} />} />
            <Route path="prompts" element={<Page element={<CapabilitiesPromptsPage />} />} />
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
        </Route>
      </Route>
    </Routes>
    </GatewaySocketProvider>
  );
}
