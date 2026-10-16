// Shared pieces of the search family's maps (docs/user-search-journeys/PROTOCOL.md,
// docs/user-search-goal.md judge 5). Each map walks one top catalog intent
// (portal/e2e/user-search-catalog.ts, `map: true`) as a clone of the role's
// seed persona: ask the question where the person would, see the answer, open
// the record it names — in at most two clicks. Content walks: the layout
// judges own the DOM audit.
import type { Persona, Step, Target, Text } from '../../../../scripts/journeys/journey-map.ts';

export const P = {
  theo: { user: 'u-theo', name: 'Theo Chang', tenant: 'orgiq', role: 'member' },
  nora: { user: 'u-nora', name: 'Nora DaSilva', tenant: 'orgiq', role: 'sme', switchRole: true },
  asha: { user: 'u-asha', name: 'Asha', tenant: 'assessment', role: 'assessor' },
  jonas: { user: 'u-jonas', name: 'Jonas Lindqvist', tenant: 'assessment', role: 'lead-assessor', switchRole: true },
  sana: { user: 'u-sana', name: 'Sana Iqbal', tenant: 'social', role: 'participant' },
  lena: { user: 'u-lena', name: 'Lena', tenant: 'social', role: 'moderator' },
  mira: { user: 'u-mira', name: 'Mira Okafor', tenant: 'social', role: 'community-admin' },
  ines: { user: 'u-ines', name: 'Ines', tenant: 'pipelines', role: 'author' },
  kofi: { user: 'u-kofi', name: 'Kofi Mensah', tenant: 'pipelines', role: 'operator' },
  dara: { user: 'u-dara', name: 'Dara', tenant: 'pipelines', role: 'pipeline-admin' },
  rhea: { user: 'u-rhea', name: 'Rhea Castellanos', tenant: 'access', role: 'requester' },
  omar: { user: 'u-omar', name: 'Omar Haddad', tenant: 'access', role: 'approver' },
  priya: { user: 'u-priya', name: 'Priya Venkataraman', tenant: 'access', role: 'access-admin' },
} satisfies Record<string, Persona>;

export const quiet = { audit: false as const, auditReason: 'a content walk: the layout judges (cascade, type-scale, ui-dom-audit) measure this page' };

/** Visible inside the page's content (<main>), the first match a reader can see. */
export const seen = (text: Text): Target => ({
  css: typeof text === 'string'
    ? `main :visible:has-text(${JSON.stringify(text)})`
    : `main :visible:text-matches(${JSON.stringify(text.source)}, "i")`,
});

/** The Work search page with the question asked (the Results tab). */
export const searchUrl = (q: string) => `/iq/search?${new URLSearchParams({ q, tab: 'results' })}`;

/** Ask: open the entry point with the question and see the answer on screen. */
export const ask = (url: string, name: string, answer: Text[]): Step => ({
  do: 'navigate', url, name, proves: 'answers-question', expect: { visible: answer.map(seen) },
});

/** Open: follow the record the answer names; the record's page is where it lands. */
export const open = (target: Target, url: Text, name: string, facts: Text[] = []): Step => ({
  do: 'click', target, name, proves: 'record-open', ...quiet, expect: { url, visible: facts.map(seen) },
});

/** A search result row's link, by the record title it shows. */
export const result = (title: Text): Target => ({
  text: title, nth: 0,
  // The walker scopes to the FIRST match of `within`, so the row is picked by its own text, then its title clicked.
  within: { css: typeof title === 'string' ? `main [data-record-key]:has-text(${JSON.stringify(title)})` : `main [data-record-key]:has(:text-matches(${JSON.stringify(title.source)}, "i"))` },
});
export const link = (name: Text): Target => ({ role: 'link', name, within: { css: 'main' } });
/** The first record link in a list page's table (the page's row-title link), for answers whose row text is content the fixtures own. */
export const firstRowLink = (tableTestId: string): Target => ({ css: `main [data-testid="${tableTestId}"] a`, nth: 0 });

/** Why a mapped intent is not walked yet: the phase that gives the tenant the surface. */
export const HOLD = {
  palette: 'S3 (U8): the palette has no record group yet, so a record cannot be reached from it; the map is walked once the ui-components record-results section is pinned and wired',
  tenantSearch: 'S2 landed the tenant index, but the page does not yet answer on screen: re-walked 2026-10-16 and the list search does not surface the record, or the row does not link to its record page (no catalog/queue/run/team record routes in the tenant); the map is walked once the S3 list-page server-search fallback and record links land',
};

/** The palette path (U8): open it on a tenant page, type the question, take the record option. */
export const palette = (route: string, q: string, option: RegExp, lands: RegExp): Step[] => [
  ask(route, 'Start on the page the person would open the palette from', []),
  { do: 'press', key: 'Control+k', name: 'Open the command palette', ...quiet },
  { do: 'fill', target: { testId: 'command-palette-input' }, value: q, name: `Type “${q}”`, proves: 'answers-question', ...quiet,
    expect: { visible: [{ css: `[data-testid="command-palette"] [cmdk-item]:text-matches(${JSON.stringify(option.source)}, "i")` }] } },
  { do: 'press', key: 'Enter', target: { testId: 'command-palette-input' }, name: 'Take the record option', proves: 'record-open', ...quiet, expect: { url: lands } },
];

/** A list page's own search box: type the keyword the catalog names, see the row. */
export const listSearch = (route: string, placeholder: string, q: string, answer: Text[]): Step[] => [
  ask(route, 'Open the list page', []),
  { do: 'fill', target: { placeholder }, value: q, name: `Search the list for “${q}”`, proves: 'answers-question', ...quiet, expect: { visible: answer.map(seen) } },
];

/** A list page's command composer: type the bounded command the catalog names, see the narrowed rows. */
export const composer = (route: string, command: string, answer: Text[]): Step[] => [
  ask(route, 'Open the list page', []),
  { do: 'fill', target: { css: '[data-testid="collection-command-host"] [contenteditable="true"]' }, value: command, name: `Type “${command}” into the page’s command box`, ...quiet },
  { do: 'press', key: 'Enter', target: { css: '[data-testid="collection-command-host"] [contenteditable="true"]' }, name: 'Run the command', proves: 'answers-question', ...quiet, expect: { visible: answer.map(seen) } },
];
