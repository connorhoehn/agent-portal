// org-leader-specific fragments of the work family (docs/work-journeys-goal.md). Vera Green (u-vera) holds
// DispatchAgentRun, ManageBudgets, ManageSprints, ReviewRunbook, ViewLeaderboard, ManageCanary and ApproveTransaction, but
// not ManageDevbox; the shared surface functions are written for the sme and the hr-admin, so where the org-leader's page
// differs the map takes the shared steps and rewrites just those (the `patched` shape of _hradmin.ts).
import type { JourneyMap, Step } from '../../../../scripts/journeys/journey-map.ts';
import { api, back, click, dialog, fill, press, refusalsMap, reload, seen, STILL, surfaceMap, tabClick, tabNamed, tableRows } from './_shared.ts';

type Patch = (s: Step) => Step | null;
const named = (needle: string | RegExp) => (s: Step) => (typeof needle === 'string' ? s.name.includes(needle) : needle.test(s.name));
export function patched(journey: string, edits: Array<[string | RegExp, Patch]>, opts: Partial<JourneyMap> = {}): JourneyMap {
  const base = surfaceMap('org-leader', journey, opts);
  const hit = new Set<number>();
  const steps = base.steps.flatMap((s) => {
    for (const [needle, fn] of edits) if (named(needle)(s)) { hit.add(edits.findIndex(([n]) => n === needle)); const out = fn(s); return out ? [out] : []; }
    return [s];
  });
  edits.forEach(([n], i) => { if (!hit.has(i)) throw new Error(`org-leader/${journey}: no step matches ${String(n)}`); });
  return { ...base, steps };
}

// Vera's "mine" list is the 15 rows of the many world with no pager under them, so the pager's "· N total" is absent:
// the rail's count is compared with the rows, as the member's is. While the list loads, a 1 s hold keeps "Loading
// initiatives…" inside the window the step looks for it (the shell asks for more before the list does).
export const olInitiatives = (): JourneyMap => patched('initiatives', [
  [/^With many initiatives/, (s) => ({ ...s, expect: { ...(s as { expect: object }).expect, numbers: [{ of: { testId: 'explorer-layout-rail-count' }, eqCount: { css: 'main tbody tr' } }] } }) as Step],
  [/^While the list loads/, (s) => ({ ...s, scope: { scenario: 'loading', delayMs: 1000 } }) as Step],
]);

// ── refusals ────────────────────────────────────────────────────────────────
// The palette carries one entry per computer in the fleet the role can see (the Computer Lab is read-only for this role, but
// the fleet is listed), and the fleet is an in-memory registry no mock scope forks, so the count leaves out the Devbox and
// Terminals groups (the _hradmin.ts treatment).
const PALETTE_COUNT_STATIC = 54;
const refused = (...a: Parameters<typeof api>): Step => ({ ...api(...a), state: 'refused' }) as Step;
export function olRefusalsMap(): JourneyMap {
  const base = refusalsMap('org-leader');
  const entries = { css: '[role="dialog"] [role="option"]:not([data-testid^="command-palette-item-devbox:"]):not([data-testid^="command-palette-item-shell:"])' };
  const steps = base.steps.map((s): Step => s.name.startsWith('The palette lists')
    ? { ...s, name: `The palette lists ${PALETTE_COUNT_STATIC} entries for this role, not counting the Devbox and Terminals entries, one of each per computer`, expect: { count: [{ target: entries, eq: PALETTE_COUNT_STATIC }] } } as Step : s);
  // Dispatch, budgets, sprints, bots and runbook review are this role's; what it lacks is ManageDevbox (answering and
  // reviewing runs, driving the Computer Lab) and the hr-admin identity grants. The ManageDevbox gate runs before the handler
  // looks the job up, so the 403 is the role, not a missing job.
  const at = steps.findIndex((s) => s.do === 'tab-walk');
  const probes: Step[] = [
    refused('/api/work/jobs/job-x/requeue', 403, 'POST /api/work/jobs/:id/requeue is refused: requeueing a run needs ManageDevbox, which org-leader does not hold', 'api-refused',
      { method: 'POST', body: {}, refusal: 'the ManageDevbox gate runs before the handler looks the job up, so the 403 is the role, not a missing run' }),
    refused('/api/work/jobs/job-x/review', 403, 'POST /api/work/jobs/:id/review is refused: accepting or rejecting a run needs ManageDevbox', 'api-refused',
      { method: 'POST', body: { decision: 'accept' }, refusal: 'the ManageDevbox gate runs before the handler looks the job up' }),
  ];
  return { ...base, claims: { ...base.claims!, 'palette-entries': `${PALETTE_COUNT_STATIC} — every entry this role's grants allow, not counting the Devbox and Terminals entries, one of each per computer` }, steps: [...steps.slice(0, at), ...probes, ...steps.slice(at)] };
}

