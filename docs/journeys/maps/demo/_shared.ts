// Shared pieces of the demo family's maps (docs/demo-journeys/PROTOCOL.md,
// docs/demo-content-goal.md). Each tenant's map walks the five-minute story a
// peer is shown (docs/demo-content-audit.md § the stories) and asserts the
// story's FACTS are on screen: the cast by name, the records that refer to
// each other, and none of the leaks a peer would notice (raw ids, template
// filler, developer copy). Every page step is also
// measured by the DOM audit at rest (docs/journeys/audit-burndown.tsv owns what is owed).
import type { Persona, Step, Target, Text } from '../../../../scripts/journeys/journey-map.ts';

export const P = {
  vera: { user: 'u-vera', name: 'Vera Green, owner of Auth Migration', tenant: 'orgiq', role: 'org-leader', switchRole: true },
  mia: { user: 'u-mia', name: 'Mia Singh, program owner', tenant: 'orgiq', role: 'program-owner', switchRole: true },
  jonas: { user: 'u-jonas', name: 'Jonas Lindqvist, lead assessor', tenant: 'assessment', role: 'lead-assessor', switchRole: true },
  sana: { user: 'u-sana', name: 'Sana Iqbal', tenant: 'social', role: 'participant' },
  kofi: { user: 'u-kofi', name: 'Kofi Mensah, pipelines operator', tenant: 'pipelines', role: 'operator' },
  rhea: { user: 'u-rhea', name: 'Rhea Castellanos', tenant: 'access', role: 'requester' },
  omar: { user: 'u-omar', name: 'Omar Haddad, Rhea’s manager', tenant: 'access', role: 'approver' },
  priya: { user: 'u-priya', name: 'Priya Venkataraman', tenant: 'access', role: 'access-admin' },
} satisfies Record<string, Persona>;

/** What no demo page may show (rubric b, d, g): raw ids and slugs, ISO stamps, template filler, developer copy. */
export const LEAKS: Text[] = [
  /\b(?:p-\d{3}|u-(?:operator|theo|vera|hr|release|rachel|mia|nora|eli|layla|caleb|asha|jonas|farah|mira|lena|sana|ines|kofi|dara|tomas|rhea|omar|priya))\b/,
  /\bwi-[a-z0-9]+(?:-[a-z0-9]+)+\b/, /\bTEAM-\d{3}\b/, /\b(?:social|orgiq|assessment):(?:ch|dm|team):/,
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, /\b(?:undefined|NaN)\b|\[object Object\]/, /\(\+\d+ more\)/,
  /\b(?:dev:mock|fixture|box-mock-\d+|sess-mock|MOCK_[A-Z_]+)\b/,
];

const measured = { audit: true as const };

/**
 * A fact must be VISIBLE inside the page's content (<main>). Not `{ text }`: the walker checks the first
 * DOM match, and the shell renders hidden copies of titles (the breadcrumb's measuring span), so a title
 * on screen reads as "not visible". `:visible` picks the first match a reader can see.
 */
export const seen = (text: Text): Target => ({
  css: typeof text === 'string'
    ? `main :visible:has-text(${JSON.stringify(text)})`
    : `main :visible:text-matches(${JSON.stringify(text.source)}, "${text.flags.replace(/[^i]/g, '')}")`,
});

/** Open a page of the story and assert its facts are on screen and no leak is. */
export const fact = (url: string, name: string, text: Text[], noText: Text[] = []): Step => ({
  do: 'navigate', url, name, proves: 'story-facts', ...measured, expect: { visible: text.map(seen), noText: [...LEAKS, ...noText] },
});

/** Follow a named link from the current page: the record the story names leads to its page. */
export const follow = (target: Target, url: Text, name: string, text: Text[] = []): Step => ({
  do: 'click', target, name, proves: 'cross-links', ...measured, expect: { url, visible: text.map(seen), noText: LEAKS },
});

export const link = (name: Text): Target => ({ role: 'link', name, within: { css: 'main' } });
