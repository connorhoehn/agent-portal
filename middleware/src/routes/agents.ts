import { Router } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../lib/async-handler.js';
import { agentStreamMiddleware } from '@connorhoehn/realtime-modules/agent-streaming';
import { agentcore, aurora } from '../providers/index.js';
import { detectIntervention, recordInvocation, snippet } from '../lib/invocations.js';
import { recordTurn } from '../providers/memory.js';
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

// AG-UI streaming route — adopts @connorhoehn/realtime-modules/agent-streaming
// for SSE framing, heartbeat (~25s), RUN_STARTED / RUN_FINISHED / RUN_ERROR
// lifecycle, and dev-mode AG-UI taxonomy validation. OrgIQ business logic
// (selection enrichment, AgentCore invoke, intervention detection, Memory
// recording, session-title generation) stays in this handler. The library
// auto-emits RUN_STARTED before the handler runs and RUN_FINISHED / RUN_ERROR
// when it resolves / throws — we emit the OrgIQ-specific sessionId via a
// CUSTOM event right after RUN_STARTED so the FE can capture it.
agentsRouter.post('/:agentId/invoke', requireAction('Search'), agentStreamMiddleware(async (req, stream, signal) => {
  const agentId = String(req.params['agentId'] ?? '');
  const { message, sessionId: rawSessionId, actorId, selection } = req.body as {
    message?: string;
    sessionId?: string;
    actorId?: string;
    selection?: { peopleIds?: string[] };
  };
  const rawUserMessage = message ?? '';

  // If the explore page sent a selection, look up the people details and
  // prepend a context block. The instruction format must be emphatic — the
  // model otherwise routinely ignores it and falls back to calling its own
  // tools. Wrapping in <<<INSTRUCTIONS>>> markers + repeating the rule at
  // both ends of the prompt empirically gets ~90%+ compliance with Nova Pro.
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
        // Plain context — no formatting instructions, no meta-prompts. The
        // Bedrock guardrail's PROMPT_ATTACK filter blocks anything that
        // looks like injection. Marker formatting is handled client-side.
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
  // AgentCore Runtime requires the session ID to be at least 33 characters
  // long. Auto-allocate a UUID if the caller sends nothing or a short ID, and
  // echo it back so the UI can persist the canonical value.
  const sessionId =
    rawSessionId && rawSessionId.length >= 33 ? rawSessionId : randomUUID() + randomUUID().slice(0, 4);

  // Echo the canonical sessionId via CUSTOM so the FE can persist it. The
  // library's RUN_STARTED carries only runId/threadId per AG-UI spec.
  stream.custom('session', { sessionId });

  const messageId = randomUUID();
  const startedAt = new Date();

  let result;
  try {
    result = await agentcore.invokeAgent(agentId, {
      message: userMessage,
      sessionId,
      ...(req.session ? { userId: req.session.sub, auth: { sub: req.session.sub, role: req.session.role } } : {}),
    });
  } catch (err) {
    const errMsg = (err as Error).message || 'invoke failed';
    // Record the failure so the Observability feed reflects it.
    recordInvocation({
      id: stream.runId,
      agentId,
      agentName: agentId,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      promptSnippet: snippet(userMessage),
      responseSnippet: '',
      guardrailIntervened: false,
      error: errMsg,
    });
    // Re-throw so the middleware emits RUN_ERROR + closes the stream.
    throw new Error(errMsg);
  }

  // Record successful invocation with intervention detection.
  const intervened = await detectIntervention(result.text);
  recordInvocation({
    id: stream.runId,
    agentId,
    agentName: agentId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    promptSnippet: snippet(userMessage),
    responseSnippet: snippet(result.text),
    guardrailIntervened: intervened,
    ...(result.runtimeSessionId ? { runtimeSessionId: result.runtimeSessionId } : {}),
    ...(result.sandboxExecutions?.length ? { sandboxExecutions: result.sandboxExecutions } : {}),
  });

  // Persist turn to AgentCore Memory so the session shows up in the sidebar
  // and can be replayed later. Use the caller-provided sessionId so a single
  // chat thread accumulates events under one Memory session.
  void recordTurn({
    sessionId,
    ...(actorId ? { actorId } : {}),
    userMessage,
    assistantMessage: result.text,
  });

  // Fire-and-forget: generate a friendly title from the user's first message
  // so the sidebar can show something better than the raw UUID.
  maybeGenerateTitle(sessionId, rawUserMessage);

  // Tool calls (mock provider emits these; real supervisor doesn't yet because
  // the entrypoint returns a single dict instead of streaming tool events).
  // Library emits canonical `toolCallName` (not `name`) on TOOL_CALL_START.
  for (const toolCall of result.toolCalls ?? []) {
    if (signal.aborted) return;
    const toolCallId = randomUUID();
    stream.toolCallStart(toolCallId, toolCall.name);
    await delay(150);
    // AG-UI args delta is a string (JSON fragment per spec); the provider
    // type allows `unknown`, so stringify objects/arrays here. Strings pass
    // through unchanged to preserve prior wire-shape behavior.
    const argsDelta = typeof toolCall.args === 'string' ? toolCall.args : JSON.stringify(toolCall.args ?? '');
    stream.toolCallArgs(toolCallId, argsDelta);
    await delay(75);
    stream.toolCallEnd(toolCallId);
    // Preserve OrgIQ behavior: emit the tool result so the FE can render it.
    // The library doesn't have a single-event tool-result that maps cleanly
    // to OrgIQ's prior TOOL_CALL_END payload — encode it as a CUSTOM event.
    stream.custom('tool_call_result', { toolCallId, result: toolCall.result });
  }

  stream.textMessageStart(messageId, 'assistant');

  const tokens = tokenize(result.text);
  for (const token of tokens) {
    if (signal.aborted || stream.closed) return;
    stream.textMessageContent(messageId, token);
    await delay(15);
  }

  stream.textMessageEnd(messageId);

  // Pass runtimeSessionId via RUN_FINISHED.result (preserves prior payload
  // shape under a different field key — FE currently doesn't read it).
  stream.runFinished(result.runtimeSessionId ? { result: { runtimeSessionId: result.runtimeSessionId } } : undefined);
}));

function tokenize(text: string): string[] {
  // Preserve whitespace as delimiters so the client reconstructs the text exactly.
  return text.split(/(\s+)/).filter(Boolean);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
