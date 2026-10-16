// hr-admin-specific fragments of the work family (docs/work-journeys-goal.md). hr-admin reaches every gated /iq and /admin
// route, so the shared refusals generator (which proves refusals by deep links that bounce) has nothing to walk for it: this
// wraps it. What the shared `refusals()`/`refusalsMap()` should absorb later: a role with no refused routes proves
// `hidden-surfaces-direct-route` by opening one gated admin route and staying on it (instead of by the bounce), and its
// `api-refused` probes come from the role's forbid rules (ApproveTransaction, EnterEnvironment), not from API_403 alone.
import type { JourneyMap, Step } from '../../../../scripts/journeys/journey-map.ts';
import { api, click, press, rail, refusals, refusalsMap, seen, surfaceMap } from './_shared.ts';

// Entries other than the per-computer ones (portalCommands plus the record sections), measured on the walk.
const PALETTE_COUNT_STATIC = 64;
const PENDING_APPROVAL = '7c1e9a20-0f41-4d8e-9a11-000000000005';

const refused = (...a: Parameters<typeof api>): Step => ({ ...api(...a), state: 'refused' }) as Step;

export function hrAdminRefusalsMap(): JourneyMap {
  const base = refusalsMap('hr-admin');
  const shared = refusals('hr-admin');
  const tail = shared.filter((s) => s.do === 'tab-walk');
  const head = shared.filter((s) => s.do !== 'tab-walk');
  // The palette carries entries per computer in the fleet (a dispatch adds a computer, and the fleet is not forked by a mock scope), so the count leaves out the Devbox group and the Terminals group.
  const entries = { css: '[role="dialog"] [role="option"]:not([data-testid^="command-palette-item-devbox:"]):not([data-testid^="command-palette-item-shell:"])' };
  const counted = head.map((s): Step => s.name.startsWith('The palette lists') ? { ...s, name: `The palette lists ${PALETTE_COUNT_STATIC} entries for this role, not counting the Devbox and Terminals entries, one of each per computer`, expect: { count: [{ target: entries, eq: PALETTE_COUNT_STATIC }] } } as Step : s);
  const steps: Step[] = [
    ...counted,
    { do: 'navigate', url: '/admin/identity', name: 'Type /admin/identity, a gated admin route: it opens, nothing sends this role back to Initiatives', state: 'default', proves: 'hidden-surfaces-direct-route',
      expect: { url: /^\/admin\/identity(\/|$)/, visible: [rail('Identity')] } } as Step,
    refused('/api/runbooks/proposals/prop-x/accept', 403, 'POST /api/runbooks/proposals/:id/accept is refused: reviewing a runbook proposal needs ReviewRunbook, which hr-admin does not hold', 'api-refused',
      { method: 'POST', body: {}, refusal: 'the ReviewRunbook gate runs before the handler looks the proposal up, so the 403 is the role, not a missing proposal' }),
    refused('/api/sprints', 403, 'POST /api/sprints is refused: opening a sprint needs ManageSprints, which hr-admin does not hold', 'api-refused',
      { method: 'POST', body: {}, refusal: 'the ManageSprints gate runs before the body is read' }),
    refused(`/api/observability/approvals/${PENDING_APPROVAL}/decision`, 403, 'POST /api/observability/approvals/:id/decision answers 403: hr-admin is forbidden ApproveTransaction', 'api-refused',
      { method: 'POST', body: { decision: 'APPROVED' }, refusal: 'separation of duties: the forbid in hr-admin.cedar beats any permit; a pending approval is named so the 403 is the Cedar gate, not a 404' }),
    ...tail,
  ];
  return {
    ...base,
    goal: 'Rachel Kowalski: the rail and palette as hr-admin sees them, ⌘I quick switch, a gated route that opens (hr-admin reaches every one) and the APIs hr-admin is explicitly forbidden',
    claims: {
      'rail-items': `${base.claims!['rail-items']} — the full Work rail: hr-admin holds every route's role, nothing is hidden`,
      'hidden-surfaces-direct-route': 'none — hr-admin reaches every gated /iq and /admin route, so no deep link bounces; /admin/identity opens and stays',
      'palette-entries': `${PALETTE_COUNT_STATIC} — every entry this role's grants allow, not counting the Devbox and Terminals entries, one of each per computer (the fleet changes as runs are dispatched)`,
      'quick-switch': `${base.claims!['quick-switch']} — hr-admin holds ConnectLocalCompute and ManageDevbox, so ⌘I lists the computers`,
      'api-refused': 'pass',
    },
    steps,
  };
}