// ── prepare-job ─────────────────────────────────────────────────────────────
// The shared dispatcher walk is the sme's: a sprint grant on Auth Migration only, so a second initiative says "No sprint
// grant here" and the server refuses. The org-leader is the release manager: no envelope brakes her anywhere, and the one
// thing that stops a second dispatch in the same world is the fleet's concurrency ceiling (3), which the first dispatch of
// this walk (Auth Migration, on top of the two runs already live) has just reached; the card names it when Dispatch is pressed.
const DECK = { css: '[data-composer-prompt-deck="expanded"]' };
export const olPrepareJob = (): JourneyMap => patched('prepare-job', [
  [/^Open a work item on an initiative where this sme holds no grant/, (s) => ({ ...s, name: 'Open a work item on an initiative where no sprint grant is held: a release manager needs none' }) as Step],
  [/^Prepare job opens the card; its envelope field says there is no grant here/, (s) => ({ ...s, name: 'Prepare job opens the card on an initiative with no grant for this role' }) as Step],
  [/^The card says No sprint grant here/, (s) => ({ ...s, name: 'The card says Not braked by an envelope: no sprint grant is needed here, and none is named', expect: { visible: [{ text: 'Not braked by an envelope', within: DECK }], noText: [{ text: 'No sprint grant here' }] } }) as Step],
  [/^Key 1 dispatches: the server refuses/, (s) => ({ ...s, name: 'Key 1 dispatches nothing: the fleet\'s concurrency ceiling (3) was reached by the run just sent, so the card says so and the item stays Open', state: 'refused', expectConsole: /429/, expect: { visible: [DECK, { text: /concurrency ceiling \(3\) reached/, within: DECK }], attr: [{ target: { role: 'combobox', name: 'Status' }, name: 'data-value', value: 'open' }] } }) as Step],
]);

// New asset (ManageCanary, org-leader and hr-admin) does not open a dialog: it sends the author to the prompt studio's New
// prompt panel, and Cancel there returns to the library. The dialog the catalog row asks for is the kind filter's popover,
// which Escape closes with focus back on its trigger (the same honest alternative as hr-admin/library).
export const olLibrary = (): JourneyMap => {
  const base = surfaceMap('org-leader', 'library');
  const kind = { css: 'button[aria-label="Asset kind"]' } as const;
  const at = base.steps.findIndex((s) => s.name === 'Open the library again: the filter is gone with the page');
  if (at < 0) throw new Error('org-leader/library: the shared steps no longer reopen the library after the kind filter');
  const extra: Step[] = [
    click(kind, 'Open the kind filter again: its options are a popover over the page', { visible: [{ role: 'option', name: /Evaluator/ }] }, { state: 'dialog-open' }),
    press('Escape', 'Escape closes the popover and focus returns to the kind filter', { hidden: [{ role: 'option', name: /Evaluator/ }], focused: kind }, { proves: 'keyboard' }),
    click({ role: 'button', name: /New asset/ }, 'New asset opens the prompt studio\'s New prompt panel (it is a panel, not a dialog)', { url: /^\/iq\/prompts\?mode=create/, visible: [seen('New prompt'), seen('Prompt name')] }),
    click({ role: 'button', name: 'Cancel' }, 'Cancel on the panel returns to the Agent library, nothing is created', { url: '/iq/library', visible: [seen('Agent library'), seen(/^\d+ assets$/)] }),
  ];
  return { ...base, steps: [...base.steps.slice(0, at + 1), ...extra, ...base.steps.slice(at + 1)] };
};

