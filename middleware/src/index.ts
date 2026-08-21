import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { errorHandler } from './lib/async-handler.js';
import { sessionMiddleware, setGrantsResolver } from './lib/session.js';
import { getUser as getIdentityUser } from './providers/identity.js';
import { agentsRouter } from './routes/agents.js';
import { graphRouter } from './routes/graph.js';
import { scoresRouter } from './routes/scores.js';
import { decisionsRouter } from './routes/decisions.js';
import { projectsRouter } from './routes/projects.js';
import { knowledgeBaseRouter } from './routes/knowledge-base.js';
import { newsroomArticlesRouter } from './routes/newsroom-articles.js';
import { newsroomBeatsRouter } from './routes/newsroom-beats.js';
import { ingestRouter } from './routes/ingest.js';
import { observabilityRouter } from './routes/observability.js';
import { approvalsRouter } from './routes/approvals.js';
import { harnessRouter } from './routes/harness.js';
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
import { runAllSweeps } from './providers/org-sweeps.js';
import { checkAwsCredentials } from './lib/aws-creds-probe.js';
import { checkDatastore } from './lib/datastore-probe.js';
import { promptHistoryRouter } from './routes/prompt-history.js';
import { workItemsRouter } from './routes/work-items.js';
import { kbAdminRouter } from './routes/kb-admin.js';
import { gatewayProxyRouter } from './routes/gateway-proxy.js';
import { devboxRouter } from './routes/devbox.js';
import { dropRouter } from './routes/drop.js';
import { agentDetailRouter } from './routes/agent-detail.js';
import { connectionsRouter } from './routes/connections.js';
import { agentProjectsRouter } from './routes/agent-projects.js';
import { sdlcRouter } from './routes/sdlc.js';
import { budgetsRouter } from './routes/budgets.js';
import { botsRouter } from './routes/bots.js';
import { requireAction, requireTenant, readForRolesElseAction } from './lib/authz.js';
import { initScheduler } from './lib/ingest-scheduler.js';
import { initBotScheduler } from './lib/bot-scheduler.js';
import { initCrawlTargets } from './lib/crawl-targets.js';
import { ensureSchema, seedPoliciesIfMissing } from './lib/policy-seeds.js';
import { startTracePoller } from './lib/cw-trace-ingest.js';
import { startCanaryDecisionsPoller } from './lib/canary-decisions-poller.js';
import { startPrWatchPoller } from './lib/pr-watch-poller.js';
import { startRetentionSweep } from './lib/retention-sweep.js';
import { startLocalController } from './lib/canary-local-controller.js';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
setGrantsResolver(async (id) => {
  const u = await getIdentityUser(id);
  return u ? { displayName: u.displayName, grants: u.grants } : null;
});
app.use(sessionMiddleware());

function healthHandler(_req: express.Request, res: express.Response): void {
  // Fire-and-report: don't block health on STS when mocks are on.
  const wantsAws = !Object.values(config.mock).every(Boolean);
  void Promise.all([
    wantsAws ? checkAwsCredentials() : Promise.resolve({ ok: true } as const),
    // Valid credentials say nothing about the database existing. Without this
    // the status line reported "ok" against a torn-down cluster while every
    // Aurora-backed route 500'd.
    checkDatastore(),
  ]).then(([creds, datastore]) => {
    res.json({
      status: creds.ok && datastore.ok ? 'ok' : 'degraded',
      service: 'orgiq-middleware',
      mocks: config.mock,
      region: config.region,
      awsCredentials: creds,
      datastore,
    });
  });
}
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

