// Shared pieces of the access family's maps (docs/access-journeys/PROTOCOL.md).
// Not a map: files starting with `_` are fragments the maps import. Each
// surface's steps are written once here, parameterised by what the role may
// do (the goal doc's Cedar table), so the three roles' maps differ only where
// the separation of duties says they must.
import type { Persona, Step, Target } from '../../../../scripts/journeys/journey-map.ts';

export const REQUESTER: Persona = { user: 'u-rhea', name: 'Rhea Castellanos', tenant: 'access', role: 'requester' };
export const APPROVER: Persona = { user: 'u-omar', name: 'Omar Haddad, Rhea’s manager', tenant: 'access', role: 'approver' };
export const ADMIN: Persona = { user: 'u-priya', name: 'Priya Venkataraman', tenant: 'access', role: 'access-admin' };

export type AccessRole = 'requester' | 'approver' | 'access-admin';
const decides = (r: AccessRole) => r !== 'requester';
const admin = (r: AccessRole) => r === 'access-admin';

/** A link in the shell's navigation (the access rail), by its exact name. */
export const rail = (name: string): Target => ({ role: 'link', name, exact: true, within: { css: '[data-shell-nav]' } });
export const composer: Target = { role: 'textbox', name: / command$/ };
export const rows = (testId: string): Target => ({ css: 'tbody tr', within: { testId } });
export const firstRow = (testId: string): Target => ({ css: 'tbody tr', within: { testId }, nth: 0 });
const search = (name: string): Target => ({ role: 'textbox', name, exact: true });
const NOT_FOUND = /404|Not Found/i;

/** The rail as this role sees it: Approvals for deciders, Configuration for the access admin only. */
export function railGating(role: AccessRole, url: string): Step {
  const present = ['Catalog', 'Requests', ...(decides(role) ? ['Approvals'] : []), ...(admin(role) ? ['Configuration'] : [])];
  const missing = [...(decides(role) ? [] : ['Approvals']), ...(admin(role) ? [] : ['Configuration'])];
  return {
    do: 'navigate', url, audit: false, auditReason: 'the same resting state the first step measured',
    name: `The rail shows ${present.join(', ')}${missing.length ? ` and no ${missing.join(' or ')}` : ''}`,
    proves: 'role-gating', expect: { visible: present.map(rail), absent: missing.map(rail) },
  };
}

/** The command composer on a list page (PROTOCOL step 7): help, one search, a mutation phrase refused with nothing changed. */
export function composerSteps(phrase: string, shows: RegExp | string): Step[] {
  const typing = { audit: false as const, auditReason: 'the composer holds a half-typed command' };
  return [
    { do: 'fill', target: composer, value: 'help', name: 'Type help into the command composer', ...typing },
    { do: 'press', key: 'Enter', target: composer, name: 'Run help: the composer answers with the phrases it understands', state: 'composer-help', expect: { text: [/search|show|open/i] } },
    { do: 'fill', target: composer, value: phrase, name: `Type "${phrase}"`, ...typing },
    { do: 'press', key: 'Enter', target: composer, name: `Run "${phrase}"`, state: 'filtered', expect: { text: [shows] } },
    { do: 'fill', target: composer, value: 'approve req-0001', name: 'Type the mutation phrase "approve req-0001"', ...typing },
    { do: 'press', key: 'Enter', target: composer, name: 'The composer refuses the mutation and says nothing changed', proves: 'role-gating', expect: { text: [/No changes were made/i] } },
  ];
}

/** A list page's search narrowed to nothing: its own empty sentence. */
export const searchEmpty = (box: string, sentence: string): Step => ({
  do: 'fill', target: search(box), value: 'zzzzqq', name: `Search for zzzzqq: the table says "${sentence}"`, state: 'filtered-empty', proves: 'empty-state', expect: { text: [sentence] },
});
export const searchClear = (box: string, table: string): Step => ({
  do: 'fill', target: search(box), value: '', name: 'Clear the search: the rows come back', audit: false, auditReason: 'the resting state again', expect: { count: [{ target: rows(table), min: 1 }] },
});

