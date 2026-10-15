// Shared pieces of the runbooks family's maps (docs/runbooks-journeys/PROTOCOL.md,
// docs/distillation-runbooks-goal.md R6). Three roles walk the runbook loop on the
// seeded Auth Migration runbooks (middleware/src/mock/runbooks.seed.ts): an author
// suggests a change or reads what a run proposed, a reviewer decides it, a consumer
// reads a runbook and the brief a run is handed. Every page step is measured by the
// DOM audit. Walked as clones of the persona, never in the user's Chrome.
import type { Expect, Persona, Step, Target, Text } from '../../../../scripts/journeys/journey-map.ts';

export const P = {
  theo: { user: 'u-theo', name: 'Theo Chang', tenant: 'orgiq', role: 'member' },
  nora: { user: 'u-nora', name: 'Nora DaSilva, SME on Auth Migration', tenant: 'orgiq', role: 'sme', switchRole: true },
  vera: { user: 'u-vera', name: 'Vera Green, owner of Auth Migration', tenant: 'orgiq', role: 'org-leader', switchRole: true },
} satisfies Record<string, Persona>;

/** What no runbooks page may show a reader: raw store ids in prose, ISO stamps, template filler, developer copy. */
export const LEAKS: Text[] = [
  /\b(?:undefined|NaN)\b|\[object Object\]/, /\(\+\d+ more\)/, /\bLoad-corpus\b/,
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, /\b(?:dev:mock|fixture|MOCK_[A-Z_]+)\b/,
];

const measured = { audit: true as const };

/** Visible inside the page's content (<main>), the first match a reader can see. */
export const seen = (text: Text): Target => ({
  css: typeof text === 'string'
    ? `main :visible:has-text(${JSON.stringify(text)})`
    : `main :visible:text-matches(${JSON.stringify(text.source)}, "${text.flags.replace(/[^i]/g, '')}")`,
});

/** Open a page and assert what it shows, and that no leak is on it. `extra.expect` adds to the expectation. */
export const page = (url: string, name: string, text: Text[], extra: { expect?: Expect; expectConsole?: RegExp } = {}): Step => ({
  do: 'navigate', url, name, proves: 'shows', ...measured, ...(extra.expectConsole ? { expectConsole: extra.expectConsole } : {}),
  expect: { ...extra.expect, visible: [...text.map(seen), ...(extra.expect?.visible ?? [])], noText: [...LEAKS, ...(extra.expect?.noText ?? [])] },
});

export const RUNBOOK = {
  cutover: { id: 'rb-tenant-cutover', title: 'Cut one tenant over from SAML to Cognito' },
  sso: { id: 'rb-sso-new-origin', title: 'Bring SSO up on a new origin without breaking the picker' },
} as const;

export const PROPOSAL_FROM_RUN = 'prop-tenant-cutover-callback';

export const SURFACE_PAGES = 'portal/src/pages/runbooks, middleware/src/routes/runbooks.ts';

/**
 * The proposal page's diff (ui-components DiffViewer) logs React's missing-key warning on every render: the
 * library keys the inner <tr> of each line's Fragment instead of the Fragment. The page cannot key it (the
 * rows are the library's); the fix is queued in docs/ui-components-queue.md ("DiffViewer is not render-clean").
 * Delete this and the expectConsole uses when the pinned ui-components fixes it.
 */
export const DIFF_KEY_WARNING = /unique "key" prop/;
