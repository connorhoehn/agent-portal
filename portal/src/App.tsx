import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, Outlet, useParams } from 'react-router';
import { Layout } from './components/shell/Layout';
import { RequireRole } from './lib/auth';
import { useSession } from './lib/auth';
import { NEWSROOM_ENABLED } from './lib/features';
import { hasChosenContext } from './lib/contextChoice';
import { GatewaySocketProvider } from '@connorhoehnslalom/realtime-modules/client/ws';
import { ComputeHost } from './components/compute/ComputeHost';

const AgentFlowPage = lazy(() => import('./pages/AgentFlowPage'));
const AgentDetailPage = lazy(() => import('./pages/iq/AgentDetailPage'));
const ScoresPage = lazy(() => import('./pages/ScoresPage'));
const ScoresCohortPage = lazy(() => import('./pages/ScoresCohortPage'));
const ScoresComparePage = lazy(() => import('./pages/ScoresComparePage'));
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
const NewsroomPitchesPage = lazy(() => import('./pages/newsroom/PitchesPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const KnowledgeHomePage = lazy(() => import('./pages/knowledge/KnowledgeHomePage'));
const KnowledgeLayout = lazy(() => import('./pages/knowledge/KnowledgeLayout'));
const DropPage = lazy(() => import('./pages/DropPage'));
const SelectContextPage = lazy(() => import('./pages/SelectContextPage'));
const KBRegistryPage = lazy(() => import('./pages/admin/KBRegistryPage.js'));
const DevboxPage = lazy(() => import('./pages/admin/DevboxPage'));
const AgentProjectsPage = lazy(() => import('./pages/admin/AgentProjectsPage'));
const BotsPage = lazy(() => import('./pages/bots/BotsPage'));
const BudgetsPage = lazy(() => import('./pages/budgets/BudgetsPage'));
const SprintsPage = lazy(() => import('./pages/sprints/SprintsPage'));
const BotDetailPage = lazy(() => import('./pages/bots/BotDetailPage'));
const ChangesPage = lazy(() => import('./pages/admin/ChangesPage'));
const KBDetailPage = lazy(() => import('./pages/admin/KBDetailPage.js'));
const InvokePage = lazy(() => import('./pages/InvokePage'));
const ExplorePage = lazy(() => import('./pages/ExplorePage'));
const CanaryPage = lazy(() => import('./pages/CanaryPage'));
const PromptStudioPage = lazy(() => import('./pages/capabilities/PromptsPage'));
const PromptHistoryPage = lazy(() => import('./pages/iq/PromptHistoryPage'));
const PromptOpsHomePage = lazy(() => import('./pages/iq/PromptOpsHomePage'));
const WorkHomePage = lazy(() => import('./pages/work/WorkHomePage'));
const JobDetailPage = lazy(() => import('./pages/work/JobDetailPage'));
const GraphChangesPage = lazy(() => import('./pages/work/GraphChangesPage'));
const DiffPage = lazy(() => import('./pages/iq/DiffPage'));
const EvaluationsPage = lazy(() => import('./pages/iq/EvaluationsPage'));

// Ingest sub-pages
const IngestLayout = lazy(() => import('./pages/ingest/IngestLayout'));
const IngestCrawlPage = lazy(() => import('./pages/ingest/CrawlTargetsPage'));
const IngestHistoryPage = lazy(() => import('./pages/ingest/RunHistoryPage'));
const IngestSourcesPage = lazy(() => import('./pages/ingest/DataSourcesPage'));
const IngestStoragePage = lazy(() => import('./pages/ingest/StoragePage'));
const IngestSchedulesPage = lazy(() => import('./pages/ingest/SchedulesPage'));

// Capabilities sub-pages
const CapabilitiesHomePage = lazy(() => import('./pages/capabilities/CapabilitiesHomePage'));
const CapabilitiesGuardrailsPage = lazy(() => import('./pages/capabilities/GuardrailsPage'));
const CapabilitiesCodeInterpreterPage = lazy(() => import('./pages/capabilities/CodeInterpreterPage'));
const CapabilitiesBrowserPage = lazy(() => import('./pages/capabilities/BrowserPage'));

// Identity Management sub-pages (HRAdmin only)
const IdentityLayout = lazy(() => import('./pages/identity/IdentityLayout'));
const IdentityUsersPage = lazy(() => import('./pages/identity/UsersPage'));
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

function KbDetailRedirect() {
  const { id } = useParams();
  return <Navigate to={`/admin/knowledge/registry/${id ?? ''}`} replace />;
}

function RootRedirect() {
  const { session, isLoading } = useSession();
  if (isLoading) return null;
  // Count the workspaces (tenant, role) actually usable to this identity —
  // newsroom is dropped when the flag is off. A multi-context identity that
  // hasn't picked yet this session lands on the chooser first (AWS-style);
  // a single-context or already-chosen identity goes straight in. Masqueraders
  // skip the chooser — the operator deliberately chose who to view as.
  const usable = Object.entries(session?.grants ?? {})
    .filter(([t]) => NEWSROOM_ENABLED || t !== 'newsroom')
    .reduce((n, [, roles]) => n + (roles?.length ?? 0), 0);
  if (usable > 1 && !session?.masquerading && !hasChosenContext(session?.sub ?? '')) {
    return <Navigate to="/select" replace />;
  }
  const toNewsroom = session?.tenant === 'newsroom' && NEWSROOM_ENABLED;
  return <Navigate to={toNewsroom ? '/newsroom/home' : '/iq/work'} replace />;
}

export function App() {
  return (
    <GatewaySocketProvider url={GATEWAY_WS_URL}>
    {/* One fleet for the whole app. Above the router because a shell must
        survive navigation, and because the Computers page, the ⌘K palette, the
        ⌘I switcher and Codebases all have to agree about which computers
        exist — the localStorage mirror this replaces let them disagree. */}
    <ComputeHost>
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
      <Route path="code-interpreter" element={<Navigate to="/admin/capabilities/code-interpreter" replace />} />
      <Route path="knowledge-base" element={<Navigate to="/admin/knowledge" replace />} />
      <Route path="observability/*" element={<Navigate to="/admin/observability" replace />} />
      <Route path="ingest/*" element={<Navigate to="/admin/ingest" replace />} />
      <Route path="capabilities/*" element={<Navigate to="/admin/capabilities" replace />} />
      <Route path="identity/*" element={<Navigate to="/admin/identity" replace />} />

      {/* Share-link drop page — deliberately outside Layout. The person
          opening it has no account here, so showing them nav, a tenant
          switcher and a masquerade control would be both confusing and a
          small information leak about the org. */}
      <Route path="drop/:token" element={<Page element={<DropPage />} />} />

      {/* Workspace chooser — outside Layout: it's the pre-app "select account +
          role" step, shown once after login for multi-context identities. */}
      <Route path="select" element={<Page element={<SelectContextPage />} />} />

      <Route element={<Layout />}>
        <Route index element={<RootRedirect />} />
        <Route path="settings" element={<Page element={<SettingsPage />} />} />

        {/* ── /newsroom/* — the second tenant, the flagship multi-tenant demo
             surface. Feature-flagged ON by default (NEWSROOM_ENABLED); set
             VITE_ENABLE_NEWSROOM=false to park the route tree. ── */}
        {NEWSROOM_ENABLED ? (
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
            <Route path="pitches" element={<Page element={<NewsroomPitchesPage />} />} />
          </Route>
        ) : (
          <Route path="newsroom/*" element={<Navigate to="/" replace />} />
        )}

        {/* ── /iq/* — OrgIQ tenant pages ── */}
        <Route path="iq" element={<Page element={<IqLayout />} />}>
          <Route index element={<Navigate to="work" replace />} />
          {/* Architecture is a platform surface — nav shows it to platform
              roles only, so the route matches (it was URL-open to anyone). */}
          <Route path="agents" element={
            <RequireRole roles={['org-leader', 'hr-admin']} fallback={<Navigate to="/" replace />}>
              <Page element={<AgentFlowPage />} />
            </RequireRole>
          } />
          {/* One agent in depth. Architecture answers "what is the fleet";
              this answers "what is this one doing". */}
          <Route path="agents/:agentId" element={
            <RequireRole roles={['org-leader', 'hr-admin']} fallback={<Navigate to="/" replace />}>
              <Page element={<AgentDetailPage />} />
            </RequireRole>
          } />
          <Route path="search" element={<Navigate to="/iq/invoke" replace />} />
          <Route path="invoke" element={<Page element={<InvokePage />} />} />
          {/* Find Help folded into Ask — the chat is the org search. */}
          <Route path="help" element={<Navigate to="/iq/invoke" replace />} />
          <Route path="scores" element={<Page element={<ScoresPage />} />} />
          <Route path="scores/cohorts" element={<Page element={<ScoresCohortPage />} />} />
          <Route path="scores/compare" element={<Page element={<ScoresComparePage />} />} />
          <Route path="decisions" element={<Navigate to="/iq/projects" replace />} />
          <Route path="decisions/:id" element={<Navigate to="/iq/projects" replace />} />
          <Route path="projects" element={<Page element={<ProjectsPage />} />} />
          <Route path="projects/:id" element={<Page element={<ProjectDetailPage />} />} />
          {/* Sprints — the SME's own cadence. Deliberately NOT role-gated:
              this is a read surface every member and SME is meant to open, and
              the one privileged thing on it (the org-wide scope) is refused by
              /api/sprints itself rather than by hiding the route. It sits under
              /iq/* so it is orgiq-tenant scoped like the rest of the tree. */}
          <Route path="sprints" element={<Page element={<SprintsPage />} />} />
          <Route path="explore" element={<Page element={<ExplorePage />} />} />
          {/* The demo page duplicated /admin/capabilities/code-interpreter
              (same execute endpoint) and had no inbound link anywhere. */}
          <Route path="code-interpreter" element={<Navigate to="/admin/capabilities/code-interpreter" replace />} />
          <Route path="canary" element={<Page element={<CanaryPage />} />} />
          <Route path="prompt-ops" element={<Page element={<PromptOpsHomePage />} />} />
          <Route path="work" element={<Page element={<WorkHomePage />} />} />
          <Route path="work/changes" element={<Page element={<GraphChangesPage />} />} />
          <Route path="work/:jobId" element={<Page element={<JobDetailPage />} />} />
          <Route path="prompts" element={<Page element={<PromptStudioPage />} />} />
          <Route path="history" element={<Page element={<PromptHistoryPage />} />} />
          <Route path="diff" element={<Page element={<DiffPage />} />} />
          <Route path="evaluations" element={<Page element={<EvaluationsPage />} />} />
        </Route>

        {/* ── /admin/* — Admin / operations pages ── */}
        <Route path="admin" element={<Page element={<AdminLayout />} />}>
          <Route index element={<Navigate to="observability" replace />} />

          {/* Knowledge — one destination for "where the agents' knowledge comes
              from". The registry list and the ingest summary were two front
              doors to the same subject, neither of which said whether any of it
              was working; both now land here. The stage pages below stay as
              drill-ins, reached from the pipeline rather than from the nav. */}
          {/* Guarded to match the nav + backend: reading the registry is
              org-leader/hr-admin visibility. Without this the route rendered for
              any role and then showed a raw 403 from the hr-admin-only API. */}
          <Route path="knowledge" element={
            <RequireRole roles={['org-leader', 'hr-admin']} fallback={<Navigate to="/" replace />}>
              <Page element={<KnowledgeLayout />} />
            </RequireRole>
          }>
            <Route index element={<Page element={<KnowledgeHomePage />} />} />
            <Route path="registry" element={<Page element={<KBRegistryPage />} />} />
            {/* Detail lives under the Knowledge layout so it keeps the rail,
                and "back" can return to the registry list it came from. */}
            <Route path="registry/:id" element={<Page element={<KBDetailPage />} />} />
          </Route>
          <Route path="knowledge-bases" element={<Navigate to="/admin/knowledge/registry" replace />} />
          {/* Old detail URL — preserved for bookmarks and stale links. */}
          <Route path="knowledge-bases/:id" element={<KbDetailRedirect />} />
          <Route path="knowledge-base" element={<Navigate to="/admin/knowledge" replace />} />
          {/* Repositories agents work on — distinct from /iq/projects, which
              is the org graph's initiatives. A repo may deliver one of those;
              the two are joined, not merged. */}
          {/* These three are hr-admin action surfaces (link/run codebases, approve
              & deliver changes, drive devboxes) — their APIs require ManageDevbox,
              so the route is guarded to match, keeping the page out of a role that
              would only hit 403s. */}
          <Route path="projects" element={
            <RequireRole roles={['hr-admin']} fallback={<Navigate to="/" replace />}>
              <Page element={<AgentProjectsPage />} />
            </RequireRole>
          } />
          {/* Budgets — the program-manager's ledger: allocations vs. agent
              spend per initiative. Reads are platform-wide visibility
              (org-leader + hr-admin, like observability); writes are gated
              per-affordance on ManageBudgets inside the page. */}
          <Route path="budgets" element={
            <RequireRole roles={['org-leader', 'hr-admin']} fallback={<Navigate to="/" replace />}>
              <Page element={<BudgetsPage />} />
            </RequireRole>
          } />
          {/* Bots — durable, mission-configured agents. Same gate as the other
              Build action surfaces: their API is hr-admin territory. */}
          <Route path="bots" element={
            <RequireRole roles={['hr-admin']} fallback={<Navigate to="/" replace />}>
              <Page element={<BotsPage />} />
            </RequireRole>
          } />
          <Route path="bots/:id" element={
            <RequireRole roles={['hr-admin']} fallback={<Navigate to="/" replace />}>
              <Page element={<BotDetailPage />} />
            </RequireRole>
          } />
          {/* The governance queue for code agents wrote — review, approve, deliver. */}
          <Route path="changes" element={
            <RequireRole roles={['hr-admin']} fallback={<Navigate to="/" replace />}>
              <Page element={<ChangesPage />} />
            </RequireRole>
          } />
          {/* Computers is also an `sme` surface: the role spends a sprint
              envelope by assigning computers to work, and is the one that has
              to get into a cluster and run a command. The fleet an SME sees is
              scoped server-side to their own computers plus the ones shared on
              their initiatives (middleware lib/devbox-visibility.ts), so this
              opens a door rather than handing over a key. */}
          <Route path="devbox" element={
            <RequireRole roles={['hr-admin', 'sme']} fallback={<Navigate to="/" replace />}>
              <Page element={<DevboxPage />} />
            </RequireRole>
          } />

          <Route path="ingest" element={
            <RequireRole roles={['hr-admin']} fallback={<Navigate to="/" replace />}>
              <Page element={<IngestLayout />} />
            </RequireRole>
          }>
            {/* The old summary duplicated the Knowledge home, minus the part
                that mattered — whether the registry and the account agree. */}
            <Route index element={<Navigate to="/admin/knowledge" replace />} />
            <Route path="summary" element={<Navigate to="/admin/knowledge" replace />} />
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

          {/* Capabilities is one page now, not a menu of AWS service names.
              The overview says what each capability is for and what in this
              app depends on it; the pages below are the diagnostics behind
              that, reached from the cards rather than from a rail. */}
          <Route path="capabilities" element={
            <RequireRole roles={['org-leader', 'hr-admin']} fallback={<Navigate to="/" replace />}>
              <Outlet />
            </RequireRole>
          }>
            <Route index element={<Page element={<CapabilitiesHomePage />} />} />
            {/* The old landing tab duplicated the overview. */}
            <Route path="summary" element={<Navigate to="/admin/capabilities" replace />} />
            {/* This rendered the very same component as /iq/prompts — the
                same 2,000-line page mounted at two routes under two lazy
                names. One prompt library, one place to edit it. */}
            <Route path="prompts" element={<Navigate to="/iq/prompts" replace />} />
            <Route path="guardrails" element={<Page element={<CapabilitiesGuardrailsPage />} />} />
            <Route path="code-interpreter" element={<Page element={<CapabilitiesCodeInterpreterPage />} />} />
            <Route path="browser" element={<Page element={<CapabilitiesBrowserPage />} />} />
            {/* Rendered the same /api/sessions table as Observability →
                Sessions; one page owns that job now. */}
            <Route path="memory" element={<Navigate to="/admin/observability/sessions" replace />} />
          </Route>

          <Route path="identity" element={
            <RequireRole roles={['hr-admin']} fallback={<Navigate to="/" replace />}>
              <Page element={<IdentityLayout />} />
            </RequireRole>
          }>
            <Route index element={<Navigate to="roles" replace />} />
            <Route path="users" element={<Page element={<IdentityUsersPage />} />} />
            <Route path="roles" element={<Page element={<IdentityRolesPage />} />} />
            <Route path="policies" element={<Page element={<IdentityPoliciesPage />} />} />
            <Route path="schema" element={<Page element={<IdentitySchemaPage />} />} />
            <Route path="test" element={<Page element={<IdentityTestPage />} />} />
          </Route>
        </Route>

        {/* Catch-all: an unmatched path used to render a blank document. */}
        <Route path="*" element={<Page element={<NotFoundPage />} />} />
      </Route>
    </Routes>
    </ComputeHost>
    </GatewaySocketProvider>
  );
}