app.use('/api/session', sessionRouter);
// Enterprise SSO (Cognito OIDC). Inert unless COGNITO_* are configured.
app.use('/api/auth', authRouter);
app.use('/api/identity', identityRouter);
// Per-agent detail, mounted first so /:agentId there is not swallowed by
// the fleet router's own routes.
app.use('/api/agent-detail', agentDetailRouter);
app.use('/api/agents', agentsRouter);
// Decisions + Projects mounted BEFORE graphRouter so their specific paths
// resolve without going through the gated graph router.
// Org-graph surfaces are orgiq-tenant data: sessions parked in another tenant
// are rejected here (the cross-tenant admin role passes any tenant guard).
app.use('/api/graph/decisions', requireTenant('orgiq'), decisionsRouter);
app.use('/api/graph/projects', requireTenant('orgiq'), projectsRouter);
// Work-items: mounted at /api/graph so its sub-paths (/work, /projects/:id/work,
// /people/:id/work, /work-items) resolve before the gated graphRouter. Reads
// are tenant-open; the router gates its POST/PATCH per-route on
// DispatchAgentRun so board writes need the marketplace authority, not
// merely a seat in the tenant.
app.use('/api/graph', requireTenant('orgiq'), workItemsRouter);
// The org roster + relationship graph is the org-chart surface: tenant-scoped
// AND gated on ViewOrgChart (every orgiq role holds it; a grantless anonymous
// production session does not — closing the roster leak).
app.use('/api/graph', requireTenant('orgiq'), requireAction('ViewOrgChart'), graphRouter);
// Ranked people-intelligence (leaderboard, cohorts, radar, contributions) is
// leadership data: ViewLeaderboard, held only by org-leader / hr-admin / admin.
// Tenant guard alone previously let any orgiq member — and any anonymous
// caller — read it.
app.use('/api/scores', requireTenant('orgiq'), requireAction('ViewLeaderboard'), scoresRouter);
// The knowledge base belongs to the orgiq tenant; scope it so a newsroom
// session (even one holding ManageKB) cannot read or mutate it.
app.use('/api/knowledge-base', requireTenant('orgiq'), knowledgeBaseRouter);
// KB Registry admin — CRUD + async provisioning for multi-KB support.
// Tenant-scoped to orgiq first (the KB belongs to orgiq; a newsroom editor
// holds ManageKB but must not reach it — its DELETE/provision routes are
// destructive, and admin bypasses the tenant guard). Then: reading the registry
// is operational visibility (org-leader + hr-admin, like Health), while
// create/adopt/provision/sync/delete still require ManageKB (hr-admin). Mounted
// before the gated observability router so the portal wizard can reach it.
app.use('/api/admin/kb-registry', requireTenant('orgiq'), readForRolesElseAction(['org-leader', 'hr-admin'], 'ManageKB'), kbAdminRouter);
// Public document drop — deliberately ungated. The token in the URL is the
// whole authority, which is why the router exposes no bucket, prefix or id
// and every limit is enforced server-side per link.
app.use('/api/drop', dropRouter);
// Newsroom — beats mounted BEFORE articles so /beats doesn't get swallowed.
// Tenant-guarded: an orgiq session cannot read newsroom data (and vice versa
// via the orgiq guards above). This is the no-cross-pollination boundary.
app.use('/api/newsroom/beats', requireTenant('newsroom'), newsroomBeatsRouter);
app.use('/api/newsroom', requireTenant('newsroom'), newsroomArticlesRouter);
// Ingest — reading jobs/storage/crawl status is operational visibility that the
// Knowledge page surfaces to org-leaders; starting crawls, editing schedules and
// other mutations still require ManageIngest (hr-admin).
app.use('/api/ingest', readForRolesElseAction(['org-leader', 'hr-admin'], 'ManageIngest'), ingestRouter);
// Connected sources — credentials for Confluence/Jira/GitHub. Gated as an
// ingestion decision, because that is what connecting a source is.
app.use('/api/connections', requireAction('ManageIngest'), connectionsRouter);
// Repositories that agents work on. Distinct from /api/graph/projects, which
// is the org graph's own notion of a project.
// Codebases — linking a repo and dispatching a governed agent run against it is
// the same authority as the SDLC/devbox surfaces, so it carries the same gate.
// Previously ungated: any role (member included) could link a repo and dispatch
// runs, bypassing ManageDevbox entirely.
app.use('/api/agent-projects', requireAction('ManageDevbox'), agentProjectsRouter);
// AI SDLC governance — change requests, reviews, gates, policies. Gated as a
// devbox-management action.
app.use('/api/sdlc', requireAction('ManageDevbox'), sdlcRouter);
// Budgets — initiative spend allocations. Gated per-route (reads open to
// org-leader, writes require ManageBudgets).
app.use('/api/budgets', budgetsRouter);
// Bots — durable mission-configured agents. Gated per-route inside the
// router: reads are operational visibility (org-leader + hr-admin, like the
// KB registry), bot mutations carry ManageDevbox (they dispatch the same
// governed runs the SDLC surface reviews), and the marketplace's
// dispatch-work carries the seeded DispatchAgentRun action so org-leaders
// can authorize work without holding the devbox keys.
app.use('/api/bots', botsRouter);
// Approvals are mounted BEFORE the gated observability router so that the
// agent-facing POST /approvals/request endpoint doesn't require ViewObservability
// (the agent's identity is captured as `agentId` in the request body instead).
// Decision posting is Cedar-gated inside the router itself.
app.use('/api/observability/approvals', approvalsRouter);
// Harness routes — mounted ungated so the test runner (infra/scripts/harness.py)
// can POST results without a session cookie. Same rationale as approvals.
app.use('/api/observability/harness', harnessRouter);
// Prompt-versions registry — populated at run start by the harness runner.
// Mounted ungated (no session) like approvals/harness.
app.use('/api/observability/prompt-versions', promptVersionsRouter);
// Every observability aggregate below carries the ViewObservability gate AND a
// tenant scope. Platform telemetry (traces, cost, topology, per-user traffic)
// is not partitioned by tenant, so it belongs to the orgiq home tenant's
// privileged roles plus admin — a newsroom editor holding ViewObservability
// must not read orgiq agent telemetry. Admin bypasses the tenant guard.
// (In dev the cookie-less demo session is orgiq and holds every grant, so
// these render without login; in production a newsroom or anonymous session
// is denied.)
const viewObs = [requireTenant('orgiq'), requireAction('ViewObservability')];
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
// Test fixtures — E2E-only reset utilities. NODE_ENV=production locks them
// internally, so they stay ungated for the sessionless E2E runner.
app.use('/api/observability/test-fixtures', testFixturesRouter);
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
// Evaluations — LLM-as-judge config + recent scores. The config is SSM-backed
// and read by fireJudge() on every canary invocation, so the /iq/evaluations
// page actually governs judging (enable, model, rubric weights, sampling).
app.use('/api/observability/evaluations', viewObs, evaluationsRouter);
app.use('/api/observability', viewObs, observabilityRouter);
app.use('/api/capabilities', capabilitiesRouter);
app.use('/api/sessions', sessionsRouter);
// Devbox — Claude Code in an AgentCore Runtime microVM. Operator surface for
// a future portal page (no UI ships yet). Cedar-gated: the ManageDevbox
// action must be allowed for the caller's role (open mode when no policy
// store is configured, matching every other requireAction guard).
app.use('/api/devbox', requireAction('ManageDevbox'), devboxRouter);
// Work — the agentic loop: queue → devbox workers → review, scheduled sweeps
// that produce findings, and agent-proposed graph writes gated on approval.
// Reads are open so the overview renders for any role; mutations are gated
// per-route with ManageDevbox.
app.use('/api/work', workRouter);
// Gateway proxy — signs + forwards Wave 6 service-auth-gated endpoints so
// the browser doesn't need to hold the HMAC secret. Reads GATEWAY_URL +
// GATEWAY_SERVICE_AUTH_SECRET from env. No session required: the signing
// is the auth mechanism; individual portal routes can add requireAction()
// guards if per-user authz is needed in future.
app.use('/api/gateway', gatewayProxyRouter);

app.use(errorHandler);

initScheduler();
initCrawlTargets();
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

// Agentic loop background workers.
// The dispatcher hands queued jobs to idle devbox boxes; the sweep scheduler
// makes the system notice things on its own instead of only when asked.
// SWEEP_INTERVAL_MIN=0 disables scheduled sweeps (they remain runnable
// on demand from the Work surface).
startJobDispatcher();
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

const server = app.listen(config.port, '0.0.0.0', () => {
  const mockedDomains = Object.entries(config.mock).filter(([, v]) => v).map(([k]) => k);
  const mockSuffix = mockedDomains.length > 0 ? `mock=${mockedDomains.join(',')}` : 'mocks=off';
  console.log(`orgiq-middleware listening on :${config.port} (${mockSuffix})`);
});

// Minimal WebSocket server at /ws — accepts portal connections from
// useGatewaySocket so the browser doesn't log a connection error.
// Full gateway functionality lives in the websocket-gateway service.
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.on('error', () => { /* swallow client disconnects */ });
});
