import { getDemoState } from './mock/demo-director.js';
import { startAssessmentDispatcher } from './lib/assessment-dispatcher.js';
import { startFlowRunDispatcher } from './lib/flow-runs/index.js';
import express from 'express';
import { createServer, type IncomingMessage } from 'node:http';
import { browserOrigin } from './lib/browser-origin.js';
import cookieParser from 'cookie-parser';
import { rejectUnsupportedUpgrades } from './lib/unsupported-upgrades.js';
import { LeaseGroup } from '@connorhoehn/realtime-modules/server';
import { startRealtimeGateway, realtimeGatewayEnabled, realtimeGatewayStatus, REALTIME_GATEWAY_PATH, authenticateGatewayUpgrade } from './lib/realtime-gateway.js';
import { channelGuards } from './lib/gateway/authority.js';
import { createUploadsRouter, gatewayUploadConfig } from './lib/gateway-attachments.js';
import { realtimeClaims, realtimeSigningSecret, signRealtimeToken } from './lib/realtime-token.js';
import { config } from './config.js';
import { errorHandler } from './lib/async-handler.js';
import { assertDemoModeAllowed, sessionMiddleware, setGrantsResolver } from './lib/session.js';
import { getUser as getIdentityUser } from './providers/identity.js';
import { agentsRouter } from './routes/agents.js';
import { savedSearchesRouter } from './routes/saved-searches.js';
import { graphRouter } from './routes/graph.js';
import { meGroupsRouter } from './routes/me-groups.js';
import { meSpendRouter } from './routes/me-spend.js';
import { searchRouter } from './routes/search.js';
import { tenantSearchRouter } from './routes/tenant-search.js';
import { socialGate } from './lib/social-authority.js';
import { rosterRouter } from './routes/roster.js';
import { scoresRouter } from './routes/scores.js';
import { decisionsRouter } from './routes/decisions.js';
import { projectsRouter } from './routes/projects.js';
import { voiceRouter } from './routes/voice.js';
import { voiceLogRouter } from './routes/voice-log.js';
import { designsRouter } from './routes/designs.js';
import { libraryRouter } from './routes/library.js';
import { promptEvalsRouter } from './routes/prompt-evals.js';
import { knowledgeBaseRouter } from './routes/knowledge-base.js';
import { assessmentRouter } from './routes/assessment.js';
import { socialEmbedRouter, socialRouter } from './routes/social.js';
import { socialPlaneRouter } from './routes/social-plane.js';
import { peopleRouter } from './routes/people.js';
import { discussionsRouter } from './routes/discussions.js';
import { dmPageReferencesRouter } from './routes/dm-page-references.js';
import { pageReferencesRouter } from './routes/page-references.js';
import { chatPinsRouter } from './routes/chat-pins.js';
import { pageCallsRouter } from './routes/page-calls.js';
import { socialSummarizeRouter } from './routes/social-summarize.js';
import { conversationSummarizeRouter } from './routes/conversation-summarize.js';
import { conversationArtifactRouter, socialArtifactRouter } from './routes/conversation-artifact.js';
import { conversationAgentRouter, socialAgentRouter } from './routes/agent-loop.js';
import { socialDeckRouter } from './routes/social-deck.js';
import { callPagesRouter } from './routes/call-pages.js';
import { callChatRouter } from './routes/call-chat.js';
import { pipelinesRouter } from './routes/pipelines.js';
import { accessRouter } from './routes/access.js';
import { accessQuickRouter } from './routes/access-requests-quick.js';
import { runsFacadeRouter } from './routes/runs.js';
import { runReportsRouter } from './routes/run-reports.js';
import { initiativeDecksRouter } from './routes/initiative-decks.js';
import { ingestRouter } from './routes/ingest.js';
import { observabilityRouter } from './routes/observability.js';
import { approvalsRouter } from './routes/approvals.js';
import { harnessRouter } from './routes/harness.js';
import { labRouter } from './routes/lab.js';
import { todayRouter } from './routes/today.js';
import { runbooksRouter } from './routes/runbooks.js';
import { sessionBriefsRouter } from './routes/session-briefs.js';
import { promptVersionsRouter } from './routes/prompt-versions.js';
import { costRouter } from './routes/cost.js';
import { calibrationRouter } from './routes/calibration.js';
import { oncallRouter } from './routes/oncall.js';
import { memoryRouter } from './routes/memory.js';
import { guardrailsDetailRouter } from './routes/guardrails-detail.js';
import { trafficRouter } from './routes/traffic.js';
import { invocationsRouter } from './routes/invocations.js';
import { topologyRouter } from './routes/topology.js';
import { toolCallsRouter } from './routes/tool-calls.js';
import { testFixturesRouter } from './routes/test-fixtures.js';
import { capabilitiesRouter } from './routes/capabilities.js';
import { sessionsRouter } from './routes/sessions.js';
import { sessionRouter } from './routes/session.js';
import { authRouter } from './routes/auth.js';
import { identityRouter } from './routes/identity.js';
import { canaryRouter } from './routes/canary.js';
import { canaryLibraryRouter } from './routes/canary-library.js';
import { evaluationsRouter } from './routes/evaluations.js';
import { workRouter } from './routes/work.js';
import { startJobDispatcher } from './lib/job-dispatcher.js';
import { startMockBotRunner } from './lib/mock-bot-runner.js';
import { runAllSweeps } from './providers/org-sweeps.js';
import { readAwsCredentialsStatus } from './lib/aws-creds-probe.js';
import { readDatastoreStatus } from './lib/datastore-probe.js';
import { createHealthHandler, livezHandler } from './lib/health-handler.js';
import { createHealthProbe } from './lib/health-probe.js';
import { resolveRuntimeProfile, validateRuntimeProfile } from './lib/runtime-profile.js';
import { listenHost } from './lib/bind-host.js';
import { announceInsecureDevMode } from './lib/insecure-dev-mode.js';
import { hasPullSideColumns } from './providers/agent-jobs.js';
import { inProcessQueue, pipelineQueue } from './lib/pipeline-queue-transport.js';
import { promptHistoryRouter } from './routes/prompt-history.js';
import { promptPointersRouter } from './routes/prompt-pointers.js';
import { workItemsRouter } from './routes/work-items.js';
import { workDocumentsRouter } from './routes/work-documents.js';
import { workGraphRouter } from './routes/work-graph.js';
import { kbAdminRouter } from './routes/kb-admin.js';
import { gatewayProxyRouter } from './routes/gateway-proxy.js';
import { devboxRouter, devboxReaperDeps, devboxWriteAction } from './routes/devbox.js';
import { startReaper } from './lib/devbox-reaper.js';
import { replicaId } from './lib/replica-fleet.js';
import { attachSharedFleet } from './lib/devbox-fleet.js';
import { createRedisFleetBackend, sharedFleetMode } from './lib/devbox-fleet-shared.js';
import { devboxProfilesRouter } from './routes/devbox-profiles.js';
import { localComputeRouter } from './routes/local-compute.js';
import { dropRouter } from './routes/drop.js';
import { agentDetailRouter } from './routes/agent-detail.js';
import { connectionsRouter } from './routes/connections.js';
import { agentProjectsRouter } from './routes/agent-projects.js';
import { sdlcRouter } from './routes/sdlc.js';
import { environmentsRouter } from './routes/environments.js';
import { budgetsRouter } from './routes/budgets.js';
import { userBudgetsRouter } from './routes/user-budgets.js';
import { opsSwitchesRouter } from './routes/ops-switches.js';
import { spendReportRouter } from './routes/spend-report.js';
import { sprintsRouter } from './routes/sprints.js';
import { grantsRouter } from './routes/grants.js';
import { botsRouter } from './routes/bots.js';
import { mockControlRouter } from './routes/mock-control.js';
import { assertMockRestartAdopted, completeMockRestartReplay, mockRestartSnapshot, assertMockRestartIdleDirectors, consumeMockRestartHandoff } from './mock/restart-state.js';
import { requireAction, requireTenant, readForRolesElseAction, requireSession, resolveSession } from './lib/authz.js';
import { HARNESS_RUNNER_SERVICE_AUTH, captureRawBody, serviceAuthOr } from './lib/service-auth.js';
import { initScheduler } from './lib/ingest-scheduler.js';
import { initBotScheduler } from './lib/bot-scheduler.js';
import { initFleetPersistence } from './providers/devbox-fleet-store.js';
import { initComputeRegistry } from './work-graph/compute-registry-runtime.js';
import { initCrawlTargets } from './lib/crawl-targets.js';
import { ensureSchema, seedPoliciesIfMissing } from './lib/policy-seeds.js';
import { startTracePoller } from './lib/cw-trace-ingest.js';
import { startCanaryDecisionsPoller } from './lib/canary-decisions-poller.js';
import { startPrWatchPoller } from './lib/pr-watch-poller.js';
import { startRetentionSweep } from './lib/retention-sweep.js';
import { startAccessExpirySweeper } from './lib/access-expiry.js';
import { startAccessEscalationSweeper } from './lib/access-escalation.js';
import { startLocalController } from './lib/canary-local-controller.js';
import { startComputeWorkGraphProducer } from './work-graph/compute-emitter.js';
import { internalWorkGraphComputeRouter } from './routes/internal-work-graph-compute.js';
import { internalDocumentGrantsRouter } from './routes/internal-document-grants.js';
import { realtimeLobbyAccessRouter } from './routes/realtime-lobby-access.js';
import { internalDevboxRouter } from './routes/internal-devbox.js';
import { assessmentCanvasRouter } from './routes/assessment-canvas.js';
import { assessmentDocumentWorkflowsRouter } from './routes/assessment-document-workflows.js';
import { assessmentDocumentSourceRouter } from './routes/assessment-document-source.js';
import { assessmentDocumentProposalsRouter } from './routes/assessment-document-proposals.js';

