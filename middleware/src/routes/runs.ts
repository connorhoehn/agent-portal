// /api/runs — the orgiq tenant's read of the run projection
// (docs/pipelines-tenant-goal.md §"The vertical slice", decided there).
//
// An orgiq page cannot read /api/pipelines/* — that mount refuses every
// session outside the pipelines tenant, by design. So the bot detail page (and,
// in lane E, /iq/runs) reads through this façade: the same handlers as the
// pipelines router (`runReadHandlers`), scoped to runs whose `context.tenant`
// is 'orgiq'. Mounted in index.ts under requireTenant('orgiq'); a run of
// another tenant is a 404 here, never a 403, so the façade confirms nothing
// about ids it does not serve.
//
// Gate: the bots router's read gate. These runs carry bot cost and the queue's
// provenance, which /api/bots already shows to org-leader, hr-admin and
// program-owner and to anyone holding ManageBots — the same people, the same
// numbers, one door.

import { Router } from 'express';
import { readForRolesElseAction } from '../lib/authz.js';
import { runReadHandlers } from './pipelines.js';

export const runsFacadeRouter = Router();

const readGate = readForRolesElseAction(['org-leader', 'hr-admin', 'program-owner'], 'ManageBots');
const runs = runReadHandlers({ contextTenant: 'orgiq' });

runsFacadeRouter.get('/', readGate, runs.list);
runsFacadeRouter.get('/:id', readGate, runs.one);
runsFacadeRouter.get('/:id/steps', readGate, runs.steps);
runsFacadeRouter.get('/:id/events', readGate, runs.events);
