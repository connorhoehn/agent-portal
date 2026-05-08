import { Router } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { mockAgents } from '../mock/agent-statuses.js';
import { selectMockResponse } from '../mock/responses.js';

export const agentsRouter = Router();

agentsRouter.get('/', (_req, res) => {
  res.json(mockAgents);
});

agentsRouter.get('/:agentId/metrics', (req, res) => {
  const agent = mockAgents.find(a => a.id === req.params['agentId']);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  res.json({
    agentId: agent.id,
    latencyP50Ms: agent.latencyP50Ms,
    latencyP99Ms: agent.latencyP99Ms,
    invocationsLast24h: agent.invocationsLast24h,
    errorsLast24h: agent.errorsLast24h,
    tokensLast24h: agent.tokensLast24h,
    successRate: ((agent.invocationsLast24h - agent.errorsLast24h) / agent.invocationsLast24h * 100).toFixed(1),
  });
});

agentsRouter.post('/:agentId/invoke', asyncHandler(async (req, res) => {
  const { message } = req.body as { message?: string };
  const userMessage = message ?? '';

  initSSE(res);

  const threadId = randomUUID();
  const runId = randomUUID();
  const messageId = randomUUID();

  const mockResponse = selectMockResponse(userMessage);

  writeSSE(res, { type: 'RUN_STARTED', threadId, runId });
  writeSSE(res, { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });

  for (const toolCall of mockResponse.toolCalls) {
    const toolCallId = randomUUID();
    writeSSE(res, { type: 'TOOL_CALL_START', toolCallId, name: toolCall.name });
    await delay(200 + Math.random() * 300);
    writeSSE(res, { type: 'TOOL_CALL_ARGS', toolCallId, delta: toolCall.args });
    await delay(100);
    writeSSE(res, { type: 'TOOL_CALL_END', toolCallId, result: toolCall.result });
  }

  const words = mockResponse.response.split(' ');
  for (let i = 0; i < words.length; i++) {
    if (res.writableEnded) return;
    const delta = words[i] + (i < words.length - 1 ? ' ' : '');
    writeSSE(res, { type: 'TEXT_MESSAGE_CONTENT', messageId, delta });
    await delay(25 + Math.random() * 45);
  }

  writeSSE(res, { type: 'TEXT_MESSAGE_END', messageId });
  writeSSE(res, { type: 'RUN_FINISHED', threadId, runId });
  endSSE(res);
}));

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