import { trustedProxyHops } from './lib/trusted-proxy.js';
import { securityHeaders } from './lib/security-headers.js';
import { startModelPriceRefresh } from './lib/model-prices.js';

const app = express();

// The one dev switch (lib/insecure-dev-mode.ts): one loud line at start-up when
// it is on, and /health reports it. Without it every security default is closed.
const insecureDev = announceInsecureDevMode();

// ECS declares its enforced ALB hop; direct/local servers ignore forwarding
// headers by default so callers cannot choose their own rate-limit bucket.
app.set('trust proxy', trustedProxyHops());
app.disable('x-powered-by');
app.use(securityHeaders);

app.use(browserOrigin);
app.use(express.json({ verify: captureRawBody }));
app.use(cookieParser());
// HMAC-only source-owned attachments for platform/gateway collaboration
// sessions. Mount before browser/session routes so it never inherits a user
// session as an alternate authorization path.
app.use('/internal/work-graph/compute-capabilities', internalWorkGraphComputeRouter);
app.use('/internal/document-grants', internalDocumentGrantsRouter);
// platform-api's per-lobby admission question, authenticated by the caller's
// realtime token alone (routes/realtime-lobby-access.ts); never a cookie.
app.use('/api/realtime', realtimeLobbyAccessRouter);
// Computer-lab surface for platform-api's chat agent loop — see
// routes/internal-devbox.ts for why this must live here, before any
// session/cookie middleware, exactly like its siblings above.
app.use('/internal/devbox', internalDevboxRouter);
setGrantsResolver(async (id) => {
  const u = await getIdentityUser(id);
  return u ? { displayName: u.displayName, grants: u.grants, epoch: u.epoch } : null;
});
app.use(sessionMiddleware());

