import { Router } from 'express';
import { cloudwatch } from '../providers/index.js';
import { asyncHandler } from '../lib/async-handler.js';
import { getRecentInvocations, getCapabilityEvents } from '../lib/invocations.js';
import type { CapabilityEventKind } from '../lib/invocations.js';
import { recentAuthzEvents, subscribeAuthz, type AuthzQuery } from '../lib/audit.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { driftRouter } from './drift.js';
import { qualityRouter } from './quality.js';
import { prWatchHealth } from '../lib/pr-watch-poller.js';
import { userNameFor } from '../lib/user-names.js';
import { traceScope, rowInScope, readsOwnerlessText, type TraceScope } from '../lib/trace-scope.js';
import { config } from '../config.js';
import { mockTraceOwners } from '../mock/observability.js';
import type { Trace } from '../providers/types.js';

export const observabilityRouter = Router();

// Drift + quality data plane (Aurora-backed; see lib/trace-sink.ts).
observabilityRouter.use('/drift', driftRouter);
observabilityRouter.use('/quality', qualityRouter);

// ── Background poller health ─────────────────────────────────────────────────

/**
 * Whether the PR-watch poller is actually running, and how it has been going.
 *
 * WHY A ROUTE. `lib/pr-watch-poller.ts` records its own health — last tick,
 * ok/not, the failure streak, the last error — but nothing exposed it, so the
 * only way to learn that no PR had been dispatched for forty minutes was to
 * tail the process logs. Worse, the poller is quiet by design: it logs the
 * FIRST failure and then only every FAILURE_STREAK_ALERT-th one, so a reader
 * arriving late finds nothing recent even though it is still broken. This
 * route is the "sayable" half of that record.
 *
 * THE AUTH FLOOR IS THE MOUNT, and it is a read, not a session-only surface.
 * `index.ts` mounts this router behind `viewObs` = requireTenant('orgiq') +
 * requireAction('ViewObservability'), which is where every other operational
 * aggregate on this router already sits. That is deliberately NOT the bare
 * `requireSession` floor used for all-hands surfaces: poller health names
 * repositories and carries upstream error text (a GitHub message, a borrowed
 * credential's failure), so it belongs on the observability read the tenant
 * gate scopes — not on "any signed-in user, in any tenant". No extra per-route
 * gate is added here; a second one would only be a place for the two to drift.
 *
 * NOTHING IS INVENTED. A process that has never ticked answers
 * `running: false, lastTickOk: null` — not a zero that reads as healthy. The
 * response carries `checkedAt` so a stale `lastTickAt` is measurable against
 * something rather than against the reader's clock, and `failingSince` gives
 * the duration directly. No "healthy" verdict is computed here — that judgment
 * belongs to whoever knows what this deployment's poll interval is, and
 * inventing a threshold on its behalf is how a green light comes to mean
 * nothing.
 */
observabilityRouter.get('/pr-watch-health', (_req, res) => {
  res.json({ poller: 'pr-watch', checkedAt: new Date().toISOString(), ...prWatchHealth() });
});

// ── Authorization decision audit log ─────────────────────────────────────────

/** The people behind an event's account ids (`subName`, `actorName`; null when unknown). */
const withNames = <E extends { sub: string; actor?: string }>(e: E) =>
  ({ ...e, ...(userNameFor(e.sub) ? { subName: userNameFor(e.sub)! } : {}), ...(e.actor && userNameFor(e.actor) ? { actorName: userNameFor(e.actor)! } : {}) });

observabilityRouter.get('/authz', (req, res) => {
  const q: AuthzQuery = {};
  const decision = req.query['decision'] as string | undefined;
  if (decision === 'ALLOW' || decision === 'DENY') q.decision = decision;
  const role = req.query['role'] as string | undefined;
  if (role) q.role = role;
  const action = req.query['action'] as string | undefined;
  if (action) q.action = action;
  const sinceMin = parseInt((req.query['sinceMin'] as string) ?? '60', 10);
  if (Number.isFinite(sinceMin) && sinceMin > 0) q.sinceMs = sinceMin * 60_000;
  const limit = parseInt((req.query['limit'] as string) ?? '200', 10);
  if (Number.isFinite(limit) && limit > 0) q.limit = Math.min(limit, 1000);
  // `subName`/`actorName`: the people behind the account ids (null when unknown).
  res.json({ events: recentAuthzEvents(q).map(withNames) });
});

observabilityRouter.get('/authz/stream', (req, res) => {
  initSSE(res);
  // Send the recent buffer immediately so a fresh subscriber catches up.
  for (const ev of recentAuthzEvents({ limit: 50 }).reverse()) {
    writeSSE(res, { type: 'authz', ...withNames(ev) });
  }
  const unsubscribe = subscribeAuthz(ev => writeSSE(res, { type: 'authz', ...withNames(ev) }));
  req.on('close', () => { unsubscribe(); endSSE(res); });
});

