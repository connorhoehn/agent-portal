import { Router } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../lib/async-handler.js';
import { normalizeRuntimeSessionId } from '../lib/runtime-session.js';
import { agentStreamMiddleware, type AgentStream } from '@connorhoehnslalom/realtime-modules/agent-streaming';
import type { Request as ExpressRequest } from 'express';
import { agentcore, aurora } from '../providers/index.js';
import { detectIntervention, recordInvocation, snippet } from '../lib/invocations.js';
import { listEvents, recordTurn, type StoredToolCall } from '../providers/memory.js';
import { maybeGenerateTitle } from '../lib/session-titles.js';
import { requireAction, requireTenant, isAllowed, resolveSession } from '../lib/authz.js';
import { annotateToolResult } from '../lib/answer-sources.js';

export const agentsRouter = Router();

agentsRouter.get('/', requireTenant('orgiq'), asyncHandler(async (_req, res) => {
  const runtimes = await agentcore.listRuntimes();
  res.json(runtimes);
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
// Agents are tenant-scoped both ways: news-* agents serve newsroom sessions
// only, and the orgiq specialists (search, scoring, advisor, ingestion,
// graph-builder) serve orgiq sessions only. The supervisor is tenant-aware
// (it builds a per-(tenant, role) Agent) so any tenant may invoke it, and
// the cross-tenant admin role passes every guard. This runs BEFORE the SSE
// stream opens so the caller gets a plain 403, not a mid-stream error event.
function agentTenant(agentId: string): 'newsroom' | 'orgiq' | null {
  if (/(^|-)news-/.test(agentId)) return 'newsroom';
  if (/supervisor/.test(agentId)) return null; // serves all tenants
  return 'orgiq';
}

function requireAgentTenant(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  const agentId = String(req.params['agentId'] ?? '');
  const session = req.session;
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
// and the newsroom agents keep their existing Search + tenant gating: news-*
// are the newsroom tenant's own tools, authorized by requireAgentTenant.
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

agentsRouter.post('/:agentId/invoke', requireAction('Search'), requireAgentTenant, requireAgentCapability, agentStreamMiddleware(async (req: ExpressRequest, stream: AgentStream, signal: AbortSignal) => {
  const agentId = String(req.params['agentId'] ?? '');
  const { message, sessionId, actorId, selection } = req.body as {
    message?: string;
    sessionId?: string;
    actorId?: string;
    selection?: { peopleIds?: string[] };
  };
  const rawUserMessage = message ?? '';
  const canonicalSessionId = deriveSessionId(req);

  // Selection enrichment — prepend people context if the explore page sent IDs.
  let userMessage = rawUserMessage;
  const selectedIds = selection?.peopleIds ?? [];
  if (selectedIds.length > 0) {
    try {
      const snap = await aurora.fetchGraph();
      const byId = new Map(snap.nodes.map((p) => [p.id, p]));
      const lines = selectedIds
        .map((id) => byId.get(id))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .map((p) => `- ${p.name} (id=${p.id}) — ${p.title}, ${p.department}, skills: ${p.skills.slice(0, 6).join(', ') || '(none)'}`);
      if (lines.length > 0) {
        userMessage = [
          `Some context about ${lines.length} people I want to ask about:`,
          ...lines,
          ``,
          rawUserMessage,
        ].join('\n');
      }
    } catch (err) {
      console.warn('[agents] selection enrichment failed:', (err as Error).message);
    }
  }

  const startedAt = new Date();

  // Fetch conversation history for multi-turn context.
  const events = await listEvents(canonicalSessionId, actorId);
  const history = events
    .filter(e => e.role === 'USER' || e.role === 'ASSISTANT')
    .slice(-20)
    .map(e => ({ role: e.role.toLowerCase(), content: e.text }));

  const invokePayload = {
    message: userMessage,
    sessionId: canonicalSessionId,
    history,
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

  try {
    for await (const event of agentcore.invokeAgentStreaming(agentId, invokePayload)) {
      if (signal.aborted || stream.closed) break;
      const ev = event as { type?: string; [k: string]: unknown };
      if (!ev.type) continue;

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
    recordInvocation({
      id: stream.runId,
      agentId,
      agentName: agentId,
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
        userMessage,
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
    agentName: agentId,
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
      userMessage,
      assistantMessage: fullText,
      toolCalls: Array.from(turnToolCalls.values()),
    });
    maybeGenerateTitle(canonicalSessionId, rawUserMessage);
  }

  stream.runFinished();
}, {
  deriveSessionId: (req: ExpressRequest) => deriveSessionId(req),
}));