// Observability read floor: orgiq tenant + ViewObservability. Declared here
// (not beside its first API mount) so the harness/prompt-versions mounts above
// the /api/observability block can share it.
const viewObs = [requireTenant('orgiq'), requireAction('ViewObservability')];

// AUTH_DEMO_MODE hands every cookie-less visitor an admin-capable demo
// identity, so it may only ride beside INSECURE_DEV_MODE outside production;
// set alone it stops the process rather than being quietly ignored.
try {
  assertDemoModeAllowed();
} catch (err) {
  console.error(`[startup] ${(err as Error).message}`);
  process.exit(2);
}

// Runtime profile (lib/runtime-profile.ts): validated before anything listens.
const runtimeProfile = resolveRuntimeProfile({ profile: process.env['ORGIQ_RUNTIME_PROFILE'],
  mock: config.mock, inProcessQueue: inProcessQueue() });
{
  const problems = validateRuntimeProfile(runtimeProfile);
  if (problems.length) {
    console.error(`[runtime-profile] ${runtimeProfile.profile} requirements failed:\n  - ${problems.join('\n  - ')}`);
    process.exit(2);
  }
  console.log(`[runtime-profile] ${runtimeProfile.profile}`);
}
// The column probe caches its answer for the process lifetime (applying the
// migration is a deploy step with a restart), so a long TTL here only bounds
// how often a failed information_schema read is retried.
const jobSchemaProbe = createHealthProbe(300_000, async () => (await hasPullSideColumns()) ? { ok: true }
  : { ok: false, error: 'agent_jobs lacks claim_token/heartbeat_at: apply schema/local_compute_worker_schema.sql, drain old push executors, then restart' },
() => 'job schema probe failed');
const queueProbe = inProcessQueue() ? null : createHealthProbe(15_000, async () => {
  const queue = pipelineQueue() as { ready?: (o?: { timeoutMs?: number }) => Promise<void> };
  if (!queue.ready) return { ok: false, error: 'queue transport has no readiness probe' };
  await queue.ready({ timeoutMs: 2000 });
  return { ok: true };
}, (error) => `message-queue not ready: ${error instanceof Error ? error.message.split('\n')[0]?.slice(0, 120) : 'unknown'}`);
const healthHandler = createHealthHandler({ readRealtime: () => realtimeGatewayStatus(),
  readAws: () => Object.values(config.mock).every(Boolean) ? { ok: true } : readAwsCredentialsStatus(),
  readDatastore: readDatastoreStatus, readJobSchema: jobSchemaProbe.snapshot,
  ...(queueProbe ? { readQueue: queueProbe.snapshot } : {}),
  profile: runtimeProfile.profile, mocks: config.mock, region: config.region, insecureDevMode: insecureDev });
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);
app.get('/livez', livezHandler);

// Dev-only mock control plane (/api/__mock/*). Mounted at the root so it can
// stamp X-Mock-Scenario on every response; 404s every route, and stamps
// nothing, unless the mock providers are on and NODE_ENV !== 'production'.
app.use(mockControlRouter);