export const tabWalk = (min: number): Step => ({ do: 'tab-walk', name: 'Tab from the top of the page through every control', proves: 'keyboard', expect: { minVisited: min } });

/** Focus the first row and press Enter: its record opens as a page. */
export const enterRow = (table: string, opens: RegExp): Step => ({
  do: 'press', key: 'Enter', target: firstRow(table), name: 'Press Enter on the first row: its record opens as a page', state: 'row-open', proves: 'keyboard', expect: { url: opens },
});
export const back = (to: string): Step => ({ do: 'back', name: 'Browser Back returns to the list', expect: { url: to } });

/** A record id that does not exist: the record page's own not-found state (the API's 404 is expected in the console). */
export const notFound = (url: string, sentence: RegExp | string): Step => ({
  do: 'navigate', url, name: `Open ${url}: the page says ${sentence instanceof RegExp ? sentence.source : `"${sentence}"`}`, state: 'not-found', proves: 'empty-state', expectConsole: NOT_FOUND, expect: { text: [sentence] },
});

/** A deep link this role may not open: the route sends it back to Requests. */
export const refusedRoute = (url: string, field: string | string[]): Step => ({
  do: 'navigate', url, name: `Type ${url}: the route sends this role back to Requests`, proves: field, expect: { urlNot: new RegExp(`^${url}`), url: '/access/requests' },
});

export const api = (url: string, status: number, field = 'role-gating'): Step => ({ do: 'api', url, name: `GET ${url} answers ${status}`, proves: field, expect: { status } });

/**
 * The steps of each surface, per role, walked as a CLONE of the persona (lane M;
 * no seed personas). A clone carries the persona's grants and person link but
 * its own user id (its own session epoch). For RECORD OWNERSHIP a clone acts as
 * its persona (b9a4471e, 2026-10-15, middleware/src/lib/record-owner.ts,
 * docs/demo-content-goal.md rule 4): a clone of Rhea reads Rhea's requests,
 * audit events and Withdraw; a clone of Omar decides as Omar. These maps were
 * written the day before (ff5f3c2b) and first walked on 2026-10-29, so the
 * requester's "a fresh clone owns nothing" steps were rewritten then to the
 * persona's world. Each map proves the role's gates (rail, routes, controls,
 * API) and the states that world honestly shows. Nothing here writes: the
 * Withdraw and Approve dialogs are opened and dismissed with Escape. A real
 * decision needs a scoped write that reaches no shared mirror
 * (approver/decision-walk.ts).
 */