// The activity tail and the capability log quote people's prompts, answers,
// code and output, so each row is read through the caller's trace scope
// (lib/trace-scope.ts): a member sees their own, a fleet-wide role their
// tenant's, the cross-tenant admin everything. A row with no recorded owner
// (the mock tail's agent-to-agent rows, a crawler's events) is the admin's.
observabilityRouter.get('/recent-invocations', (req, res) => {
  const scope = traceScope(req, res);
  if (scope === 'refused') return;
  const limit = Math.max(1, Math.min(200, parseInt((req.query['limit'] as string) ?? '50', 10) || 50));
  const mockOwners = config.mock.agentcore && scope !== null ? mockTraceOwners() : null;
  const invocations = getRecentInvocations(limit, (rec) => {
    if (scope === null) return true;
    const owner = rec.userId !== undefined
      ? { user_id: rec.userId, tenant: rec.tenant ?? null }
      : mockOwners?.get(rec.id) ?? { user_id: null };
    return rowInScope(scope, owner);
  });
  res.json({ invocations });
});

/** Capability detail fields that are labels, not anyone's content. */
const CAPABILITY_DETAIL_LABELS = new Set(['language', 'agentName', 'source', 'mode', 'crawlId']);

observabilityRouter.get('/capability-events', (req, res) => {
  const scope = traceScope(req, res);
  if (scope === 'refused') return;
  const limit = Math.max(1, Math.min(200, parseInt((req.query['limit'] as string) ?? '50', 10) || 50));
  const kind = req.query['kind'] as CapabilityEventKind | undefined;
  // Every event stays (the timeline is an activity count); the code, output,
  // URLs and titles are kept only for the caller's own events.
  const events = getCapabilityEvents(limit, kind).map((ev) => {
    if (rowInScope(scope, { user_id: ev.userId ?? null, tenant: ev.tenant ?? null })) return ev;
    const detail = Object.fromEntries(Object.entries(ev.detail ?? {}).filter(([key, value]) =>
      typeof value !== 'string' || CAPABILITY_DETAIL_LABELS.has(key)));
    return { ...ev, detail, textWithheld: true };
  });
  res.json({ events });
});

// Bedrock's model-invocation log carries every caller's prompt and answer and
// names no caller (only the agent's role), so the text is the cross-tenant
// admin's; everyone else gets the counts, tokens and interventions.
observabilityRouter.get('/bedrock-invocations', asyncHandler(async (req, res) => {
  const scope = traceScope(req, res);
  if (scope === 'refused') return;
  const limit = Math.max(1, Math.min(100, parseInt((req.query['limit'] as string) ?? '20', 10) || 20));
  const sinceMin = Math.max(1, Math.min(1440, parseInt((req.query['sinceMin'] as string) ?? '60', 10) || 60));
  const entries = await cloudwatch.listBedrockInvocations({
    limit,
    sinceMs: sinceMin * 60 * 1000,
  });
  if (readsOwnerlessText(scope)) { res.json({ entries }); return; }
  res.json({
    entries: entries.map((e) => ({ ...e, promptSnippet: '', responseSnippet: '' })),
    textWithheld: true,
  });
}));

observabilityRouter.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const summary = await cloudwatch.getSummary();
    res.json(summary);
  }),
);

/**
 * Span attributes that can carry what someone typed or was told (the root
 * span's `user.query`, a model call's input or output). X-Ray names no caller,
 * so these are the cross-tenant admin's; identifiers, counts and timings stay.
 */
const SPAN_TEXT_KEY = /(^user\.|query$|prompt|response|question|answer|input$|output$|message|text|content|summary)/i;

function withoutSpanText(trace: Trace, scope: TraceScope | null): Trace {
  if (readsOwnerlessText(scope)) return trace;
  if (!Array.isArray(trace.spans)) return trace;
  return {
    ...trace,
    spans: trace.spans.map((span) => (span.attributes ? {
      ...span,
      attributes: Object.fromEntries(Object.entries(span.attributes)
        .filter(([key, value]) => typeof value !== 'string' || !SPAN_TEXT_KEY.test(key))),
    } : span)),
  };
}

observabilityRouter.get(
  '/traces',
  asyncHandler(async (req, res) => {
    const scope = traceScope(req, res);
    if (scope === 'refused') return;
    const limit = parseInt((req.query['limit'] as string) ?? '10', 10);
    const traces = await cloudwatch.listTraces(limit);
    res.json({ traces: traces.map((t) => withoutSpanText(t, scope)) });
  }),
);

observabilityRouter.get(
  '/traces/:traceId',
  asyncHandler(async (req, res) => {
    const scope = traceScope(req, res);
    if (scope === 'refused') return;
    const traceId = req.params['traceId'] as string;
    const trace = await cloudwatch.getTrace(traceId);
    if (!trace) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }
    res.json(withoutSpanText(trace, scope));
  }),
);