app.use('/api/session', sessionRouter);
// The voice navigator: mint, tool-call rows, close (docs/voice-navigator-spec.md §6, §7),
// and the owner's read of their own session log (routes/voice-log.ts).
app.use('/api/voice', voiceRouter);
app.use('/api/voice', voiceLogRouter);
app.use('/api/assessment/knowledge', assessmentCanvasRouter);
app.use('/api/assessment/knowledge', assessmentDocumentWorkflowsRouter);
app.use('/api/assessment/knowledge', assessmentDocumentSourceRouter);
app.use('/api/assessment/knowledge', assessmentDocumentProposalsRouter);
// Enterprise SSO (Cognito OIDC). Inert unless COGNITO_* are configured.
app.use('/api/auth', authRouter);
app.use('/api/identity', identityRouter);
// Per-agent detail, mounted first so /:agentId there is not swallowed by
// the fleet router's own routes.
app.use('/api/agent-detail', requireTenant('orgiq'), requireSession('ViewAgents'), agentDetailRouter);
app.use('/api/agents', requireSession('ViewAgents'), agentsRouter);
// Decisions + Projects mounted BEFORE graphRouter so their specific paths
// resolve without going through the gated graph router.
// Org-graph surfaces are orgiq-tenant data: sessions parked in another tenant
// are rejected here (the cross-tenant admin role passes any tenant guard).
app.use('/api/search', searchRouter);
app.use('/api/graph/decisions', requireTenant('orgiq'), decisionsRouter);
app.use('/api/graph/projects', requireTenant('orgiq'), projectsRouter);
// The groups the signed-in user belongs to, one shape for every kind (lib/mine.ts): session floor here, then the
// kind's own tenant boundary and read action inside (routes/me-groups.ts) — the Communication plane's My initiatives /
// My teams / My pipelines / My org teams.
app.use('/api/me/groups', requireSession('MyGroups'), meGroupsRouter);
// What the signed-in person spent, per initiative, from the spend ledger (DE-31): read-only, own spend only.
app.use('/api/me/spend', requireSession('MySpend'), meSpendRouter);
// Design reviews — the ADR threads that gate initiative designs. Session
// floor: readable by every signed-in orgiq role, writes gated per-route.
app.use('/api/designs', requireTenant('orgiq'), requireSession('ViewDesigns'), designsRouter);
// The asset library — prompts, system prompts and evaluators in one
// catalog. Read-open to the tenant; authoring/deploy stay gated elsewhere.
app.use('/api/library', requireTenant('orgiq'), requireSession('ViewLibrary'), libraryRouter);
// Per-asset eval sets — the thing that produces the pass rate decideDeploy
// gates on. Until this existed the gate judged a number nothing computed.
app.use('/api/library/evals', requireTenant('orgiq'), requireSession('ViewLibrary'), promptEvalsRouter);
// Work-items: mounted at /api/graph so its sub-paths (/work, /projects/:id/work,
// /people/:id/work, /work-items) resolve before the gated graphRouter. Reads
// are tenant-open; the router gates its POST/PATCH per-route on
// DispatchAgentRun so board writes need the marketplace authority, not
// merely a seat in the tenant.
app.use('/api/saved-searches', savedSearchesRouter);
app.use('/api/graph', requireTenant('orgiq'), workDocumentsRouter);
app.use('/api/graph', requireTenant('orgiq'), workItemsRouter);
// The activity/work graph (docs/activity-graph-migration.md): each part is
// re-decided per request with the REST read gates of the entity it draws.
app.use('/api/work-graph', requireTenant('orgiq'), workGraphRouter);
// The org roster + relationship graph is the org-chart surface: tenant-scoped
// AND gated on ViewOrgChart (every orgiq role holds it; a grantless anonymous
// production session does not — closing the roster leak).
app.use('/api/graph', requireTenant('orgiq'), requireAction('ViewOrgChart'), graphRouter);
// The eligible-people pick-list for the sprint steward + grant grantee selectors
// (audit RM-5). Not org-chart-privileged: any signed-in orgiq member may read it
// (requireSession floor), since that is exactly the set the sprint/grant APIs
// will accept — the org roster surfaces above need ViewOrgChart, this does not.
app.use('/api/roster', requireTenant('orgiq'), requireSession('Roster'), rosterRouter);
// Ranked people-intelligence (leaderboard, cohorts, radar, contributions) is
// leadership data: ViewLeaderboard, held only by org-leader / hr-admin / admin.
// Tenant guard alone previously let any orgiq member — and any anonymous
// caller — read it.
app.use('/api/scores', requireTenant('orgiq'), requireAction('ViewLeaderboard'), scoresRouter);
// The knowledge base belongs to the orgiq tenant; scope it to that tenant.
app.use('/api/knowledge-base', requireTenant('orgiq'), knowledgeBaseRouter);
// KB Registry admin — CRUD + async provisioning for multi-KB support.
// Tenant-scoped to orgiq first (its DELETE/provision routes are destructive,
// and admin bypasses the tenant guard). Then: reading the registry
// is operational visibility (org-leader + hr-admin, like Health), while
// create/adopt/provision/sync/delete still require ManageKB (hr-admin). Mounted
// before the gated observability router so the portal wizard can reach it.
app.use('/api/admin/kb-registry', requireTenant('orgiq'), readForRolesElseAction(['org-leader', 'hr-admin'], 'ManageKB'), kbAdminRouter);
// Public document drop — deliberately ungated. The token in the URL is the
// whole authority, which is why the router exposes no bucket, prefix or id
// and every limit is enforced server-side per link.
app.use('/api/drop', dropRouter);
// Assessment — tenant-guarded, but NOT at the mount: assessmentRouter applies
// requireTenant('assessment') itself so it can exempt the agent-facing
// POST /runs/:runId/complete callback (sessionless, self-gated by a service
// secret) the same way harnessRouter exempts /trace. Mounting requireTenant
// here would 401 that callback before the router ever saw the request.
app.use('/api/assessment/search', requireTenant('assessment'), requireAction('ViewAssessment'), tenantSearchRouter('assessment'));
app.use('/api/assessment', assessmentRouter);
// The third and fourth tenants (docs/social-tenant-design.md §4, §5). Neither
// has a machine callback, so the tenant gate sits at the mount: a session
// parked in any other tenant is refused before a handler runs.
// The cross-tenant half first (design E5, §4.6): context bindings and opening
// a DM are gated on the caller's GRANTS (social + the context's tenant), so an
// orgiq page can show its bound channel. Every other /api/social path falls
// through to the tenant-gated router below.
// Tenant-neutral shell presence/DM directory: session floor + shared active tenant.
app.use('/api/people', peopleRouter);
// Page discussions with new messages for the active tenant's rail and palette (session floor; per-thread read gate).
app.use('/api/discussions', discussionsRouter);
app.use('/api/social/search', requireTenant('social'), socialGate('ViewSocial'), tenantSearchRouter('social'));
app.use('/api/social', socialEmbedRouter);
// The Social application plane in orgiq/assessment/pipelines (Communication): the tenant router's own handlers, each
// gated on the caller's CURRENT Social grants (live-principal.ts) instead of the session's tenant (routes/social-plane.ts).
app.use('/api/social/plane', socialPlaneRouter);
app.use('/api/social', dmPageReferencesRouter);
// Chat page references resolved per reader (assessment dimensions): session floor, `unavailable` without authority.
app.use('/api/page-references', requireSession('ReadPageReference'), pageReferencesRouter);
app.use('/api/chat', chatPinsRouter);
// Call history of page huddles (orgiq/assessment/pipelines): the Social call-log rows, read per lobby or per tenant under the lobby's own authority.
app.use('/api/calls', pageCallsRouter);
app.use('/api/chat/commands', socialSummarizeRouter);
// /diagram and /doc: the same two authorities as /summarize (Social chatAccess; tenant chat history), private durable runs.
app.use('/api/chat/commands', socialArtifactRouter);
// /agent: a plan the requester approves, then existing flows run as them (routes/agent-loop.ts).
app.use('/api/chat/commands', socialAgentRouter);
// /summarize on tenant conversations and huddles: the conversation's own chat authority, per request.
app.use('/api/conversations/summarize', conversationSummarizeRouter);
app.use('/api/conversations', conversationArtifactRouter);
app.use('/api/conversations', conversationAgentRouter);
app.use('/api/chat', socialDeckRouter);
// Bytes for the gateway's file-upload verbs; authenticated by the realtime bearer token.
app.use('/api/uploads', createUploadsRouter(
  token => authenticateGatewayUpgrade({ headers: { 'sec-websocket-protocol': `bearer-token-v1, ${token}` } } as IncomingMessage),
  channelGuards,
  gatewayUploadConfig(),
  async req => {
    const session = resolveSession(req); const secret = realtimeSigningSecret();
    if (!session || !secret) return null;
    return (await signRealtimeToken(realtimeClaims(session, {}), secret)).token;
  }));