// ── surface patches ─────────────────────────────────────────────────────────
// Where the shared function's step is right for member/sme but not for hr-admin (more rail links, a different empty
// sentence, a dispatch that no money brake stops), the hr-admin map takes the shared steps and rewrites just those.
type Patch = (s: Step) => Step | null;
const named = (needle: string | RegExp) => (s: Step) => (typeof needle === 'string' ? s.name.includes(needle) : needle.test(s.name));
function patched(journey: string, edits: Array<[string | RegExp, Patch]>, opts: Partial<JourneyMap> = {}): JourneyMap {
  const base = surfaceMap('hr-admin', journey, opts);
  const hit = new Set<number>();
  const steps = base.steps.flatMap((s) => {
    for (const [needle, fn] of edits) if (named(needle)(s)) { hit.add(edits.findIndex(([n]) => n === needle)); const out = fn(s); return out ? [out] : []; }
    return [s];
  });
  edits.forEach(([n], i) => { if (!hit.has(i)) throw new Error(`hr-admin/${journey}: no step matches ${String(n)}`); });
  return { ...base, steps };
}
const withExpect = (extra: Record<string, unknown>): Patch => (s) => ({ ...s, expect: { ...(s as { expect?: object }).expect, ...extra } }) as Step;

// The primary rail also lists Runs (the agent-run records at /iq/runs) for hr-admin, so the Automate section's Runs, Findings
// and Changes are addressed by the section rail's own link.
const sectionLink = (path: string): Patch => (s) => ({ ...s, target: { css: `[data-shell-nav] a[href="${path}"]` } }) as Step;

export const hrAdminAutomate = (): JourneyMap => patched('automate', [
  [/^Open Runs:/, sectionLink('/iq/work/queue')],
  [/^Open Findings:/, sectionLink('/iq/work/findings')],
  [/^Open Graph updates:/, sectionLink('/iq/work/changes')],
]);

// The list repaints after the URL changes: the row that only the wider filter shows is the signal the count is final.
export const hrAdminDecisions = (): JourneyMap => patched('decisions', [
  ['Back to all decisions', withExpect({ visible: [seen('Sunset legacy auth service')] })],
]);

// A dispatcher holds Answer and Sign off on an open thread (DesignThreadPage canSteer = DispatchAgentRun).
export const hrAdminDesigns = (): JourneyMap => patched('designs', [
  ['Back to all designs', withExpect({ visible: [seen('Session token rotation on tenant switch')] })],
  [/^Read the thread:/, (s) => {
    const e = (s as { expect: { absent?: unknown[]; visible?: unknown[] } }).expect;
    return { ...s, name: 'Read the thread: who posted what, by name, and who may sign off — this role holds DispatchAgentRun, so Answer and Sign off are offered', expect: { ...e, absent: undefined, visible: [...(e.visible ?? []), { role: 'button', name: /^(Answer|Sign off)( |$)/ }] } } as Step;
  }],
]);

// hr-admin has no linked initiatives, so "many" is the all-initiatives list; Sprints opens on Everyone/Active.
export const hrAdminInitiatives = (): JourneyMap => patched('initiatives', [
  [/^Choose the In Progress status/, withExpect({ visible: [seen('11 of 14 initiatives')] })],
  // The rail drops its count past a hundred rows ("100+ initiatives" in its footer), so the count is not compared with the rows here.
  [/^With many initiatives/, (s) => ({ ...s, url: '/iq/projects?scope=all', name: 'With many initiatives the list grows downward and the rail says 100+ (hr-admin lists none as "mine", so this is All initiatives)', expect: { visible: [seen('100+ initiatives')], count: [{ target: { css: 'main tbody tr' }, min: 14 }] } }) as Step],
  // hr-admin's shell asks for more before the list does, so every response held back 2.5 s pushes the list's own wait past the
  // 8 s the step looks for it; a shorter hold keeps "Loading initiatives…" inside the window.
  [/^While the list loads/, (s) => ({ ...s, scope: { scenario: 'loading', delayMs: 1000 } }) as Step],
]);

// The status filter repaints the list after the popover closes: the footer's "11 of 14" is the signal it is final.
export const hrAdminSprints = (): JourneyMap => patched('sprints', [
  // The "My envelope" tile is a personal-grant tile of the Mine scope; hr-admin opens on Everyone and holds no sprint grant.
  [/^The "My envelope" tile/, (s) => ({ do: 'wait', target: seen(/active sprints?/), name: 'On Everyone the summary carries no My envelope tile: that tile is the Mine scope\'s, and hr-admin holds no sprint grant of its own', state: 'default', proves: 'role-gating', expect: { absent: [{ role: 'button', name: /my envelope/i }], visible: [seen(/active sprints?/)] } }) as unknown as Step],
  [/^Escape closes it and focus returns/, () => null],
  [/^In a world with no sprints/, (s) => ({ ...s, name: 'In a world with no sprints the page says so for Everyone, and that none is active (hr-admin opens on Everyone, not Mine)', expect: { visible: [seen('No sprints'), seen(/No sprint is active right now|No initiative has sprints yet/)], count: [{ target: { css: 'main tbody tr' }, eq: 0 }] } }) as Step],
]);

