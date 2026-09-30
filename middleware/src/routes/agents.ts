import { Router } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../lib/async-handler.js';
import { normalizeRuntimeSessionId } from '../lib/runtime-session.js';
import { agentStreamMiddleware, type AgentStream } from '@connorhoehnslalom/realtime-modules/agent-streaming';
import type { Request as ExpressRequest } from 'express';
import { agentcore } from '../providers/index.js';
import { detectIntervention, recordInvocation, snippet } from '../lib/invocations.js';
import { listEvents, recordTurn, type StoredToolCall } from '../providers/memory.js';
import { maybeGenerateTitle } from '../lib/session-titles.js';
import { requireAction, requireTenant, isAllowed, resolveSession } from '../lib/authz.js';
import { annotateToolResult } from '../lib/answer-sources.js';
import { degradedFields } from '../lib/upstream.js';
import { parseSearchSelection, numberSearchRecords, searchContextMessage } from '../lib/search-context.js';
import { openAgentRun, recordAgentRunEvent, closeAgentRun } from '../lib/agent-runs-live.js';

export const agentsRouter = Router();

/**
 * The fleet listing.
 *
 * THE SHAPE CHANGED, AND THAT IS THE FIX. This answered a BARE ARRAY, so an
 * empty fleet and a control-plane call that failed were the same three bytes
 * on the wire — `[]` — with nowhere to put a marker saying which. The provider
 * has carried the distinction since `listRuntimesResult` (lib/upstream.ts), and
 * this was the last caller still reading the lossy view; it was left that way
 * on purpose, because converting it under a bare array would have turned a
 * loud `500` into a silent `200 []` — the exact bug being removed.
 *
 * `{ agents, degraded?, error? }` is the same vocabulary routes/cost.ts and
 * routes/environments.ts already put on the wire: `degraded` and `error` appear
 * ONLY when the listing failed, so a healthy response is the old array under
 * one key and nothing else. A failure is now a 200 that says so, rather than
 * either a lie or a 500 — the page still renders, and it can tell the reader
 * the fleet could not be read.
 *
 * BREAKING for the five portal readers (AgentFlowPage, InvokePage,
 * InvocationsPage, SummaryPage, PromptOpsHomePage), which each `await
 * res.json()` as an array. That is a handover, not an oversight — see the
 * report accompanying this change.
 */
agentsRouter.get('/', requireTenant('orgiq'), asyncHandler(async (_req, res) => {
  const listing = await agentcore.listRuntimesResult();
  res.json({ agents: listing.items, ...degradedFields(listing) });
}));

agentsRouter.get('/:agentId/metrics', requireTenant('orgiq'), asyncHandler(async (req, res) => {
  const agentId = String(req.params['agentId'] ?? '');
  const metrics = await agentcore.getRuntimeMetrics(agentId);
  if (!metrics) { res.status(404).json({ error: 'Agent not found' }); return; }
  res.json(metrics);
}));

/**
 * Normalise the OrgIQ sessionId from the request body:
 *   - AgentCore Runtime requires ≥33 chars.
 *   - Auto-allocate a UUID if the caller sends nothing or a short ID.
 *
 * MEMOIZED on the request object: this is called twice per invoke (once by
 * agentStreamMiddleware to stamp RUN_STARTED.sessionId, once by the handler
 * for the runtime call + Memory recording). Without memoization a client that
 * sent no sessionId got a DIFFERENT random id in each place — it resumed the
 * RUN_STARTED id while the transcript was recorded under the handler's id,
 * so restoring a fresh conversation always found 0 events.
 */
/**
 * The human display name to record on a live invocation, given the agent id
 * from the URL.
 *
 * The recent-activity ring (lib/invocations.ts) merges live traffic recorded
 * here with the dev:mock tail (mock/invocations.ts) for the SAME agent id.
 * The tail carries a human display name ("Supervisor"); this call used to
 * record `agentName: agentId` ("orgiq-supervisor") — a raw id repeated, not a
 * name — so anything that groups or dedupes invocations by display name saw
 * two agents instead of one for the same fleet member (org-leader.md defect
 * #16). `agentcore.getRuntime` resolves the same registry in both mock mode
 * (mockAgents) and real mode (the AgentCore runtime's own name), falling back
 * to the id only when the runtime is unknown or the lookup throws.
 */