app.use('/api/calls', callPagesRouter);
app.use('/api/calls', callChatRouter);
app.use('/api/social', requireTenant('social'), socialRouter);
app.use('/api/pipelines/search', requireTenant('pipelines'), requireAction('ViewPipelines'), tenantSearchRouter('pipelines'));
app.use('/api/pipelines', requireTenant('pipelines'), pipelinesRouter);
// The access tenant (docs/access-tenant-design.md): requests, approvals, SoD policies, audit.
// At the mount — no machine callback of its own; every route adds its Cedar action.
app.use('/api/access/search', requireTenant('access'), requireAction('ViewAccess'), tenantSearchRouter('access'));
app.use('/api/access', requireTenant('access'), accessRouter);
// The in-tenant quick request (routes/access-requests-quick.ts): a session
// floor, NOT requireTenant('access') — a Work reader asks for the budgets tier
// from the Initiatives page. It files through the same submit path; it limits
// itself to catalog items of the caller's current tenant.
app.use('/api/access-requests', accessQuickRouter);
// The orgiq read of the pipelines run projection — only runs whose
// context.tenant is 'orgiq' (docs/pipelines-tenant-goal.md §"The vertical
// slice"). The bot detail page reads its runs here, never /api/pipelines/*.
// The frozen session brief + a work item's brief preview. Mounted BEFORE the
// /api/runs facade (which would 401 a box's cookie-less read first) and with no
// blanket gate: a box signs a lab envelope, a person needs ViewSessionBrief —
// both guarded per route inside the router (routes/session-briefs.ts).
app.use('/api', sessionBriefsRouter);
app.use('/api/runs', requireTenant('orgiq'), runsFacadeRouter);
// One filtered page of run reports across every executor (the Runs list, routes/run-reports.ts): the façade's door.
app.use('/api/run-reports', requireTenant('orgiq'), runReportsRouter);
// Initiative status decks (docs/agentic-flows-migration.md slice 6); a deck built
// with budget figures is visible only at the budgets read tier (routes/initiative-decks.ts).
app.use('/api/initiative-decks', requireTenant('orgiq'), initiativeDecksRouter);
// Ingest — reading jobs/storage/crawl status is operational visibility that the
// Knowledge page surfaces to org-leaders; starting crawls, editing schedules and
// other mutations still require ManageIngest (hr-admin).
app.use('/api/ingest', requireTenant('orgiq'), readForRolesElseAction(['org-leader', 'hr-admin'], 'ManageIngest'), ingestRouter);
// Connected sources — credentials for Confluence/Jira/GitHub. Gated as an
// ingestion decision, because that is what connecting a source is.
app.use('/api/connections', requireAction('ManageIngest'), connectionsRouter);
// Repositories that agents work on. Distinct from /api/graph/projects, which
// is the org graph's own notion of a project.
// Codebases — linking a repo and dispatching a governed agent run against it is
// the same authority as the SDLC/devbox surfaces, so mutations still carry that
// gate. Reads are gated per-route inside the router: org-leader/hr-admin can
// see the codebase list feeding the Authorize drawer (same tier as bots.ts'
// marketReadGate) without holding ManageDevbox. The mount is just the floor —
// tenant scope + a real session.
app.use('/api/agent-projects', requireTenant('orgiq'), requireSession('ViewAgentProjects'), agentProjectsRouter);
// AI SDLC governance — change requests, reviews, gates, policies. The mount is
// the floor (tenant scope + a real session); each route carries its own action
// (DE-42): reads ManageDevbox as before, decide DecideAgentChange, deliver
// DeliverAgentChange, re-review/address RunDevboxTask, policy writes
// ManageSdlcPolicies (org-leader + admin, docs/next-steps.md §9 item 8b).
app.use('/api/sdlc', requireTenant('orgiq'), requireSession('ViewSdlc'), sdlcRouter);
// Environments — where each initiative's code runs. Mount is the floor only
// (tenant scope + a real session): reading the estate is open to every orgiq
// role, editing it needs ManageEnvironments, and reaching a specific
// environment is a per-environment Cedar check inside the router. See
// routes/environments.ts.
app.use('/api/environments', requireTenant('orgiq'), requireSession('ViewEnvironments'), environmentsRouter);
// Budgets — initiative spend allocations. Gated per-route (reads open to
// org-leader, writes require ManageBudgets).
app.use('/api/budgets', requireTenant('orgiq'), budgetsRouter);
// User budgets (DE-54) — a monthly allocation + hard cap per app user, enforced
// in every spend hold. Reads like /api/budgets; writes ManageBudgets and never
// on the caller's own row. See routes/user-budgets.ts.
app.use('/api/user-budgets', requireTenant('orgiq'), userBudgetsRouter);
// Kill switches (DE-50): fleet and per-initiative pause, checked in every spend
// hold. Writes ManageBudgets (+ org-wide role for the fleet, stewardship for an initiative).
app.use('/api/ops', requireTenant('orgiq'), opsSwitchesRouter);
// The spend report — the ledger grouped by initiative, person, model, source or
// trigger, with burn, projection and holds; one initiative's DE-53 blocks with
// ?initiativeId=. Session floor only: the body is shaped by the budgets read
// tier (dollars withheld below it, your own figures kept). routes/spend-report.ts.
app.use('/api/spend', requireTenant('orgiq'), requireSession('ViewSpendReport'), spendReportRouter);
// Sprints — the SME's own cadence (their work, their envelope, their dates).
// Any signed-in orgiq session may read `scope=mine`; the org-wide `scope=all`
// carries the same money the ledger gates and is checked inside the router.
app.use('/api/sprints', requireTenant('orgiq'), requireSession('ViewSprints'), sprintsRouter);
// Grants — the write side of sprint envelopes (budget_grants). orgiq-tenant;
// reads open to org-leader/hr-admin, writes require ManageBudgets (the release
// manager's action), gated per-route inside the router. See routes/grants.ts.
app.use('/api/grants', requireTenant('orgiq'), grantsRouter);
// Bots — durable mission-configured agents. Gated per-route inside the
// router: reads are operational visibility (org-leader + hr-admin, like the
// KB registry), bot mutations carry ManageDevbox (they dispatch the same
// governed runs the SDLC surface reviews), and the marketplace's
// dispatch-work carries the seeded DispatchAgentRun action so org-leaders
// can authorize work without holding the devbox keys.
app.use('/api/bots', requireTenant('orgiq'), botsRouter);
// Approvals are mounted BEFORE the gated observability router so that the
// agent-facing POST /approvals/request endpoint doesn't require ViewObservability
// (the agent's identity is captured as `agentId` in the request body instead).
// Decision posting is Cedar-gated inside the router itself.
app.use('/api/observability/approvals', approvalsRouter);
// Harness routes — mounted ungated so the test runner (infra/scripts/harness.py)
// can POST results without a session cookie. Same rationale as approvals.
app.use('/api/observability/harness', harnessRouter);
// The lab loop: computer-lab agents filing signals, recording experiences and
// opening human consults. Agent-facing routes are sessionless (per-route
// optional service auth INSIDE the router — no blanket session mount here,
// same rule as approvals/harness above).
app.use('/api/lab', labRouter);
// The footer's Today strip: selectors over the rows the pages read (routes/today.ts).
app.use('/api/today', todayRouter);
// Runbooks: reads need a signed-in orgiq
// user; proposals take a person OR a box's signed lab envelope; decisions are
// ReviewRunbook + owner/initiative-SME scope. Per-route guards inside the router.
app.use('/api/runbooks', runbooksRouter);
// Prompt-versions registry — populated at run start by the harness runner.
// NOT ungated (the old comment here said so and was wrong): tenant + Cedar,
// with the harness runner's machine identity as the alternative to a session.
// `serviceAuthOr` never opens on an unset secret, so with HARNESS_RUNNER_SECRET
// unconfigured this is byte-for-byte the `viewObs` mount it was.
app.use(
  '/api/observability/prompt-versions',
  serviceAuthOr(HARNESS_RUNNER_SERVICE_AUTH, ...viewObs),
  promptVersionsRouter,
);
// Every observability aggregate below carries the ViewObservability gate AND a
// tenant scope. ViewObservability is an ALL-HANDS read within orgiq (member and
// sme hold it too, deliberately — a member labels answer quality), so the gate
// is really the tenant scope: an assessment-tenant session holding
// ViewObservability must not read orgiq agent telemetry. Admin bypasses the
// tenant guard. Note the telemetry is not partitioned by tenant, which is why
// the tenant scope matters. Mutations that would otherwise ride this read tier
// (invocation replay, calibration CRUD/runs, memory writes) are gated higher
// on ManageCanary. (In dev the cookie-less demo session is orgiq and holds
// every grant, so these render without login; in production an out-of-tenant
// or anonymous session is denied.)
// Cost aggregation routes — read-only aggregates over invocation_traces cost
// columns.
app.use('/api/observability/cost', viewObs, costRouter);
// Sprint 4 (M10) — judge calibration. Curated (prompt, response, human_score)
// tuples + periodic judge re-runs to measure judge drift.
app.use('/api/observability/calibration', viewObs, calibrationRouter);
// Sprint 3 (M9) — on-call / incident response. Composes drift + cost +
// errors + HITL + deploys into one timeline. (The old "works past session
// expiry at 3am" rationale is covered by demo mode in dev; prod operators
// hold a session.)
app.use('/api/observability/oncall', viewObs, oncallRouter);
// Sprint 4 (M11) — AgentCore Memory ops observability.
app.use('/api/observability/memory', viewObs, memoryRouter);
// Sprint 4 (M12) — guardrail rule-level interventions.
app.use('/api/observability/guardrails-detail', viewObs, guardrailsDetailRouter);
// Sprint 4 (M13) — traffic shape: RPS, hour-of-week heatmap, top users.
app.use('/api/observability/traffic', viewObs, trafficRouter);
// Test fixtures — E2E-only reset utilities. They answer 403 unless
// INSECURE_DEV_MODE=true (routes/test-fixtures.ts), production included.
app.use('/api/observability/test-fixtures', requireSession('TestFixtures'), testFixturesRouter);
// Sprint 2 — invocation search + per-invocation drill-down (M3/M5 triage).
app.use('/api/observability/invocations', viewObs, invocationsRouter);
// A2A topology — derived from parent_invocation_id linkage in invocation_traces.
// An observability read like invocations.
app.use('/api/topology', viewObs, topologyRouter);
// Sprint 2 — per-tool latency aggregates + error tail (M4).
app.use('/api/observability/tools', viewObs, toolCallsRouter);
// Canary — A/B prompt experiment surface. Reads need ViewObservability;
// mutation endpoints (PUT /weight, POST /halt) are additionally Cedar-gated
// via `ManageCanary` inside the router.
app.use('/api/observability/canary', viewObs, canaryRouter);
app.use('/api/observability/canary', viewObs, canaryLibraryRouter);
// Prompt history + experiment log — version timeline + outcome cards for /iq/history.
app.use('/api/iq/prompts', viewObs, promptHistoryRouter);
// DE-4 — per-agent prompt pointers: candidate / promote / rollback (ManageCanary on the writes).
app.use('/api/iq/prompts', viewObs, promptPointersRouter);
// Evaluations — LLM-as-judge config + recent scores. The config is SSM-backed
// and read by fireJudge() on every canary invocation, so the /iq/evaluations
// page actually governs judging (enable, model, rubric weights, sampling).
app.use('/api/observability/evaluations', viewObs, evaluationsRouter);
app.use('/api/observability', viewObs, observabilityRouter);
app.use('/api/capabilities', requireTenant('orgiq'), requireSession('ViewCapabilities'), capabilitiesRouter);
app.use('/api/sessions', requireTenant('orgiq'), requireSession('ViewSessions'), sessionsRouter);
// Devbox — Claude Code in an AgentCore Runtime microVM. Operator surface for
// a future portal page (no UI ships yet). Cedar-gated: the ManageDevbox
// action must be allowed for the caller's role (open mode when no policy
// store is configured, matching every other requireAction guard).
// Reads for every role that directs agent work (readForRolesElseAction
// fast-paths GET only); a write asks the action routes/devbox.ts's
// devboxWriteAction names for its route — OperateDevbox for the lab's drive
// (start, rename, stop, remove a computer), the route's own RunDevboxTask gate
// for handing work, ManageDevbox for everything else (the shell, codebases,
// capabilities, session bundles). This closes a contradiction: devbox-visibility.ts
// already lists org-leader in FLEET_WIDE_ROLES — it had decided what a leader
// should SEE on the fleet — while this mount refused them the router outright,
// making that visibility branch dead code and the nav item a door onto a wall.
// A program-owner is deliberately NOT fleet-wide: they fall through to the
// scoped path and see the computers on initiatives they run.
// Policy profiles (DE-40) — mounted first so `/profiles/...` never reads as a
// `:sessionId` on the fleet router below. Reads share the fleet's read tier;
// the write is gated inside (ManageBudgets + an org-wide role).
app.use('/api/devbox/profiles', requireTenant('orgiq'), devboxProfilesRouter);
app.use(
  '/api/devbox',
  // The tenant boundary used to be only the Cedar `when` (DE-42).
  requireTenant('orgiq'),
  readForRolesElseAction(['org-leader', 'hr-admin', 'program-owner'], devboxWriteAction),
  devboxRouter,
);
// Local compute — developers' own machines announcing presence (and later,
// claiming work). Mounted UNGATED: the machine routes authenticate with a
// node token (no session — a blanket session mount would 401 every laptop's
// presence writes, the same trap as approvals/harness), and the browser
// routes carry their own requireSession/ConnectLocalCompute gates per-route.
app.use('/api/local-compute', localComputeRouter);
// Work — the agentic loop: queue → devbox workers → review, scheduled sweeps
// that produce findings, and agent-proposed graph writes gated on approval.
// Reads are open so the overview renders for any role; mutations are gated
// per-route with ManageDevbox.
app.use('/api/work', requireTenant('orgiq'), requireSession('ViewWork'), workRouter);
// Retired generic gateway bridge: the BFF has no channel membership contract.
app.use('/api/gateway', requireTenant('orgiq'), requireSession('ViewGateway'), gatewayProxyRouter);

