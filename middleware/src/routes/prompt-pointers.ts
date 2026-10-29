// DE-4 prompt promotion — candidate / promote / rollback per agent.
//
// Mounted at /api/iq/prompts (index.ts), beside promptHistoryRouter.
//   GET  /:agent/pointers                  live + candidate pointers (reads: ViewObservability, from the mount)
//   POST /:agent/candidate {version, weight?, promptId?}  gate, then write the candidate pointer (-> deployed)
//   POST /:agent/promote                   candidate -> live, candidate deleted (-> promoted, old live -> superseded)
//   POST /:agent/rollback                  candidate deleted, live untouched (-> rolled_back)
// Writes are ManageCanary, the action every other prompt mutation uses.
// A refused plan is a 409 with the reason; nothing is written.

import { Router } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import {
  AGENT_RE, applyPointerPlan, findPromptId, planCandidate, planPromote, planRollback, readPointers,
  recordTransitions, runPromotionGate, type PointerPlan,
} from '../lib/prompt-pointers.js';

export const promptPointersRouter = Router();

function agentParam(v: string | string[] | undefined): string {
  const a = Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
  if (!AGENT_RE.test(a)) throw new ValidationError('agent must be a lowercase agent name');
  return a;
}

async function finish(plan: PointerPlan, res: import('express').Response): Promise<void> {
  if (plan.refused) { res.status(409).json({ ok: false, error: plan.refused, plan }); return; }
  await applyPointerPlan(plan);
  await recordTransitions(plan.transitions);
  res.json({ ok: true, plan, pointers: await readPointers(plan.agent) });
}

promptPointersRouter.get('/:agent/pointers', asyncHandler(async (req, res) => {
  const agent = agentParam(req.params['agent']);
  res.json({ agent, ...(await readPointers(agent)) });
}));

promptPointersRouter.post('/:agent/candidate', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const agent = agentParam(req.params['agent']);
  const body = (req.body ?? {}) as { version?: unknown; weight?: unknown; promptId?: unknown };
  const version = typeof body.version === 'number' ? String(body.version) : typeof body.version === 'string' ? body.version.trim() : '';
  if (!version) throw new ValidationError('version required');
  if (body.weight !== undefined && typeof body.weight !== 'number') throw new ValidationError('weight must be a number');
  const current = await readPointers(agent);
  const promptId = typeof body.promptId === 'string' && body.promptId ? body.promptId : (current.live?.promptId ?? await findPromptId(agent));
  if (!promptId) { res.status(404).json({ ok: false, error: `no prompt found for agent "${agent}"` }); return; }
  const gate = await runPromotionGate(promptId, version);
  const plan = planCandidate({ agent, current, promptId, version, ...(body.weight !== undefined ? { weight: body.weight as number } : {}), gate });
  await finish(plan, res);
}));

promptPointersRouter.post('/:agent/promote', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const agent = agentParam(req.params['agent']);
  await finish(planPromote({ agent, current: await readPointers(agent) }), res);
}));

promptPointersRouter.post('/:agent/rollback', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const agent = agentParam(req.params['agent']);
  await finish(planRollback({ agent, current: await readPointers(agent) }), res);
}));
