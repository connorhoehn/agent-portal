// program-owner-specific fragments of the work family (docs/work-journeys-goal.md). Where the shared / admin generators
// assume a role either holds ManageDevbox (and sees the fleet, the review queue and its policies) or sees the same pages
// read-only, a program owner's pages are different: its clone is on no initiative with a computer, so the Computer Lab is
// empty, and the review queue is unreadable (GET /api/sdlc/changes is ManageDevbox-gated), so the page says so.
import type { Expect, JourneyMap, Step, Target } from '../../../../scripts/journeys/journey-map.ts';
import { PERSONA, STILL, api, click, dialog, fill, open, press, readOnlyPostsFor, reload, scoped, seen, surfaceMap, tabClick, tabNamed, tabWalk, LEAKS, type Role } from './_shared.ts';

const ROLE: Role = 'program-owner';
const h1 = (name: string): Target => ({ role: 'heading', name, level: 1 });
const selected = (t: Target): Expect => ({ attr: [{ target: t, name: 'aria-selected', value: 'true' }] });

function mapOf(journey: string, goal: string, pages: string, steps: Step[]): JourneyMap {
  return {
    family: 'work', log: `${ROLE}/${journey}`, kind: 'surface', persona: PERSONA[ROLE], scenario: 'shared', identity: 'clone', ...readOnlyPostsFor(ROLE),
    viewport: { width: 1440, height: 900 }, goal: `${PERSONA[ROLE].name}: ${goal}`, fields: { surface: journey, pages }, steps,
  };
}