app.use(errorHandler);

assertMockRestartAdopted();
initScheduler();
initCrawlTargets();

// Restore the devbox fleet before anything sweeps it.
//
// The registry is in-memory, so without this a restart dropped every box while
// the AgentCore sessions kept running — and `devbox-reaper` only reaps what
// `listBoxes()` returns, which left forgotten sessions outside both the idle
// timeout and the lifetime ceiling with nothing able to find them again (no
// AgentCore API enumerates live runtime sessions). Hydrating here also puts
// the boxes back on the Computers page instead of showing an empty fleet while
// the microVMs are still up.
//
// Fire-and-forget, and deliberately not awaited: the reaper (started below)
// has its first sweep a full interval away, so the
// load lands first in practice — and an Aurora that is slow, mocked, or
// missing the table must not delay the listen() below or fail the boot.
// The compute registry adopts shared registrations and publishes this
// replica's fleet, so it runs after the fleet's own hydration settles.
const fleetLoad = initFleetPersistence();
const fleetInitialization = (mockRestartSnapshot() ? fleetLoad : fleetLoad.catch(() => 0)).then(() => initComputeRegistry());
// Fleet state shared across replicas (DE-47): claims, reservations, the
// activity clock and tails through Redis when there is one; nothing changes
// for a single process. Attached after hydration so this replica publishes
// what it restored without overwriting a sibling's newer record.
void fleetLoad.catch(() => 0).then(() => {
  const shared = sharedFleetMode(process.env, config.mock.aurora);
  if (shared.mode === 'redis' && shared.url) {
    attachSharedFleet(createRedisFleetBackend({ url: shared.url }), { replicaId: replicaId() });
  }
  console.warn(`[devbox-fleet] shared state ${shared.mode} (${shared.why})`);
});
// Idle, lifetime and overrun enforcement for devboxes, leader-elected across
// replicas (DE-47). Its first sweep is an interval away, after the load above.
startReaper(devboxReaperDeps());
// Cloud boxes/jobs and paired local-machine sessions now emit only through the
// authenticated platform ingestion boundary. The producer stays inert unless
// its server-owned org/credential configuration is complete.
startComputeWorkGraphProducer();
// Cron bots + the bot-run reconciler. Aurora-backed, so it awaits nothing at
// boot — a missing bots table logs and stands down.
void initBotScheduler();