export async function resolveAgentName(agentId: string): Promise<string> {
  try {
    const rt = await agentcore.getRuntime(agentId);
    return rt?.name || agentId;
  } catch {
    return agentId;
  }
}

/**
 * The AG-UI run id for this invoke — minted HERE, never taken from the body.
 *
 * The library's default honours a client-sent `body.runId`, and since P1 the
 * run id is the key a trace (and so a feedback label) joins on — a
 * caller-chosen id could collide with, or deliberately claim, someone else's
 * run. So the server mints it, memoized on the request like the session id,
 * and sends it to the agent (`runId` in the payload → RunAgentInput.run_id →
 * the trace bundle's `runId`).
 *
 * It is also set as the `X-AGUI-Run-Id` response header, before the SSE
 * stream opens: the portal's stream hook does not surface RUN_STARTED.runId,
 * and the Ask page needs it to attach a LabelFeedback control to the answer.
 */
export const AGUI_RUN_ID_HEADER = 'X-AGUI-Run-Id';
function deriveRunId(req: ExpressRequest): string {
  const r = req as ExpressRequest & { _aguiRunId?: string };
  if (!r._aguiRunId) {
    r._aguiRunId = randomUUID();
    if (r.res && !r.res.headersSent) r.res.setHeader(AGUI_RUN_ID_HEADER, r._aguiRunId);
  }
  return r._aguiRunId;
}

function deriveSessionId(req: { body?: Record<string, unknown> }): string {
  const r = req as { body?: { sessionId?: string }; _canonicalSessionId?: string };
  if (!r._canonicalSessionId) {
    r._canonicalSessionId = normalizeRuntimeSessionId(r.body?.sessionId);
  }
  return r._canonicalSessionId;
}

// AG-UI streaming route — adopts @connorhoehnslalom/realtime-modules/agent-streaming
// for SSE framing, heartbeat (~25s), RUN_STARTED / RUN_FINISHED / RUN_ERROR
// lifecycle, and dev-mode AG-UI taxonomy validation. OrgIQ business logic
// (selection enrichment, AgentCore invoke, intervention detection, Memory
// recording, session-title generation) stays in this handler.
//
// sessionId is now emitted on RUN_STARTED directly via the library's
// deriveSessionId option — no more CUSTOM `session` workaround.
// Tool results are emitted via standard TOOL_CALL_RESULT events — no more
// CUSTOM `tool_call_result` workaround.
// Agents are tenant-scoped: the assessment scorer/drafter serve assessment
// sessions only, and the orgiq specialists (search, scoring, advisor,
// ingestion, graph-builder) serve orgiq sessions only. The supervisor is
// tenant-aware (it builds a per-(tenant, role) Agent) so any tenant may
// invoke it, and the cross-tenant admin role passes every guard. This runs
// BEFORE the SSE stream opens so the caller gets a plain 403, not a
// mid-stream error event.
function agentTenant(agentId: string): 'assessment' | 'orgiq' | null {
  // The assessment scorer/drafter also gate tenant in-process
  // (agents/_shared/tenant_guard.py); this is the route-layer floor that
  // keeps an orgiq session from ever reaching them.
  const normalized = agentId.toLowerCase().replace(/_/g, '-');
  if (/(^|-)assessment-/.test(normalized)) return 'assessment';
  if (/supervisor/.test(normalized)) return null; // serves all tenants
  return 'orgiq';
}

function requireAgentTenant(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  const agentId = String(req.params['agentId'] ?? '');
  const session = resolveSession(req);
  const required = agentTenant(agentId);
  if (session && required && session.tenant !== required && session.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden', requiredTenant: required, agentId });
    return;
  }
  next();
}

// Write/pipeline agents mutate durable state: graph-builder runs the merge_*
// Aurora upserts, ingestion runs sync_knowledge_base, and scoring runs
// compute_expertise_scores (UPDATE people SET ...). Search's Cedar capability
// is enough to READ through the fleet, but DIRECT invocation of a write agent
// bypasses the supervisor's role guardrail — so it additionally requires the
// data-plane ManageIngest capability. Read agents (supervisor/search/advisor)
// keep their existing Search + tenant gating, authorized by requireAgentTenant.
//
// The id is matched on the normalized form because the runtime cache registers
// several spellings (graph-builder / orgiq-graph-builder / orgiq_graph_builder),
// mirroring how agentTenant() normalizes.
const WRITE_AGENT_RE = /(graph[-_]builder|ingestion|scoring)/;

