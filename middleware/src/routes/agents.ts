import { Router } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { agentcore, aurora } from '../providers/index.js';
import { detectIntervention, recordInvocation, snippet } from '../lib/invocations.js';
import { recordTurn } from '../providers/memory.js';

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

agentsRouter.post('/:agentId/invoke', asyncHandler(async (req, res) => {
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

  initSSE(res);

  const threadId = randomUUID();
  const runId = randomUUID();
  const messageId = randomUUID();

  writeSSE(res, { type: 'RUN_STARTED', threadId, runId, sessionId });

  const startedAt = new Date();
  let result;
  try {
    result = await agentcore.invokeAgent(agentId, {
      message: userMessage,
      sessionId,
    });
  } catch (err) {
    const errMsg = (err as Error).message || 'invoke failed';
    // Record the failure so the Observability feed reflects it.
    recordInvocation({
      id: runId,
      agentId,
      agentName: agentId,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      promptSnippet: snippet(userMessage),
      responseSnippet: '',
      guardrailIntervened: false,
      error: errMsg,
    });
    writeSSE(res, { type: 'RUN_ERROR', error: errMsg });
    writeSSE(res, { type: 'RUN_FINISHED', threadId, runId });
    endSSE(res);
    return;
  }

  // Record successful invocation with intervention detection.
  const intervened = await detectIntervention(result.text);
  recordInvocation({
    id: runId,
    agentId,
    agentName: agentId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    promptSnippet: snippet(userMessage),
    responseSnippet: snippet(result.text),
    guardrailIntervened: intervened,
    ...(result.runtimeSessionId ? { runtimeSessionId: result.runtimeSessionId } : {}),
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

  // Tool calls (mock provider emits these; real supervisor doesn't yet because
  // the entrypoint returns a single dict instead of streaming tool events).
  for (const toolCall of result.toolCalls ?? []) {
    const toolCallId = randomUUID();
    writeSSE(res, { type: 'TOOL_CALL_START', toolCallId, name: toolCall.name });
    await delay(150);
    writeSSE(res, { type: 'TOOL_CALL_ARGS', toolCallId, delta: toolCall.args });
    await delay(75);
    writeSSE(res, { type: 'TOOL_CALL_END', toolCallId, result: toolCall.result });
  }

  writeSSE(res, { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });

  const tokens = tokenize(result.text);
  for (const token of tokens) {
    if (res.writableEnded) return;
    writeSSE(res, { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: token });
    await delay(15);
  }

  writeSSE(res, { type: 'TEXT_MESSAGE_END', messageId });
  writeSSE(res, {
    type: 'RUN_FINISHED',
    threadId,
    runId,
    ...(result.runtimeSessionId ? { runtimeSessionId: result.runtimeSessionId } : {}),
  });
  endSSE(res);
}));

function tokenize(text: string): string[] {
  // Preserve whitespace as delimiters so the client reconstructs the text exactly.
  return text.split(/(\s+)/).filter(Boolean);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