// hr-admin's prepare-job walk reads the card and drives its keys but never dispatches (the catalog row lists composer, not write):
// the shared dispatcher steps up to the first Escape, then the Tab walk and the missing item. The card's money lines differ
// from the sme's: no sprint envelope brakes this role.
export const hrAdminPrepareJob = (): JourneyMap => {
  const base = surfaceMap('hr-admin', 'prepare-job');
  const esc = base.steps.findIndex((s) => s.name === 'Escape folds the card and the work item stays open');
  if (esc < 0) throw new Error('hr-admin/prepare-job: the shared dispatcher no longer has its first Escape step');
  const head = base.steps.slice(0, esc + 1).map((s): Step => {
    if (s.name.startsWith('Open Logout leaves')) return { ...s, name: 'Open a sized item that is up next on Auth Migration: the card will be this role\'s, held globally through DispatchAgentRun' } as Step;
    if (s.name.startsWith('The card is the dispatcher')) {
      const e = (s as { expect: { visible: unknown[] } }).expect;
      return { ...s, name: 'The card is the dispatcher\'s: it names the options, and its envelope line says no sprint envelope brakes this role', expect: { ...e, visible: [...e.visible, { text: 'Not braked by an envelope', within: { css: '[data-composer-prompt-deck="expanded"]' } }] } } as Step;
    }
    return s;
  });
  const { scenario: _scenario, writes: _writes, ...rest } = base as JourneyMap & { writes?: boolean };
  return { ...rest, scenario: 'shared', steps: [...head, base.steps.find((s) => s.do === 'tab-walk')!, base.steps[base.steps.length - 1]!] };
};

// The shared job steps already carry the live-run dialog (Cancel asks first, Accept and Reject on a run awaiting review) but
// ask for the `demo` scenario, which the mock refuses per fixture (it is a whole-world name); the world with the two live jobs
// is `large` on `agent-jobs` (mock/agent-jobs.ts). The shared function should say `large`.
const inLargeWorld: Patch = (s) => ({ ...s, scope: { scenario: 'large', fixture: 'agent-jobs' } }) as Step;
export const hrAdminJob = (): JourneyMap => patched('job', [
  [/^In the demo world a queued run is live/, (s) => ({ ...inLargeWorld(s)!, name: 'In a busy world a queued run is live: this role may Cancel it' }) as Step],
  [/^A run awaiting review offers/, inLargeWorld],
]);

// New asset (ManageCanary-like authoring, hr-admin and org-leader) does not open a dialog: it sends the author to the prompt
// studio's New prompt panel, and Cancel there returns to the library. The dialog the row asks for is the kind filter's popover,
// which Escape closes with focus back on its trigger.
export const hrAdminLibrary = (): JourneyMap => {
  const base = surfaceMap('hr-admin', 'library');
  const kind = { css: 'button[aria-label="Asset kind"]' } as const;
  const at = base.steps.findIndex((s) => s.name === 'Open the library again: the filter is gone with the page');
  if (at < 0) throw new Error('hr-admin/library: the shared steps no longer reopen the library after the kind filter');
  const extra: Step[] = [
    click(kind, 'Open the kind filter again: its options are a popover over the page', { visible: [{ role: 'option', name: /Evaluator/ }] }, { state: 'dialog-open' }),
    press('Escape', 'Escape closes the popover and focus returns to the kind filter', { hidden: [{ role: 'option', name: /Evaluator/ }], focused: kind }, { proves: 'keyboard' }),
    click({ role: 'button', name: /New asset/ }, 'New asset opens the prompt studio\'s New prompt panel (it is a panel, not a dialog)', { url: /^\/iq\/prompts\?mode=create/, visible: [seen('New prompt'), seen('Prompt name')] }),
    click({ role: 'button', name: 'Cancel' }, 'Cancel on the panel returns to the Agent library, nothing is created', { url: '/iq/library', visible: [seen('Agent library'), seen(/^\d+ assets$/)] }),
  ];
  return { ...base, steps: [...base.steps.slice(0, at + 1), ...extra, ...base.steps.slice(at + 1)] };
};