function isWriteAgent(agentId: string): boolean {
  return WRITE_AGENT_RE.test(agentId.toLowerCase());
}

// Runs AFTER requireAgentTenant and BEFORE the SSE stream opens, so a blocked
// caller gets a plain 403 instead of a mid-stream error event.
async function requireAgentCapability(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
): Promise<void> {
  const agentId = String(req.params['agentId'] ?? '');
  if (!isWriteAgent(agentId)) { next(); return; }
  const session = resolveSession(req);
  if (!session) {
    // requireAction('Search') runs first and 401s an anonymous caller, so this
    // is belt-and-suspenders for a write agent reached without a session.
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  try {
    if (await isAllowed(session, 'ManageIngest')) { next(); return; }
    res.status(403).json({
      error: 'Forbidden',
      action: 'ManageIngest',
      agentId,
      message: 'this agent performs data writes; you need the ManageIngest capability to invoke it directly',
    });
  } catch {
    // Authorization infrastructure failure (AVP unreachable/throttled) — 503,
    // matching requireAction's distinction between a DENY and an outage.
    res.status(503).json({ error: 'authorization unavailable', action: 'ManageIngest' });
  }
}

agentsRouter.post('/:agentId/invoke', requireAction('Search'), requireAgentTenant, requireAgentCapability, asyncHandler(async (req, _res, next) => { parseSearchSelection(req.body?.selection); next(); }), agentStreamMiddleware(async (req: ExpressRequest, stream: AgentStream, signal: AbortSignal) => {
  const agentId = String(req.params['agentId'] ?? '');
  const { message, sessionId, actorId, selection, payload: rawPayload } = req.body as {
    message?: string;
    sessionId?: string;
    actorId?: string;
    selection?: unknown;
    payload?: unknown;
  };
  // Structured input for the agent (2026-09-29): the assessment drafter reads
  // `mode` and `document` at the top of its payload, which `message` cannot
  // carry to the fleet. A plain object only, bounded, and never the keys the
  // route owns (message, sessionId, userId, auth, history) — those stay ours.
  const structuredInput = agentStructuredInput(rawPayload);
  const rawUserMessage = message ?? '';
  const canonicalSessionId = deriveSessionId(req);

  // Only server-resolved records enter context. Existing runtime capabilities
  // still determine what this agent may execute; selection grants no authority.
  const refs = parseSearchSelection(selection);
  const principal = resolveSession(req);
  const { resolveSearchContext } = refs.length ? await import('../providers/search.js') : { resolveSearchContext: null };
  const context = refs.length && principal && resolveSearchContext
    ? await resolveSearchContext(principal, refs) : { records: [], edges: [] };
  const contextRecords = numberSearchRecords(context.records);
  const userMessage = searchContextMessage(rawUserMessage, contextRecords, context.edges);

  const startedAt = new Date();
  const agentName = await resolveAgentName(agentId);

  // Fetch conversation history for multi-turn context.
  const events = await listEvents(canonicalSessionId, actorId);
  const history = events
    .filter(e => e.role === 'USER' || e.role === 'ASSISTANT')
    .slice(-20)
    .map(e => ({ role: e.role.toLowerCase(), content: e.text }));

  const invokePayload = {
    message: userMessage,
    sessionId: canonicalSessionId,
    // The run the portal is watching — the agent's RUN_STARTED and its trace
    // bundle carry it back (pipelines P1).
    runId: stream.runId,
    history,
    ...(structuredInput ? { structuredInput } : {}),
    ...(req.session ? {
      userId: req.session.sub,
      auth: {
        sub: req.session.sub,
        role: req.session.role,
        tenant: req.session.tenant,
        ...(req.session.act ? { actor: req.session.act.sub } : {}),
      },
    } : {}),
  };

  // AG-UI streaming path: pipe events directly from the agent runtime.
  // The agent yields AG-UI events as SSE; we parse and forward each one.
  // ag-ui-protocol serialization drift: older SDK builds emitted camelCase
  // (messageId), 2026-08+ builds emit snake_case (message_id). Read both.
  const field = (ev: Record<string, unknown>, ...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = ev[k];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  };

  // The agentStreamMiddleware already emitted RUN_STARTED, so we skip that
  // from the agent's stream and forward everything else.
  let fullText = '';
  let hasError = false;
  // TOOL_CALL_RESULT carries no tool name, only the id — so remember what each
  // id was. The portal builds an answer's citations from these results, and
  // only a retrieval result is worth annotating with document titles.
  const toolNameById = new Map<string, string>();
  // The same tool calls, accumulated for PERSISTENCE. Source chips and the
  // tool-summary line are derived from a turn's tool calls, so a transcript
  // stored as text alone reopens with the identical answer and no evidence
  // behind it. These ride along on the Memory event (capped in
  // lib/turn-tool-calls) and restore into the shape the live stream produces.
  const turnToolCalls = new Map<string, StoredToolCall>();
  // The Run exists from RUN_STARTED (status running), before the agent's
  // bundle arrives — lib/agent-runs-live.ts; the projection shows it until a
  // trace with this run id replaces it.
  openAgentRun({
    runId: stream.runId,
    threadId: canonicalSessionId,
    agentId,
    agentName,
    userId: req.session?.sub ?? null,
    tenant: req.session?.tenant ?? null,
    prompt: rawUserMessage || null,
    startedAt: startedAt.toISOString(),
  });
  if (contextRecords.length > 0) {
    const id = randomUUID();
    const result = JSON.stringify({ records: contextRecords, edges: context.edges });
    const args = JSON.stringify({ records: refs });
    stream.toolCallStart(id, 'search_context');
    stream.toolCallArgs(id, args);
    stream.toolCallEnd(id);
    stream.toolCallResult(randomUUID(), id, result);
    turnToolCalls.set(id, { id, name: 'search_context', args, result });
  }

  try {
    for await (const event of agentcore.invokeAgentStreaming(agentId, invokePayload)) {
      if (signal.aborted || stream.closed) break;
      const ev = event as { type?: string; [k: string]: unknown };
      if (!ev.type) continue;
      recordAgentRunEvent(stream.runId, ev);

      switch (ev.type) {
        case 'RUN_STARTED':
          // Already emitted by agentStreamMiddleware — skip.
          break;
        case 'RUN_FINISHED':
          // We'll emit our own RUN_FINISHED after bookkeeping.
          break;
        case 'RUN_ERROR':
          hasError = true;
          throw new Error((ev as { message?: string }).message || 'Agent run error');
        case 'TEXT_MESSAGE_START':
          stream.textMessageStart(
            field(ev as Record<string, unknown>, 'messageId', 'message_id') ?? randomUUID(),
            ((ev as { role?: string }).role as 'assistant') ?? 'assistant',
          );
          break;
        case 'TEXT_MESSAGE_CONTENT': {
          const delta = (ev as { delta?: string }).delta ?? '';
          const msgId = field(ev as Record<string, unknown>, 'messageId', 'message_id') ?? '';
          fullText += delta;
          stream.textMessageContent(msgId, delta);
          break;
        }
        case 'TEXT_MESSAGE_END':
          stream.textMessageEnd(field(ev as Record<string, unknown>, 'messageId', 'message_id') ?? '');
          break;
        case 'TOOL_CALL_START': {
          const id = field(ev as Record<string, unknown>, 'toolCallId', 'tool_call_id') ?? randomUUID();
          const name = field(ev as Record<string, unknown>, 'toolCallName', 'tool_call_name') ?? 'unknown';
          toolNameById.set(id, name);
          turnToolCalls.set(id, { id, name, args: '' });
          stream.toolCallStart(id, name);
          break;
        }
        case 'TOOL_CALL_ARGS': {
          const id = field(ev as Record<string, unknown>, 'toolCallId', 'tool_call_id') ?? '';
          const delta = (ev as { delta?: string }).delta ?? '';
          const rec = turnToolCalls.get(id);
          if (rec) rec.args = (rec.args ?? '') + delta;
          stream.toolCallArgs(id, delta);
          break;
        }
        case 'TOOL_CALL_END':
          stream.toolCallEnd(field(ev as Record<string, unknown>, 'toolCallId', 'tool_call_id') ?? '');
          break;
        case 'TOOL_CALL_RESULT': {
          const id = field(ev as Record<string, unknown>, 'toolCallId', 'tool_call_id') ?? '';
          // Retrieval results reach the portal carrying only s3:// keys. Resolve
          // documents.title here (the browser can't) so a citation chip reads as
          // a document name instead of a filename or a bare UUID. No-op — and no
          // query — when the result names no documents.
          const annotated = await annotateToolResult(
            toolNameById.get(id) ?? '',
            (ev as { content?: unknown }).content,
          );
          // Persist the SAME (annotated) value the browser receives, converted
          // exactly as useAgentStream converts it — `String(content ?? '')` —
          // so a restored chip is derived from byte-identical input.
          const rec = turnToolCalls.get(id);
          if (rec) rec.result = String(annotated ?? '');
          stream.toolCallResult(
            field(ev as Record<string, unknown>, 'messageId', 'message_id') ?? '',
            id,
            annotated,
          );
          break;
        }
        case 'STEP_STARTED':
          stream.stepStarted(field(ev as Record<string, unknown>, 'stepName', 'step_name') ?? 'working');
          break;
        case 'STEP_FINISHED':
          stream.stepFinished(field(ev as Record<string, unknown>, 'stepName', 'step_name') ?? 'working');
          break;
        case 'STATE_SNAPSHOT':
          stream.stateSnapshot((ev as { snapshot?: unknown }).snapshot);
          break;
        case 'CUSTOM':
          stream.custom(
            (ev as { name?: string }).name ?? '',
            (ev as { value?: unknown }).value,
          );
          break;
        default:
          // Forward unknown event types as raw.
          stream.raw(ev);
      }
    }
  } catch (err) {
    const errMsg = (err as Error).message || 'invoke failed';
    closeAgentRun(stream.runId, 'failed', errMsg);
    recordInvocation({
      id: stream.runId,
      agentId,
      agentName,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      promptSnippet: snippet(userMessage),
      responseSnippet: snippet(fullText),
      guardrailIntervened: false,
      error: errMsg,
    });
    // Durability: if part of the answer already streamed, persist the turn
    // anyway — otherwise a mid-stream error (or tab close) silently drops the
    // whole exchange from Memory and the conversation can't be resumed.
    if (fullText) {
      void recordTurn({
        sessionId: canonicalSessionId,
        ...(actorId ? { actorId } : {}),
        userMessage: rawUserMessage,
        assistantMessage: fullText,
        toolCalls: Array.from(turnToolCalls.values()),
      });
    }
    throw new Error(errMsg);
  }

  // Record successful invocation.
  //
  // This always feeds the in-memory activity ring. Whether it ALSO writes an
  // observability.invocation_traces row is decided by
  // `shouldWriteMiddlewareTrace()` in lib/invocations.ts — normally it does
  // not, because the agent emits its own, richer bundle for this same run
  // (model, tokens, tool calls, parent link) and the two writers key on
  // different invocation ids, so nothing would dedupe them. Do not add a
  // direct `traceSink.enqueue` here; that is exactly the double-write that
  // doubled every cost figure and split each agent into two topology nodes.
  const intervened = await detectIntervention(fullText);
  recordInvocation({
    id: stream.runId,
    agentId,
    agentName,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    promptSnippet: snippet(userMessage),
    responseSnippet: snippet(fullText),
    guardrailIntervened: intervened,
  });

  // Persist turn + title generation (fire-and-forget).
  if (fullText) {
    void recordTurn({
      sessionId: canonicalSessionId,
      ...(actorId ? { actorId } : {}),
      userMessage: rawUserMessage,
      assistantMessage: fullText,
      toolCalls: Array.from(turnToolCalls.values()),
    });
    maybeGenerateTitle(canonicalSessionId, rawUserMessage);
  }

  closeAgentRun(stream.runId, 'completed');
  stream.runFinished();
}, {
  deriveSessionId: (req: ExpressRequest) => deriveSessionId(req),
  deriveRunId,
}));

const RESERVED_INVOKE_KEYS = new Set(['message', 'prompt', 'input_text', 'sessionId', 'userId', 'auth', 'history']);
const MAX_STRUCTURED_INPUT_BYTES = 64 * 1024;
/**
 * The invoke body's optional `payload` as the runtime's structured input: a
 * plain object of at most 64 KiB with the route-owned keys removed; anything
 * else (a string, an array, too large) is ignored rather than rejected, so an
 * old client keeps working.
 */
export function agentStructuredInput(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).filter(([k]) => !RESERVED_INVOKE_KEYS.has(k));
  if (entries.length === 0) return undefined;
  const out = Object.fromEntries(entries);
  try { if (JSON.stringify(out).length > MAX_STRUCTURED_INPUT_BYTES) return undefined; } catch { return undefined; }
  return out;
}
