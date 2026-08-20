import { Router } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../lib/async-handler.js';
import { normalizeRuntimeSessionId } from '../lib/runtime-session.js';
import { agentStreamMiddleware } from '@connorhoehnslalom/realtime-modules/agent-streaming';
import { agentcore, aurora } from '../providers/index.js';
import { detectIntervention, recordInvocation, snippet } from '../lib/invocations.js';
import { listEvents, recordTurn } from '../providers/memory.js';
import { maybeGenerateTitle } from '../lib/session-titles.js';
import { requireAction } from '../lib/authz.js';

export const agentsRouter = Router();

agentsRouter.get('/', asyncHandler(async (_req, res) => {
  const runtimes = await agentcore.listRuntimes();
  res.json(runtimes);
}));

agentsRouter.get('/:agentId/metrics', asyncHandler(async (req, res) => {
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
// Newsroom agents serve newsroom-tenant sessions only (admin excepted). This
// runs BEFORE the SSE stream opens so the caller gets a plain 403, not a
// mid-stream error event.
function requireAgentTenant(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  const agentId = String(req.params['agentId'] ?? '');
  const session = req.session;
  const isNewsAgent = /(^|-)news-/.test(agentId);
  if (session && isNewsAgent && session.tenant !== 'newsroom' && session.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden', requiredTenant: 'newsroom', agentId });
    return;
  }
  next();
}

agentsRouter.post('/:agentId/invoke', requireAction('Search'), requireAgentTenant, agentStreamMiddleware(async (req, stream, signal) => {
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
        case 'TOOL_CALL_START':
          stream.toolCallStart(
            field(ev as Record<string, unknown>, 'toolCallId', 'tool_call_id') ?? randomUUID(),
            field(ev as Record<string, unknown>, 'toolCallName', 'tool_call_name') ?? 'unknown',
          );
          break;
        case 'TOOL_CALL_ARGS':
          stream.toolCallArgs(
            field(ev as Record<string, unknown>, 'toolCallId', 'tool_call_id') ?? '',
            (ev as { delta?: string }).delta ?? '',
          );
          break;
        case 'TOOL_CALL_END':
          stream.toolCallEnd(field(ev as Record<string, unknown>, 'toolCallId', 'tool_call_id') ?? '');
          break;
        case 'TOOL_CALL_RESULT':
          stream.toolCallResult(
            field(ev as Record<string, unknown>, 'messageId', 'message_id') ?? '',
            field(ev as Record<string, unknown>, 'toolCallId', 'tool_call_id') ?? '',
            (ev as { content?: unknown }).content,
          );
          break;
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
      });
    }
    throw new Error(errMsg);
  }

  // Record successful invocation.
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
    });
    maybeGenerateTitle(canonicalSessionId, rawUserMessage);
  }

  stream.runFinished();
}, {
  deriveSessionId: (req) => deriveSessionId(req),
}));