// Start the CW Logs Insights trace poller. Decouples agent telemetry from
// HTTP reachability — deployed AgentCore runtimes can't necessarily reach
// `http://middleware:3001`, but their stdout is always captured into
// /aws/bedrock-agentcore/runtimes/<runtime>-DEFAULT. The poller scans those
// log groups every 30s and feeds matching ORGIQ_TRACE:<json> lines through
// the same processTrace() pipeline the HTTP endpoint uses. Idempotent at
// the DB layer (ON CONFLICT DO NOTHING on invocation_id). Set
// OBS_TRACE_POLLER_DISABLED=1 to skip in offline/test environments.
startTracePoller();

// The Claude price table (DE-32): read SSM /orgiq/pricing/model_prices now
// and every five minutes, so the synchronous lookups in the trace sink, the
// fleet and the devbox runner price from a current snapshot. No-op offline.
startModelPriceRefresh();

// Tails observability.canary_decisions and bridges new rows into canaryBroker
// so the portal's Decision History panel updates when the SFN controller
// writes audit rows. No-ops in mock mode or without Aurora.
startCanaryDecisionsPoller();
// PR-watch bot triggers + marketplace merge detection (lib/pr-watch-poller.ts).
startPrWatchPoller();
// Retention sweep — deletes terminal agentic rows past RETENTION_DAYS so the
// jobs/runs/findings tables don't grow without bound (lib/retention-sweep.ts).
startRetentionSweep();
// Local mock controller fills the Controller node in dev when SFN isn't deployed.
startLocalController();
// Access tenant: revoke elevations past expiresAt and send the 24-hour warning,
// single-flight across replicas (lib/access-expiry.ts; ACCESS_EXPIRY_SWEEP_MS).
startAccessExpirySweeper();
// Access escalation timers (2026-10-14): a step past its SLA reaches the next
// tier of deciders, single-flight across replicas (lib/access-escalation.ts).
startAccessEscalationSweeper();