export const SURFACES = {
  catalog: (role: AccessRole): Step[] => [
    { do: 'navigate', url: '/access/catalog', name: 'Open the catalog', expect: { url: '/access/catalog', visible: [{ role: 'heading', name: 'Catalog', level: 1 }], count: [{ target: rows('access-catalog-table'), min: 1 }] } },
    railGating(role, '/access/catalog'),
    tabWalk(10),
    searchEmpty('Search the catalog', 'No catalog item matches this search and workspace.'),
    searchClear('Search the catalog', 'access-catalog-table'),
    ...composerSteps('search catalog items for pipeline', /1 of \d+ items/),
    { do: 'navigate', url: '/access/catalog', name: 'Reload the catalog', audit: false, auditReason: 'the resting state step 1 measured' },
    enterRow('access-catalog-table', /^\/access\/requests\/new\?item=/),
    back('/access/catalog'),
  ],

  requests: (role: AccessRole): Step[] => {
    const url = admin(role) ? '/access/requests?scope=all' : '/access/requests';
    const steps: Step[] = [
      admin(role)
        ? { do: 'navigate', url, name: 'Open Requests on Everyone’s', expect: { visible: [{ role: 'heading', name: 'Requests', level: 1 }, { testId: 'access-new-request' }], count: [{ target: rows('access-requests-table'), min: 1 }] } }
        // A clone reads its persona's own requests (lib/record-owner.ts): Rhea's four, Omar's expired operator grant.
        : { do: 'navigate', url, name: 'Open Requests: the persona’s own requests, newest first', expect: { visible: [{ role: 'heading', name: 'Requests', level: 1 }, { testId: 'access-new-request' }], count: [{ target: rows('access-requests-table'), min: 1 }] } },
      railGating(role, url),
      { do: 'click', target: { role: 'button', name: /^Filters/ }, name: decides(role) ? 'Open Filters: Whose (mine, reports’, everyone’s) sits beside Status' : 'Open Filters: Status only, no Whose filter', state: 'filters-open', proves: 'role-gating', expect: decides(role) ? { text: ['Whose', 'Status'] } : { text: ['Status'], hidden: [{ text: 'Whose', exact: true }] } },
      { do: 'press', key: 'Escape', name: 'Escape closes the Filters popover and returns focus to Filters', proves: 'keyboard', expect: { focused: { role: 'button', name: /^Filters/ } } },
      api('/api/access/requests?scope=all', decides(role) ? 200 : 403),
      tabWalk(8),
    ];
    if (admin(role)) steps.push(
      searchEmpty('Search requests', 'No request matches this search and status.'),
      searchClear('Search requests', 'access-requests-table'),
      ...composerSteps('show closed requests', /of \d+ requests/),
      { do: 'navigate', url, name: 'Reload Requests', audit: false, auditReason: 'the resting state step 1 measured' },
      enterRow('access-requests-table', /^\/access\/requests\/req-/),
      back(url),
    );
    else steps.push(
      searchEmpty('Search requests', 'No request matches this search and status.'),
      searchClear('Search requests', 'access-requests-table'),
      ...composerSteps('show closed requests', /of \d+ requests/),
    );
    return steps;
  },

  'new-request': (role: AccessRole): Step[] => [
    { do: 'navigate', url: '/access/requests/new', name: 'Open the request form: what, why, for how long, and the request summary', expect: { visible: [{ role: 'heading', name: 'New request', level: 1 }, { role: 'form', name: 'New access request' }] } },
    railGating(role, '/access/requests/new'),
    role === 'requester'
      ? { do: 'navigate', url: '/access/requests/new', name: 'The form never asks who it is for: a requester asks only for herself', proves: 'role-gating', audit: false, auditReason: 'the resting state step 1 measured', expect: { noText: ['Who is it for?', 'Someone who reports to me'] } }
      : { do: 'api', url: '/api/access/requests?scope=reports', name: 'This role may read its reports’ requests, the people it may also request for', proves: 'role-gating', expect: { status: 200 } },
    tabWalk(5),
    { do: 'navigate', url: '/access/requests/new', name: 'With nothing chosen, the summary says what is missing', state: 'incomplete', proves: 'empty-state', audit: false, auditReason: 'the resting state step 1 measured', expect: { text: ['Choose a catalog item to see who approves it'] } },
    { do: 'fill', target: { role: 'textbox', name: 'Justification' }, value: 'too short', name: 'A nine-character justification: the counter says 9 of at least 20', state: 'invalid', proves: 'empty-state', expect: { text: ['9 of at least 20 characters'] } },
    { do: 'click', target: { role: 'button', name: 'Submit request' }, name: 'Submit an incomplete request: the form names what is missing and sends nothing', state: 'invalid', proves: 'empty-state', expect: { text: ['Choose what to request from the catalog.'], url: '/access/requests/new' } },
    { do: 'navigate', url: '/access/requests/new?item=bogus', name: 'An unknown ?item= is ignored: the form opens with nothing chosen', state: 'bad-link', proves: 'empty-state', expect: { visible: [{ role: 'heading', name: 'New request', level: 1 }], text: ['Choose a catalog item to see who approves it'] } },
  ],

  request: (role: AccessRole): Step[] => {
    const steps: Step[] = [];
    if (decides(role)) {
      // A clone stands in the access directory as its persona's person (manager, steward), so it decides what the persona decides.
      // The access admin's own step is req-0007's access-admin step (Eli's Org leader request, sod-001 warns):
      // since 6562ff6c (2026-10-15) req-0002's steward step names Vera Green and is no longer escalated to access admins.
      const id = admin(role) ? 'req-0007' : 'req-0001';
      steps.push(
        { do: 'navigate', url: `/access/requests/${id}`, name: admin(role) ? 'Open Eli’s req-0007, whose access-admin step is this access admin’s' : 'Open Rhea’s req-0001, whose manager step is this approver’s', expect: { visible: [{ role: 'heading', level: 1 }, { testId: 'access-request-chain' }] } },
        { do: 'navigate', url: `/access/requests/${id}`, name: 'Your decision is offered on the step this identity may decide, and Withdraw is not (it is not the requester’s)', proves: 'role-gating', audit: false, auditReason: 'the resting state step 1 measured', expect: { visible: [{ testId: 'access-request-decision' }, { testId: 'access-request-approve' }], absent: [{ testId: 'access-request-withdraw' }] } },
        { do: 'click', target: { testId: 'access-request-approve' }, name: 'Approve asks for confirmation first (nothing is decided)', state: 'dialog-open', expect: { visible: [{ role: 'dialog', name: 'Approve this step?' }] } },
        { do: 'press', key: 'Escape', name: 'Escape closes the dialog and focus returns to Approve', proves: 'keyboard', expect: { hidden: [{ role: 'dialog', name: 'Approve this step?' }], focused: { testId: 'access-request-approve' } } },
      );
      if (admin(role)) steps.push({ do: 'navigate', url: '/access/requests/req-0001', name: 'req-0001 waits on its manager step: an access admin reads it but has no decision there', state: 'read-only', proves: 'role-gating', expect: { visible: [{ testId: 'access-request-chain' }], absent: [{ testId: 'access-request-decision' }] } });
    } else steps.push(
      // A clone of Rhea owns Rhea's requests (lib/record-owner.ts), so req-0001 is hers: Withdraw is offered, a decision is not.
      { do: 'navigate', url: '/access/requests/req-0001', name: 'Open req-0001, Rhea’s own request: its approval chain, Withdraw offered, no decision (she is not an approver)', proves: 'role-gating', expect: { visible: [{ role: 'heading', level: 1 }, { testId: 'access-request-chain' }, { testId: 'access-request-withdraw' }], absent: [{ testId: 'access-request-decision' }, { testId: 'access-request-approve' }] } },
      { do: 'click', target: { testId: 'access-request-withdraw' }, name: 'Withdraw asks for confirmation first (nothing is withdrawn)', state: 'dialog-open', expect: { visible: [{ role: 'dialog', name: 'Withdraw this request?' }] } },
      { do: 'press', key: 'Escape', name: 'Escape closes the dialog and focus returns to Withdraw', proves: 'keyboard', expect: { hidden: [{ role: 'dialog', name: 'Withdraw this request?' }], focused: { testId: 'access-request-withdraw' } } },
      { do: 'api', method: 'POST', url: '/api/access/requests/req-0001/steps/1/decide', body: {}, refusal: 'the body carries no decision, which the route rejects even past the gate', name: 'Deciding is refused for a role without DecideAccess', proves: 'role-gating', expect: { status: [403] } },
      { do: 'navigate', url: '/access/requests/req-0007', name: 'Open req-0007, Eli’s request: outside a requester’s read rule, the page says Request not found and shows nothing of it', state: 'not-found', proves: ['role-gating', 'empty-state'], expectConsole: NOT_FOUND, expect: { text: ['Request not found'], noText: ['The Observability dispatches wait'], absent: [{ testId: 'access-request-decision' }, { testId: 'access-request-withdraw' }] } },
      { do: 'tab-walk', name: 'Tab through the not-found page', proves: 'keyboard', expect: { minVisited: 3 } },
    );
    steps.push(notFound('/access/requests/req-missing', 'Request not found'));
    return steps;
  },

  approvals: (role: AccessRole): Step[] => role === 'requester' ? [
    refusedRoute('/access/approvals', ['role-gating', 'empty-state']),
    railGating(role, '/access/requests'),
    api('/api/access/approvals', 403),
    tabWalk(5),
  ] : [
    { do: 'navigate', url: '/access/approvals', name: 'Open the approvals inbox: the steps this identity may decide now', expect: { visible: [{ role: 'heading', name: 'Approvals', level: 1 }], count: [{ target: rows('access-approvals-table'), min: 1 }] } },
    railGating(role, '/access/approvals'),
    api('/api/access/approvals', 200, 'role-gating'),
    tabWalk(5),
    searchEmpty('Search approvals', 'No waiting request matches this search.'),
    searchClear('Search approvals', 'access-approvals-table'),
    ...composerSteps('search approvals for sme', /waiting|of \d+/),
    { do: 'navigate', url: '/access/approvals', name: 'Reload the inbox', audit: false, auditReason: 'the resting state step 1 measured' },
    enterRow('access-approvals-table', /^\/access\/requests\/req-/),
    back('/access/approvals'),
  ],

  policies: (role: AccessRole): Step[] => [
    { do: 'navigate', url: '/access/policies', name: 'Open the separation-of-duties policies', expect: { visible: [{ role: 'heading', name: 'Policies', level: 1 }], count: [{ target: rows('access-policies-table'), min: 1 }] } },
    railGating(role, '/access/policies'),
    tabWalk(6),
    searchEmpty('Search policies', 'No policy matches this search and severity.'),
    searchClear('Search policies', 'access-policies-table'),
    ...composerSteps('search policies for spend', /of \d+/),
    { do: 'navigate', url: '/access/policies', name: 'Reload the policies', audit: false, auditReason: 'the resting state step 1 measured' },
    enterRow('access-policies-table', /^\/access\/policies\/sod-/),
    admin(role)
      ? { do: 'wait', target: { testId: 'access-policy-record' }, name: 'The policy record offers Save to the access admin, disabled until something changes', proves: 'role-gating', expect: { visible: [{ testId: 'access-policy-save' }], disabled: [{ testId: 'access-policy-save' }] } }
      : { do: 'wait', target: { testId: 'access-policy-record' }, name: 'The policy record is read-only: no Save in the DOM', proves: 'role-gating', expect: { absent: [{ testId: 'access-policy-save' }] } },
    notFound('/access/policies/sod-missing', 'Policy not found'),
  ],

  reviews: (role: AccessRole): Step[] => [
    { do: 'navigate', url: '/access/reviews', name: 'Open the review campaigns', expect: { visible: [{ role: 'heading', name: 'Reviews', level: 1 }] } },
    admin(role)
      ? { do: 'navigate', url: '/access/reviews', name: 'New campaign is offered to the access admin', proves: 'role-gating', audit: false, auditReason: 'the resting state step 1 measured', expect: { visible: [{ role: 'button', name: 'New campaign' }] } }
      : { do: 'navigate', url: '/access/reviews', name: 'No New campaign control for this role', proves: 'role-gating', audit: false, auditReason: 'the resting state step 1 measured', expect: { absent: [{ role: 'button', name: 'New campaign' }] } },
    tabWalk(5),
    searchEmpty('Search reviews', 'No campaign matches this search and status.'),
    { do: 'navigate', url: '/access/reviews', name: 'Reload the campaigns', audit: false, auditReason: 'the resting state step 1 measured' },
    { do: 'press', key: 'Enter', target: { css: 'tbody tr', nth: 0 }, name: 'Press Enter on the first campaign: its record opens as a page', state: 'row-open', proves: 'keyboard', expect: { url: /^\/access\/reviews\/rev-/ } },
    notFound('/access/reviews/rev-missing', 'Campaign not found'),
  ],

  audit: (role: AccessRole): Step[] => decides(role) ? [
    { do: 'navigate', url: '/access/audit', name: admin(role) ? 'Open the audit trail: every access event' : 'Open the audit trail: the events of the requests this approver may read', expect: { visible: [{ role: 'heading', name: 'Audit', level: 1 }], count: [{ target: rows('access-audit-table'), min: 1 }] } },
    railGating(role, '/access/audit'),
    api('/api/access/audit', 200),
    tabWalk(6),
    searchEmpty('Search events', 'No event matches this search and kind.'),
    searchClear('Search events', 'access-audit-table'),
    ...composerSteps('search events for submitted', /of \d+ events/),
    { do: 'navigate', url: '/access/audit', name: 'Reload the audit trail', audit: false, auditReason: 'the resting state step 1 measured' },
    enterRow('access-audit-table', /^\/access\/(requests|policies|reviews)\//),
    back('/access/audit'),
  ] : [
    // A clone reads its persona's records (lib/record-owner.ts): the events of Rhea's own requests.
    { do: 'navigate', url: '/access/audit', name: 'Open the audit trail: the events of the requests this requester may read (her own)', proves: 'role-gating', expect: { visible: [{ role: 'heading', name: 'Audit', level: 1 }], count: [{ target: rows('access-audit-table'), min: 1 }] } },
    railGating(role, '/access/audit'),
    api('/api/access/audit', 200),
    tabWalk(5),
    searchEmpty('Search events', 'No event matches this search and kind.'),
    searchClear('Search events', 'access-audit-table'),
    ...composerSteps('search events for submitted', /of \d+ events/),
  ],

  configuration: (role: AccessRole): Step[] => admin(role) ? [
    { do: 'navigate', url: '/access/configuration', name: 'Open Configuration', expect: { visible: [{ testId: 'access-configuration-form' }] } },
    railGating(role, '/access/configuration'),
    { do: 'navigate', url: '/access/configuration', name: 'Save is present and disabled while nothing has changed', proves: 'role-gating', audit: false, auditReason: 'the resting state step 1 measured', expect: { disabled: [{ testId: 'access-configuration-save' }] } },
    { do: 'navigate', url: '/access/configuration', name: 'The form always has values: the catalog items are listed', proves: 'empty-state', audit: false, auditReason: 'the resting state step 1 measured', expect: { count: [{ target: rows('access-config-items'), min: 1 }] } },
    tabWalk(10),
  ] : [
    refusedRoute('/access/configuration', ['role-gating', 'empty-state']),
    railGating(role, '/access/requests'),
    api('/api/access/configuration', 200),
    tabWalk(5),
  ],
} satisfies Record<string, (role: AccessRole) => Step[]>;

export const PAGES: Record<keyof typeof SURFACES, string> = {
  catalog: 'portal/src/pages/access/CatalogPage.tsx,portal/src/pages/access/accessColumns.tsx,portal/src/pages/access/accessCollectionCommands.ts',
  requests: 'portal/src/pages/access/RequestsPage.tsx,portal/src/pages/access/accessColumns.tsx,portal/src/pages/access/accessCollectionCommands.ts',
  'new-request': 'portal/src/pages/access/RequestNewPage.tsx,portal/src/lib/accessRequests.ts',
  request: 'portal/src/pages/access/RequestRecordPage.tsx,portal/src/lib/accessRequests.ts',
  approvals: 'portal/src/pages/access/ApprovalsPage.tsx,portal/src/pages/access/accessCollectionCommands.ts,portal/src/App.tsx',
  policies: 'portal/src/pages/access/PoliciesPage.tsx,portal/src/pages/access/accessCollectionCommands.ts',
  reviews: 'portal/src/pages/access/ReviewsPage.tsx,portal/src/pages/access/ReviewRecordPage.tsx',
  audit: 'portal/src/pages/access/AuditPage.tsx,portal/src/pages/access/accessCollectionCommands.ts',
  configuration: 'portal/src/pages/access/ConfigurationPage.tsx,portal/src/App.tsx',
};

export const GOALS: Record<AccessRole, Record<keyof typeof SURFACES, string>> = {
  requester: {
    catalog: 'Rhea browses what she can request, narrows it, and starts a request for one item without submitting it',
    requests: 'A requester sees her own requests, filters them by status, and is never offered Whose',
    'new-request': 'Rhea opens the wizard to ask for access for herself, and sees what stops her submitting an incomplete request',
    request: 'Rhea reads her own req-0001 and may withdraw it (and backs out), cannot decide it, and cannot read Eli’s req-0007',
    approvals: 'Rhea has no approvals inbox: rail, route and API all refuse it',
    policies: 'Rhea reads the separation-of-duties rules without being able to change them',
    reviews: 'Rhea reads the review campaigns without being able to open or decide one',
    audit: 'A requester reads the audit events of the requests she may see (her own)',
    configuration: 'Rhea has no Configuration: rail and route refuse it, the read the wizard needs stays open',
  },
  approver: {
    catalog: 'Omar browses the catalog and starts a request for one item without submitting it',
    requests: 'An approver sees his own requests and, through Whose, his reports’ and everyone’s he may read',
    'new-request': 'Omar opens the wizard, which may file for a report as well as for himself',
    request: 'An approver reads Rhea’s request and is offered the manager step’s decision (and backs out)',
    approvals: 'An approver works his inbox: only steps he may decide now',
    policies: 'Omar reads the separation-of-duties rules without being able to change them',
    reviews: 'Omar reads the review campaigns without being able to open or decide one',
    audit: 'An approver reads the audit events of the requests he may read',
    configuration: 'Omar has no Configuration: rail and route refuse it',
  },
  'access-admin': {
    catalog: 'Priya browses the catalog and starts a request for one item without submitting it',
    requests: 'Priya reads everyone’s requests and filters them',
    'new-request': 'Priya opens the wizard, which may file for a report as well as for herself',
    request: 'An access admin is offered the decision on her own access-admin step (and backs out), and reads a request whose step is not hers without a decision',
    approvals: 'An access admin works the inbox of steps escalated to access admins',
    policies: 'Priya reads a policy and is offered Save on it',
    reviews: 'Priya reads the campaigns and may open a new one',
    audit: 'Priya reads every access event',
    configuration: 'Priya reads Configuration, whose Save waits for a change',
  },
};

export const PERSONA: Record<AccessRole, Persona> = { requester: REQUESTER, approver: APPROVER, 'access-admin': ADMIN };

// ── Isolation (PROTOCOL "Isolation logs") ─────────────────────────────────

const anchorsTo = (prefix: string): Target => ({ css: `a[href^="${prefix}"]` });
const FORBIDDEN = /403|Forbidden/i;
// `noText` names content of the tenant the identity may NOT reach. Inbound (another tenant's role
// typing an /access URL) it is access content; outbound the redirect lands on the identity's own
// access pages, where "SME in Work" is honestly its persona's own request (a clone reads as its
// persona, lib/record-owner.ts), so outbound proves the redirect by URL alone.
const ACCESS_CONTENT = ['SME in Work', 'Separation-of-duties'];
const away = (url: string, from: RegExp, field: string, noText: string[] = ACCESS_CONTENT): Step => ({
  do: 'navigate', url, name: `Type ${url}: the route sends this identity away`, state: 'refused', proves: field, expectConsole: FORBIDDEN,
  expect: { urlNot: from, ...(noText.length ? { noText } : {}) },
});
const forbidden = (url: string, field: string): Step => ({ do: 'api', url, name: `GET ${url} answers 403`, proves: field, expect: { status: 403 } });

/** Inbound: a role of another tenant meets the access tenant (no grant in it). */
export function inbound(landing: string): Step[] {
  return [
    { do: 'navigate', url: '/select', name: 'The workspace chooser offers no Access workspace', proves: 'access-tile-visible', expect: { absent: [anchorsTo('/access')], hidden: [{ text: 'Access', exact: true }] } },
    { do: 'navigate', url: landing, name: `The rail on ${landing} holds no link toward /access`, proves: 'access-nav-visible', expect: { absent: [anchorsTo('/access')] } },
    away('/access/requests', /^\/access/, 'direct-route-result'),
    away('/access/requests/req-0001', /^\/access/, 'direct-route-result'),
    away('/access/approvals', /^\/access/, 'direct-route-result'),
    away('/access/configuration', /^\/access/, 'direct-route-result'),
    { do: 'navigate', url: landing, name: 'Back on the home landing, still no link toward /access', proves: 'access-nav-visible', screenshot: 'log', expect: { absent: [anchorsTo('/access')] } },
    forbidden('/api/access/summary', 'api-status'),
    forbidden('/api/access/catalog', 'api-status'),
    forbidden('/api/access/requests', 'api-status'),
    forbidden('/api/access/requests/req-0001', 'api-status'),
    { do: 'api', method: 'POST', url: '/api/access/requests', body: {}, refusal: 'the body names no catalog item, which the route rejects (400) even past the gate', name: 'POST /api/access/requests is refused', proves: ['write-status', 'nothing-written'], expect: { status: 403 } },
    { do: 'api', method: 'POST', url: '/api/access/requests/req-0001/steps/1/decide', body: {}, refusal: 'the body carries no decision, which the route rejects (400) even past the gate', name: 'POST …/req-0001/steps/1/decide is refused', proves: ['write-status', 'nothing-written'], expect: { status: 403 } },
  ];
}
export const INBOUND_CLAIMS = { 'access-tile-visible': 'no', 'access-nav-visible': 'no', 'direct-route-result': 'redirect', 'api-status': '403', 'write-status': '403', 'nothing-written': 'yes — every write probe was refused, and each carried a body the route rejects even past the gate' };

/** Outbound: an access role meets each other tenant. */
export function outbound(): Step[] {
  const foreign = ['/iq', '/admin', '/assessment', '/social', '/pipelines'].map(anchorsTo);
  return [
    { do: 'navigate', url: '/access/requests', name: 'The access rail and page hold no link toward another tenant', proves: 'other-nav-visible', expect: { absent: foreign } },
    { do: 'navigate', url: '/select', name: 'The workspace chooser offers no other workspace', proves: 'other-nav-visible', expect: { absent: foreign } },
    away('/iq/projects', /^\/iq/, 'iq-route-result', []),
    away('/admin/identity/users', /^\/admin/, 'iq-route-result', []),
    forbidden('/api/graph/teams', 'iq-api-status'),
    forbidden('/api/bots', 'iq-api-status'),
    away('/assessment/teams', /^\/assessment/, 'assessment-route-result', []),
    forbidden('/api/assessment/teams', 'assessment-api-status'),
    away('/social/channels', /^\/social/, 'social-route-result', []),
    forbidden('/api/social/channels', 'social-api-status'),
    away('/pipelines/runs', /^\/pipelines/, 'pipelines-route-result', []),
    forbidden('/api/pipelines/runs', 'pipelines-api-status'),
  ];
}
export const OUTBOUND_CLAIMS = Object.fromEntries(['iq', 'assessment', 'social', 'pipelines'].flatMap((t) => [[`${t}-route-result`, 'redirect'], [`${t}-api-status`, '403']]).concat([['other-nav-visible', 'no']]));
export const ISOLATION_PAGES = 'portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx';

/** Why the surface maps walk as the seed persona, not a clone (journey-map.ts `identity`). */
/** POST /api/access/requests/preview computes the chain and the policy check and writes nothing (middleware/src/routes/access.ts). */
export const PREVIEW = [{ path: '/api/access/requests/preview', reason: 'the wizard’s preview computes the approval chain and policy check and writes nothing (routes/access.ts “Writes nothing”)' }];

export const PERSONA_ONLY = 'access records are keyed by user id (requester, beneficiary, decider, actor), so a clone would own no requests and decide no step';