// ── changes-review ──────────────────────────────────────────────────────────
// The catalog row asks for Review queue and Policies, a change opened, and an empty queue. This role holds neither the queue
// nor Policies (both ManageDevbox): the page keeps the Review queue tab, says the queue is unreadable (not empty) and offers
// no Policies tab, no row to open and no empty world, which would read the same denial.
export function poChangesReview(): JourneyMap {
  const queue = tabNamed(/^Review queue/);
  const DENIED = seen('You cannot see the review queue');
  const strip = (): Target[] => [STILL.header, { role: 'tablist' }, h1('Changes')];
  return mapOf('changes-review', 'Code review: this role cannot read the review queue, and the page says so instead of showing an empty one', 'portal/src/pages/admin/ChangesPage.tsx', [
    open('/admin/changes', 'Open Changes: the page says the queue is unreadable (not empty), offers only the Review queue tab and no decision buttons', {
      url: '/admin/changes', visible: [h1('Changes'), queue, DENIED, seen(/Reading change requests requires computer access/)], ...selected(queue),
      absent: [tabNamed('Policies'), { role: 'button', name: 'Approve' }, { role: 'button', name: 'Reject' }, { role: 'link', name: /Review diff/ }],
    }, { facts: true, state: 'default', proves: ['story-facts', 'role-gating'], expectConsole: /403|Forbidden/ }),
    api('/api/sdlc/changes', 403, 'GET /api/sdlc/changes answers 403: the review queue needs ManageDevbox, which this role does not hold', 'role-gating'),
    fill({ role: 'textbox', name: 'Search changes', exact: true }, 'dedup', 'Search dedup: the denial stays, the search finds nothing to filter', { visible: [DENIED] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill({ role: 'textbox', name: 'Search changes', exact: true }, '', 'Clear the search: the same sentence', { visible: [DENIED] }),
    tabClick(queue, 'Click the Review queue tab (the only tab this role has): it stays selected and the header and tab strip stay put', { ...selected(queue), visible: [DENIED] }, strip(), { proves: ['tab-stability', 'role-gating'] }),
    { do: 'wait', target: { role: 'tablist' }, name: 'There is no Policies tab for this role: governance rules need ManageDevbox', proves: 'role-gating', expect: { absent: [tabNamed('Policies')], visible: [queue] } } as Step,
    open('/admin/changes/00000000-0000-0000-0000-000000000000', 'A change opened by its link is refused too: the page says this role cannot review it, with no diff and no Approve or Reject', { visible: [h1('Change review'), seen('You cannot review this change'), { role: 'button', name: 'Back to the queue' }], absent: [{ role: 'button', name: 'Approve' }, { role: 'button', name: 'Reject' }] }, { state: 'row-open', proves: 'empty-state', expectConsole: /403|404|Forbidden|Not Found/ }),
    press('Enter', 'Enter on Back to the queue returns to the queue page', { url: '/admin/changes', visible: [h1('Changes'), DENIED] }, { target: { role: 'button', name: 'Back to the queue' }, proves: 'keyboard' }),
    tabWalk(6),
    scoped({ scenario: 'empty', fixture: 'sdlc-changes' }, '/admin/changes', 'In a world with no changes the page still says the queue is unreadable: the denial comes before the data', 'empty', { visible: [DENIED] }, { expectConsole: /403|Forbidden/ }),
  ]);
}

// ── devbox ──────────────────────────────────────────────────────────────────
// The clone belongs to no initiative with a computer in the (unscoped, in-memory) fleet, so the lab lists none and says so;
// the viewer sentence is the role gate. Tolerant of the fleet drifting: it asserts the relations, not the names.
export function poDevbox(): JourneyMap {
  const fleet = { role: 'tablist', name: 'Fleet' } as Target;
  const computers = tabNamed(/^Computers/);
  const agents = tabNamed(/^Agents/);
  const VIEWER = /You can see the fleet but not drive it/;
  const find = { placeholder: 'Find computer or agent…' } as Target;
  const header = seen(/^\d+ computers · \d+ agents$/);
  return mapOf('devbox', 'The computer lab: this role can see the fleet but not drive it, and the sentence says who can grant that; a filter that finds nothing', 'portal/src/pages/admin/DevboxPage.tsx, portal/src/components/compute/ComputeHost.tsx', [
    open('/admin/devbox', 'Open the Computer Lab: the viewer sentence says computer access is an SME\'s or an operator\'s to grant, and the header count agrees with the Computers tab', {
      url: '/admin/devbox', visible: [computers, agents, seen(VIEWER), header],
      numbers: [{ of: computers, re: /(\d+)/, eqNumberOf: header, reOther: /^(\d+)/ }],
    }, { facts: true, proves: ['story-facts', 'role-gating'] }),
    api('/api/devbox/boxes', 200, 'This role may read the fleet: GET /api/devbox/boxes answers 200'),
    tabClick(agents, 'Click the Agents view: the agent count agrees with the header and the page header stays put', { ...selected(agents), numbers: [{ of: agents, re: /(\d+)/, eqNumberOf: header, reOther: /· (\d+) agents/ }] }, [STILL.header, fleet], { proves: ['tab-stability', 'story-facts'], state: 'filtered' }),
    tabClick(computers, 'Click the Computers view: the fleet list is back', { ...selected(computers), visible: [seen(VIEWER)] }, [STILL.header, fleet]),
    press('Enter', 'Enter on the Agents tab (focused by the key press) selects it', { ...selected(agents), focused: agents }, { target: agents, proves: 'keyboard' }),
    click(computers, 'Back to the Computers view with the mouse', { ...selected(computers) }),
    fill(find, 'zzzzqq', 'Find zzzzqq: the lab says nothing matches or that it holds no computers, never a blank rail', { visible: [seen(/Nothing matches\.|No computers in the lab/)] }, { state: 'filtered-empty', proves: 'empty-state' }),
    fill(find, '', 'Clear the find box: the viewer sentence and the count are still there', { visible: [seen(VIEWER), header] }),
    tabWalk(8),
  ]);
}

// ── surface patches (as _hradmin.ts does) ───────────────────────────────────
type Patch = (s: Step) => Step | null;
function patched(journey: string, edits: Array<[string | RegExp, Patch]>, opts: Partial<JourneyMap> = {}): JourneyMap {
  const base = surfaceMap(ROLE, journey, opts);
  const hit = new Set<number>();
  const match = (n: string | RegExp, name: string) => (typeof n === 'string' ? name.includes(n) : n.test(name));
  const steps = base.steps.flatMap((s) => {
    const i = edits.findIndex(([n]) => match(n, s.name));
    if (i < 0) return [s];
    hit.add(i);
    const out = edits[i]![1](s);
    return out ? [out] : [];
  });
  edits.forEach(([n], i) => { if (!hit.has(i)) throw new Error(`program-owner/${journey}: no step matches ${String(n)}`); });
  return { ...base, steps };
}
const sprintTabs: Target = { role: 'tablist', name: 'Sprint detail sections' };

// ── sprints ─────────────────────────────────────────────────────────────────
// A program owner holds ManageSprints and ManageBudgets, so the sprint's Envelopes tab is theirs: grant an SME an envelope and
// revoke it, in a scoped world, each read back after a reload. It holds no sprint grant itself, so there is no "My envelope" tile.
export function poSprints(): JourneyMap {
  const STILL_ = [STILL.header, sprintTabs];
  const grantBtn: Target = { role: 'button', name: '+ Grant envelope' };
  const grantee: Target = { label: 'Grantee' };
  const amount: Target = { label: 'Amount (USD)' };
  const revokeBtn: Target = { role: 'button', name: 'Revoke envelope for Theo Chang' };
  const revoke = dialog('Revoke grant?');
  const theoRow: Target = { css: 'main tbody tr:has-text("Theo Chang")' };
  const toEnvelopes = (name: string, expect: Expect): Step => tabClick(tabNamed('Envelopes', sprintTabs), name, { ...selected(tabNamed('Envelopes', sprintTabs)), ...expect }, STILL_);
  const writes: Step[] = [
    click(grantBtn, '+ Grant envelope opens the grant form: grantee, amount and note (nothing is granted yet)', { visible: [amount, { role: 'button', name: 'Grant', exact: true }] }, { state: 'dialog-open', proves: 'role-gating' }),
    press('Escape', 'Escape cancels the form and focus returns to + Grant envelope', { hidden: [amount], focused: grantBtn, visible: [seen('Ben Okafor')] }, { proves: 'keyboard' }),
    click(grantBtn, 'Open the grant form again', { visible: [amount] }, { state: 'dialog-open' }),
    fill(amount, '25', 'Type a 25 dollar envelope', { visible: [amount], focused: amount }),
    click({ role: 'button', name: 'Grant', exact: true }, 'Grant with no grantee picked refuses with its sentence and creates nothing', { visible: [seen('Pick who the envelope is granted to.'), amount], count: [{ target: theoRow, eq: 0 }] }, { state: 'refused', proves: 'role-gating' }),
    click({ role: 'button', name: 'Cancel', exact: true }, 'Cancel closes the form: nothing was granted', { hidden: [amount], visible: [grantBtn, seen('Ben Okafor')], count: [{ target: theoRow, eq: 0 }] }),
    // The grantee is a native <select>, which the headless runner cannot drive (no selectOption step, and keys do not move a closed select): the grant itself is POST /api/grants, the call the form makes.
    { ...api('/api/grants', [200, 201], 'Grant Theo Chang, an SME on Design System API, a 25 dollar envelope on this sprint: POST /api/grants (the form\'s own call, since the runner cannot pick from a native select)', 'role-gating', { method: 'POST', body: { initiativeId: 'p-design-system-api', sprintId: 'spr-dsapi-s1', granteePersonId: 'p-001', amountUsd: 25 } }), writes: true } as Step,
    reload('Reload: the sprint is still open', { url: /[?&]sprint=spr-dsapi-s1/, visible: [seen('Steward: Ben Okafor')] }),
    toEnvelopes('Click Envelopes: the new envelope was read back from the server, 25 dollars for Theo Chang', { visible: [seen('Theo Chang'), seen('$25.00'), seen('Ben Okafor')], count: [{ target: theoRow, eq: 1 }], noText: LEAKS }),
    click(revokeBtn, 'Revoke on Theo Chang\'s envelope asks first and names the envelope', { visible: [revoke, { text: /Theo Chang.s \$25\.00 envelope is removed immediately/, within: revoke }] }, { state: 'dialog-open', proves: 'role-gating' }),
    press('Escape', 'Escape keeps the envelope: the dialog closes and the row is still there', { hidden: [revoke], visible: [seen('Theo Chang')] }, { proves: 'keyboard' }),
    click(revokeBtn, 'Open Revoke again to confirm it', { visible: [revoke] }, { state: 'dialog-open' }),
    click({ role: 'button', name: 'Revoke grant', exact: true, within: revoke }, 'Revoke grant: Theo Chang\'s envelope is gone and Ben Okafor\'s is untouched', { hidden: [revoke], count: [{ target: theoRow, eq: 0 }], visible: [seen('Ben Okafor')] }, { writes: true }),
    reload('Reload after the revoke: the sprint is still open', { url: /[?&]sprint=spr-dsapi-s1/, visible: [seen('Steward: Ben Okafor')] }),
    toEnvelopes('Click Envelopes: the revoke was read back, only Ben Okafor holds an envelope', { visible: [seen('Ben Okafor')], count: [{ target: theoRow, eq: 0 }] }),
  ];
  const base = patched('sprints', [
    [/^Click Envelopes on the sprint/, (s) => ({ ...s, name: 'Click Envelopes on the sprint: Ben Okafor\'s envelope and + Grant envelope, held in place', expect: { ...(s as { expect: object }).expect, visible: [seen('Ben Okafor'), grantBtn] } }) as Step],
    [/^The "My envelope" tile/, () => ({ do: 'wait', target: seen(/active sprints?/), name: 'This role holds no sprint grant of its own, so the summary has no My envelope tile', state: 'default', proves: 'role-gating', expect: { absent: [{ role: 'button', name: /my envelope/i }], visible: [seen(/active sprints?/)] } }) as unknown as Step],
    [/^In a world with no sprints/, (s) => ({ ...s, name: 'In a world with no sprints the page says so and that none is active', expect: { visible: [seen('No sprints'), seen(/No sprint is active right now|No initiative has sprints yet/)], count: [{ target: { css: 'main tbody tr' }, eq: 0 }] } }) as Step],
  ], { scenario: { scope: 'default' }, writes: true });
  // The write steps sit after the Envelopes tab, before Back leaves the sprint.
  const at = base.steps.findIndex((s) => s.name.startsWith('Browser Back leaves the sprint'));
  if (at < 0) throw new Error('program-owner/sprints: shared steps lost their Back step');
  const steps = base.steps.slice();
  steps.splice(at, 0, ...writes);
  // Escape after the (removed) tile dialog has nothing to close: drop that shared step with the tile.
  const esc = steps.findIndex((s, i) => i > at && s.name === 'Escape closes it and focus returns to where it was' && (steps[i - 1] as Step).name.startsWith('This role holds no sprint grant'));
  if (esc >= 0) steps.splice(esc, 1);
  return { ...base, steps };
}

// ── prepare-job ─────────────────────────────────────────────────────────────
// The shared dispatcher flow is an SME's: grant-scoped, refused with "No sprint grant here" where she holds none. A program
// owner is not grant-scoped (the envelope line reads "Not braked by an envelope") so it dispatches anywhere; the run-cap brake
// and Dispatch anyway are the same, and the ungranted-initiative refusal does not apply.
export function poPrepareJob(): JourneyMap {
  const DECK: Target = { css: '[data-composer-prompt-deck="expanded"]' };
  const menu: Target = { testId: 'initiative-header-menu-trigger' };
  const base = surfaceMap(ROLE, 'prepare-job');
  const at = base.steps.findIndex((s) => s.name.startsWith('Open a work item on an initiative where this sme holds no grant'));
  const end = base.steps.findIndex((s) => s.do === 'tab-walk');
  if (at < 0 || end < at) throw new Error('program-owner/prepare-job: shared dispatcher lost its ungranted tail');
  const url = '/iq/projects/p-zero-trust?item=wi-zt-e1-s2';
  const tail: Step[] = [
    open(url, 'Open a work item on an initiative with no sprint grant for anyone here: a program owner is not grant-scoped', { url, visible: [{ role: 'heading', name: 'mTLS rollout plan with break-glass procedure', level: 1 }], noText: LEAKS }, { facts: true }),
    click(menu, 'Open the header menu: it offers Prepare job', { visible: [{ role: 'menuitem', name: 'Prepare job' }] }, { proves: 'role-gating' }),
    click({ role: 'menuitem', name: 'Prepare job' }, 'Prepare job opens the card; its envelope line says no envelope brakes this role and no sprint grant is asked for', { visible: [DECK, { text: 'Not braked by an envelope', within: DECK }], absent: [{ text: 'No sprint grant here' }, { text: 'Needs dispatch rights' }] }, { state: 'dialog-open', proves: 'role-gating' }),
    press('Escape', 'Escape folds the card without dispatching: nothing is sent', { hidden: [DECK] }, { proves: 'keyboard' }),
  ];
  const steps = [...base.steps.slice(0, at), ...tail, ...base.steps.slice(end)].map((s): Step => ({ ...s, name: s.name.replace('this sme holds a sprint grant', 'a program owner dispatches').replace('this sme', 'this program owner') }) as Step);
  return { ...base, steps };
}