// Agentic loop background workers.
// The dispatcher hands queued jobs to idle devbox boxes; the sweep scheduler
// makes the system notice things on its own instead of only when asked.
// SWEEP_INTERVAL_MIN=0 disables scheduled sweeps (they remain runnable
// on demand from the Work surface).
startJobDispatcher();
startAssessmentDispatcher();
// Durable flow runs (Social /summarize today): startup recovery of lapsed leases, then a poll.
startFlowRunDispatcher();
// Offline only: gives the Computer Lab's tail pane and activity list something
// real to show without a deployed runtime. No-op unless MOCK_AGENTCORE.
startMockBotRunner();
const sweepIntervalMin = Number(process.env['SWEEP_INTERVAL_MIN'] ?? 360);
if (sweepIntervalMin > 0) {
  console.log(`[sweeps] scheduling org sweeps every ${sweepIntervalMin} min`);
  const runSweeps = () => {
    void runAllSweeps()
      .then(({ results, released }) => {
        const summary = results.map((r) => `${r.sweep}: ${r.found} found, ${r.created} new, ${r.resolved} resolved`).join(' | ');
        if (summary) console.log(`[sweeps] ${summary}`);
        if (released > 0) console.log(`[sweeps] released ${released} finding(s) whose worker never delivered`);
      })
      .catch((err: unknown) => console.warn('[sweeps] run failed:', (err as Error).message));
  };
  setInterval(runSweeps, sweepIntervalMin * 60_000);
  // Run once shortly after boot so a fresh environment has findings without
  // waiting out the first interval.
  setTimeout(runSweeps, 15_000);
}

// Seed AVP if it's empty. Idempotent — safe on every boot.
// ensureSchema must complete before seeding policies (schema gates validation).
ensureSchema()
  .then(() => seedPoliciesIfMissing())
  .catch(err => console.error('[seed] failed:', err));

const server = createServer(app);

// This BFF serves SSE plus one realtime-modules WebSocket path: when
// REALTIME_GATEWAY is on (default outside production) REALTIME_GATEWAY_PATH
// (/ws) is the chat/presence/calls gateway, authenticated by the realtime
// token over `Sec-WebSocket-Protocol` (lib/realtime-gateway.ts). Every other
// upgrade is refused before a socket is accepted.
const gatewayOn = realtimeGatewayEnabled();
const nodeLeases = new LeaseGroup({ logger: console });
const gatewayHandle = gatewayOn ? await startRealtimeGateway(server, { leaseGroup: nodeLeases }) : null;
if (mockRestartSnapshot()) { await fleetInitialization; assertMockRestartIdleDirectors(getDemoState()); completeMockRestartReplay(); }
if (!gatewayHandle) console.log('[realtime-gateway] off (REALTIME_GATEWAY) — /ws upgrades are refused');
rejectUnsupportedUpgrades(server, { allowPaths: gatewayOn ? [REALTIME_GATEWAY_PATH] : [] });
const bindHost = listenHost();
server.listen(config.port, bindHost, () => {
  consumeMockRestartHandoff();
  const mockedDomains = Object.entries(config.mock).filter(([, v]) => v).map(([k]) => k);
  const mockSuffix = mockedDomains.length > 0 ? `mock=${mockedDomains.join(',')}` : 'mocks=off';
  console.log(`orgiq-middleware listening on ${bindHost}:${config.port} (${mockSuffix})`);
});
let closing = false;
const shutdown = async () => {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(1), 10000); deadline.unref();
  try {
    await nodeLeases.release();
    await gatewayHandle?.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    process.exit(0);
  } catch (error) { console.error('[shutdown] gateway cleanup failed', error); process.exit(1); }
};
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