// ── sprints ─────────────────────────────────────────────────────────────────
// Vera opens on Everyone/Active (she holds no sprint grant of her own, so there is no "My envelope" tile), and she holds
// ManageBudgets: the Envelopes tab grants an envelope and revokes it, each read back after a reload inside a scoped world.
const GRANTEE = 'Nora DaSilva';
const heading = (name: string) => ({ role: 'heading', name, level: 1 }) as const;
export const olSprints = (): JourneyMap => {
  const patchedBase = patched('sprints', [
    [/^The "My envelope" tile/, () => ({ do: 'wait', target: seen(/active sprints?/), name: 'On Everyone the summary carries no My envelope tile: that tile is the Mine scope\'s, and this role holds no sprint grant of its own', state: 'default', proves: 'role-gating', expect: { absent: [{ role: 'button', name: /my envelope/i }], visible: [seen(/active sprints?/)] } }) as unknown as Step],
    [/^In a world with no sprints/, (s) => ({ ...s, name: 'In a world with no sprints the page says so for Everyone, and that none is active (this role opens on Everyone, not Mine)', expect: { visible: [seen('No sprints'), seen(/No sprint is active right now|No initiative has sprints yet/)], count: [{ target: tableRows, eq: 0 }] } }) as Step],
  ]);
  // The Escape that closed the My envelope drawer has nothing to close here.
  const tile = patchedBase.steps.findIndex((s) => s.name.startsWith('On Everyone the summary carries no My envelope tile'));
  const base = { ...patchedBase, steps: patchedBase.steps.filter((s, i) => !(i === tile + 1 && s.do === 'press')) };
  const at = base.steps.findIndex((s) => s.name.startsWith('New sprint opens its form'));
  const nextEsc = base.steps.findIndex((s, i) => i > at && s.do === 'press');
  if (at < 0 || nextEsc < 0) throw new Error('org-leader/sprints: the shared steps no longer open New sprint');
  const sprintRow = { role: 'button', name: /^Open sprint Sprint 7 — Contracts/ } as const;
  const tabs = { role: 'tablist', name: 'Sprint detail sections' } as const;
  const env = tabNamed('Envelopes', tabs);
  const grantBtn = { role: 'button', name: /Grant envelope/ } as const;
  const confirm = dialog('Revoke grant?');
  const still = [STILL.header, tabs];
  const row = { role: 'button', name: `Revoke envelope for ${GRANTEE}` } as const;
  const writes: Step[] = [
    press('Enter', 'Enter on the sprint row opens it again, inside a scoped world where the writes below are allowed', { url: /[?&]sprint=spr-/, visible: [seen('Steward: Ben Okafor')] }, { target: sprintRow, state: 'row-open', proves: 'keyboard' }),
    tabClick(env, 'Click Envelopes: Ben Okafor holds the one envelope on this sprint, and this role may grant another', { attr: [{ target: env, name: 'aria-selected', value: 'true' }], visible: [seen('Ben Okafor'), seen('$10.00'), grantBtn], absent: [row] }, still),
    click(grantBtn, '+ Grant envelope opens the form: grantee, amount and note (nothing is granted yet)', { visible: [{ label: 'Grantee' }, { label: 'Amount (USD)' }, { role: 'button', name: 'Grant' }], absent: [grantBtn] }, { state: 'dialog-open', proves: 'role-gating' }),
    press('Escape', 'Escape cancels the form and focus returns to + Grant envelope; the sprint stays open', { hidden: [{ label: 'Amount (USD)' }], visible: [grantBtn], focused: grantBtn, url: /[?&]sprint=spr-/ }, { proves: 'keyboard' }),
    click(grantBtn, '+ Grant envelope opens the form again', { visible: [{ label: 'Amount (USD)' }] }, { state: 'dialog-open' }),
    click({ role: 'button', name: 'Grant' }, 'Grant with no one picked says who is missing and sends nothing', { visible: [seen('Pick who the envelope is granted to.')], absent: [row] }, { state: 'refused', proves: 'empty-state' }),
    click({ label: 'Grantee' }, 'Open the grantee list: the initiative\'s people by name', { visible: [{ role: 'option', name: new RegExp(GRANTEE) }] }, { state: 'dialog-open' }),
    click({ role: 'option', name: new RegExp(GRANTEE) }, `Pick ${GRANTEE}`, { visible: [seen(GRANTEE)] }),
    fill({ label: 'Amount (USD)' }, '12.50', 'Type 12.50 as the amount', { visible: [{ label: 'Amount (USD)' }] }),
    click({ role: 'button', name: 'Grant' }, `Grant: ${GRANTEE} holds a $12.50 envelope on this sprint and the form closes`, { visible: [seen('$12.50'), row], hidden: [{ label: 'Amount (USD)' }] }, { writes: true }),
    reload('Reload: the sprint is still open', { url: /[?&]sprint=spr-/, visible: [seen('Steward: Ben Okafor')] }),
    tabClick(env, `Click Envelopes: the $12.50 envelope for ${GRANTEE} is read back from the server beside Ben Okafor's`, { attr: [{ target: env, name: 'aria-selected', value: 'true' }], visible: [seen('Ben Okafor'), row, seen('$12.50')] }, still),
    click(row, 'Revoke asks first: the confirmation names whose envelope goes and says it cannot be undone', { visible: [confirm, { text: new RegExp(`${GRANTEE}'s \\$12\\.50 envelope is removed immediately`), within: confirm }] }, { state: 'dialog-open', proves: 'role-gating' }),
    press('Escape', 'Escape keeps the envelope: the confirmation closes and the row is still there', { hidden: [confirm], visible: [row] }, { proves: 'keyboard' }),
    click(row, 'Revoke asks again', { visible: [confirm] }, { state: 'dialog-open' }),
    click({ role: 'button', name: 'Revoke grant', within: confirm }, `Revoke grant: ${GRANTEE}'s envelope is gone and Ben Okafor's stays`, { hidden: [confirm], absent: [row], visible: [seen('Ben Okafor')] }, { writes: true }),
    reload('Reload: the sprint is still open', { url: /[?&]sprint=spr-/, visible: [seen('Steward: Ben Okafor')] }),
    tabClick(env, 'Click Envelopes: the revoke is read back, only Ben Okafor\'s $10.00 envelope remains', { attr: [{ target: env, name: 'aria-selected', value: 'true' }], visible: [seen('Ben Okafor'), seen('$10.00')], absent: [row] }, still),
    back('Browser Back leaves the sprint and returns to the sprints table', { url: /lens=sprints/, visible: [heading('Sprints')] }),
  ];
  // The shared steps: ... New sprint opens, Escape closes, [the My envelope tile], tab walk, empty world. The writes go between the Escape and the tab walk.
  const steps = [...base.steps.slice(0, nextEsc + 1), ...writes, ...base.steps.slice(nextEsc + 1)];
  return { ...base, scenario: { scope: 'default' }, writes: true, steps };
};

