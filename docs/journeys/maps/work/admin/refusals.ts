// The cross-tenant admin (middleware/seeds/roles/admin.cedar: an unconditional permit, the only Masquerade grant)
// as it lands in the Work tenant. Measured on a clone of u-operator (2026-11-04): the same rail, palette and ⌘I as
// hr-admin, but with no forbid rules, so where hr-admin's map probes three explicit 403s this one shows that the
// most gated reads answer 200. Locally the agent callbacks are open (no service secrets in dev:mock), so they are
// not a refusal either; nothing in the Work tenant refuses this role.
import type { JourneyMap, Step } from '../../../../../scripts/journeys/journey-map.ts';
import { RAIL, api, rail, refusals, refusalsMap } from '../_shared.ts';

const PALETTE_COUNT_STATIC = 64;
const ADMIN = { user: 'u-operator', name: 'Platform Operator', tenant: 'orgiq', role: 'admin' };

export default ((): JourneyMap => {
  const base = refusalsMap('hr-admin');
  const shared = refusals('hr-admin').map((s): Step => ({ ...s, name: s.name.replace('for hr-admin', 'for admin') }) as Step);
  const tail = shared.filter((s) => s.do === 'tab-walk');
  const entries = { css: '[role="dialog"] [role="option"]:not([data-testid^="command-palette-item-devbox:"]):not([data-testid^="command-palette-item-shell:"])' };
  const head = shared.filter((s) => s.do !== 'tab-walk').map((s): Step => s.name.startsWith('The palette lists')
    ? { ...s, name: `The palette lists ${PALETTE_COUNT_STATIC} entries for admin, not counting the Devbox and Terminals entries, one of each per computer`, expect: { count: [{ target: entries, eq: PALETTE_COUNT_STATIC }] } } as Step
    : s);
  const steps: Step[] = [
    ...head,
    { do: 'navigate', url: '/admin/identity', name: 'Type /admin/identity, a gated admin route: it opens, nothing sends admin back to Initiatives', state: 'default', proves: 'hidden-surfaces-direct-route',
      expect: { url: /^\/admin\/identity(\/|$)/, visible: [rail('Identity')] } } as Step,
    api('/api/identity/users', 200, 'GET /api/identity/users answers 200: admin holds ManageIdentity like every other action', 'api-refused'),
    api('/api/budgets', 200, 'GET /api/budgets answers 200: no forbid narrows admin in this tenant', 'api-refused'),
    api('/api/sdlc/changes', 200, 'GET /api/sdlc/changes answers 200: the change review program-owner is refused is open to admin', 'api-refused'),
    ...tail,
  ];
  return {
    ...base,
    log: 'admin/refusals',
    persona: ADMIN,
    goal: 'Platform Operator: the rail and palette as the cross-tenant admin sees them in Work, ⌘I quick switch, a gated route that opens (admin reaches every one) and the reads no forbid narrows',
    claims: {
      'rail-items': `${RAIL['hr-admin'].join(', ')} — the full Work rail, the same as hr-admin's: admin's permit covers every route`,
      'hidden-surfaces-direct-route': 'none — admin reaches every gated /iq and /admin route, so no deep link bounces; /admin/identity opens and stays',
      'palette-entries': `${PALETTE_COUNT_STATIC} — every entry, not counting the Devbox and Terminals entries, one of each per computer (computers are ephemeral)`,
      'quick-switch': 'lists — admin holds ManageDevbox, so ⌘I lists the computers and offers to create one',
      'api-refused': 'none — admin.cedar has no forbid in this tenant, so the most gated reads answer 200 (shown) and nothing answers 403',
    },
    steps,
  };
})();
