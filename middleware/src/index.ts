import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { errorHandler } from './lib/async-handler.js';
import { sessionMiddleware } from './lib/session.js';
import { agentsRouter } from './routes/agents.js';
import { graphRouter } from './routes/graph.js';
import { scoresRouter } from './routes/scores.js';
import { ingestRouter } from './routes/ingest.js';
import { observabilityRouter } from './routes/observability.js';
import { approvalsRouter } from './routes/approvals.js';
import { harnessRouter } from './routes/harness.js';
import { promptVersionsRouter } from './routes/prompt-versions.js';
import { costRouter } from './routes/cost.js';
import { oncallRouter } from './routes/oncall.js';
import { invocationsRouter } from './routes/invocations.js';
import { toolCallsRouter } from './routes/tool-calls.js';
import { capabilitiesRouter } from './routes/capabilities.js';
import { sessionsRouter } from './routes/sessions.js';
import { sessionRouter } from './routes/session.js';
import { identityRouter } from './routes/identity.js';
import { requireAction } from './lib/authz.js';
import { initScheduler } from './lib/ingest-scheduler.js';
import { initCrawlTargets } from './lib/crawl-targets.js';
import { ensureSchema, seedPoliciesIfMissing } from './lib/policy-seeds.js';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware());

function healthHandler(_req: express.Request, res: express.Response): void {
  res.json({
    status: 'ok',
    service: 'orgiq-middleware',
    mocks: config.mock,
    region: config.region,
  });
}
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

app.use('/api/session', sessionRouter);
app.use('/api/identity', identityRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/graph', graphRouter);
app.use('/api/scores', scoresRouter);
app.use('/api/ingest', requireAction('ManageIngest'), ingestRouter);
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
// Cost aggregation routes — read-only aggregates over invocation_traces cost
// columns. Mounted ungated for now; can be Cedar-gated later if PII surfaces.
app.use('/api/observability/cost', costRouter);
// Sprint 3 (M9) — on-call / incident response. Composes drift + cost +
// errors + HITL + deploys into one timeline. Mounted ungated like cost so
// the on-call surface keeps working past session expiry at 3am.
app.use('/api/observability/oncall', oncallRouter);
// Sprint 2 — invocation search + per-invocation drill-down (M3/M5 triage).
// Mounted ungated so the portal triage page can hit it directly, same as cost.
app.use('/api/observability/invocations', invocationsRouter);
// Sprint 2 — per-tool latency aggregates + error tail (M4).
app.use('/api/observability/tools', toolCallsRouter);
app.use('/api/observability', requireAction('ViewObservability'), observabilityRouter);
app.use('/api/capabilities', capabilitiesRouter);
app.use('/api/sessions', sessionsRouter);

app.use(errorHandler);

initScheduler();
initCrawlTargets();

// Seed AVP if it's empty. Idempotent — safe on every boot.
ensureSchema().catch(err => console.error('[seed] schema seed failed:', err));
seedPoliciesIfMissing().catch(err => console.error('[seed] policy seed failed:', err));

app.listen(config.port, '0.0.0.0', () => {
  const mockedDomains = Object.entries(config.mock).filter(([, v]) => v).map(([k]) => k);
  const mockSuffix = mockedDomains.length > 0 ? `mock=${mockedDomains.join(',')}` : 'mocks=off';
  console.log(`orgiq-middleware listening on :${config.port} (${mockSuffix})`);
});