// ── work-write ──────────────────────────────────────────────────────────────
// /comment is a Chat command. Select Chat explicitly from the mode menu;
// the initial mode depends on whether a job card or agent question has focus.
export const olWorkWrite = (role: 'org-leader' | 'sme' = 'org-leader'): JourneyMap => {
  const base = surfaceMap(role, 'work-write');
  const at = base.steps.findIndex((s) => s.name.startsWith('Type a planning note'));
  if (at < 0) throw new Error(`${role}/work-write: the shared steps no longer type a planning note`);
  const mode = { role: 'button', name: /^Composer mode: (Chat|Agent)/, within: { testId: 'initiative-composer' } } as const;
  const toChat: Step[] = [
    click(mode, 'Open the composer mode menu: Chat and Agent are available', { visible: [{ role: 'menuitem', name: /^Chat/ }, { role: 'menuitem', name: /^Agent/ }] }, { state: 'dialog-open', proves: 'keyboard' }),
    click({ role: 'menuitem', name: /^Chat/ }, 'Choose Chat: the composer is now the discussion\'s, and its mode button says so', { visible: [{ role: 'button', name: /Composer mode: Chat/ }], hidden: [{ role: 'menuitem', name: /^Chat/ }] }),
  ];
  return { ...base, steps: [...base.steps.slice(0, at), ...toChat, ...base.steps.slice(at)] };
};

// ── designs ─────────────────────────────────────────────────────────────────
// The list repaints after the URL changes: the row only the wider filter shows is the signal the count is final (as hr-admin).
export const olDesigns = (): JourneyMap => patched('designs', [
  ['Back to all designs', (s) => ({ ...s, expect: { ...(s as { expect: object }).expect, visible: [seen('Session token rotation on tenant switch')] } }) as Step],
]);
