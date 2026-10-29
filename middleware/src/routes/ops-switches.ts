// Kill switches — /api/ops/switches (DE-50, docs/deployment-enhancements/DE-50-kill-switches-and-alerts.md).
//
//   GET /api/ops/switches              every switch and the recent flips (ManageBudgets or a reader of budgets)
//   PUT /api/ops/switches/:scope       { paused: boolean, reason?: string }
//
// `:scope` is `fleet` or `initiative:<id>`. A paused scope refuses every new
// spend at lib/spend-holds.ts reserveSpend (423) and the job dispatcher claims
// nothing for it; running tasks finish. The fleet scope also stops idle boxes
// at the reaper's next sweep.
//
// Gate (a decision recorded in the goal doc): ManageBudgets for every flip;
// the fleet scope additionally needs an org-wide role (org-leader, hr-admin,
// admin); an initiative scope needs stewardship of that initiative (org-wide
// roles pass). Every flip writes an audit row (fleet_switch_log), a
// `fleet-switch` metric line and a bell item to the budget holders.

import { Router } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { readForRolesElseAction, requireAction } from '../lib/authz.js';
import { ORG_WIDE_INITIATIVE_ROLES, requireInitiativeScope } from '../lib/initiative-scope.js';
import {
  FLEET_SCOPE, listSwitches, setSwitch, switchHistory, validSwitchScope,
} from '../lib/fleet-switches.js';
import { emitFleetMetric, notifyBudgetHolders } from '../lib/fleet-alerts.js';

export const opsSwitchesRouter: Router = Router();

const readGate = readForRolesElseAction(['org-leader', 'hr-admin', 'program-owner'], 'ManageBudgets');
const manageGate = requireAction('ManageBudgets');

opsSwitchesRouter.get('/switches', readGate, asyncHandler(async (_req, res) => {
  const [switches, history] = await Promise.all([listSwitches(), switchHistory(undefined, 50)]);
  res.json({ switches, history });
}));

opsSwitchesRouter.put('/switches/:scope', manageGate, asyncHandler(async (req, res) => {
  const scope = String(req.params['scope'] ?? '').trim();
  if (!validSwitchScope(scope)) throw new ValidationError("scope must be 'fleet' or 'initiative:<id>'");
  const body = (req.body ?? {}) as { paused?: unknown; reason?: unknown };
  if (typeof body.paused !== 'boolean') throw new ValidationError('paused must be a boolean');
  const reason = body.reason == null ? null : String(body.reason).trim().slice(0, 500) || null;

  if (scope === FLEET_SCOPE) {
    if (!req.session || !ORG_WIDE_INITIATIVE_ROLES.includes(req.session.role)) {
      res.status(403).json({ error: 'pausing the whole fleet needs an org-wide role (org-leader, hr-admin or admin)' });
      return;
    }
  } else {
    const initiativeId = scope.slice('initiative:'.length);
    if (!await requireInitiativeScope(req, res, initiativeId, { action: 'pause or resume work' })) return;
  }

  const actor = req.session?.sub ?? null;
  const row = await setSwitch(scope, body.paused, reason, actor);
  emitFleetMetric('fleet-switch', { scope, paused: body.paused, ActorId: actor ?? 'none', reason });
  const what = scope === FLEET_SCOPE ? 'The agent fleet' : `Initiative ${scope.slice('initiative:'.length)}`;
  void notifyBudgetHolders(
    `${what} was ${body.paused ? 'paused' : 'resumed'}`,
    reason ? `Reason: ${reason}` : 'No reason given.',
    { scope, paused: body.paused, by: actor },
  );
  res.json({ switch: row });
}));
