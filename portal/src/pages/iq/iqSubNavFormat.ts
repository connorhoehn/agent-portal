// Pure Prompt Management sub-nav data + the platform-role filter over it.
// Split out of iqSubNavCatalog.ts (which pulls in React hooks and cannot be
// imported under plain `node --test`) so the filter itself is unit-testable
// — see __tests__/iqSubNavCatalog.test.ts, DEFECTS.md #10.

import type { SubNavItem } from '@connorhoehnslalom/ui-components/shared';

// Prompt Management sub-nav — shared across the prompt-ops overview,
// /iq/prompts, /iq/canary, and the audit surfaces.
// Authoring rail. The Library is the front door — a catalog you browse —
// while Studio/Versions/Evals are what you do to ONE asset, and Rollout is
// how it ships. Diff folded into Versions: a diff is a verb on two versions,
// not a destination you navigate to and then pick a prompt in.
// Studio / Versions / Evals / Rollout are platform surfaces (their routes
// wear RequireRole org-leader|hr-admin and the palette lists them for those
// roles only); a member still saw them in this rail and clicked into a
// redirect (member audit, library.md). Browse-group items are for everyone.
// "What is deployed" belongs with them, not with Library — every one of its
// eleven CTAs points at a Studio/Versions/Evals/Rollout route that bounces a
// member, so it moved out of Browse and into the platform-only set
// (DEFECTS.md #10).
export const PROMPT_MGMT_PLATFORM_GROUPS = new Set(['Ops', 'Author', 'Ship']);
export const PROMPT_MGMT_ITEMS: SubNavItem[] = [
  { path: '/iq/library',              label: 'Library',         hint: 'Every prompt, evaluator, skill and insight', group: 'Browse' },
  { path: '/iq/prompt-ops',           label: 'What is deployed', hint: 'Live prompts + what to do next',    group: 'Ops' },
  { path: '/iq/prompts',              label: 'Studio',          hint: 'Author, type the contract, test',    group: 'Author' },
  { path: '/iq/history',              label: 'Versions',        hint: 'Version log, diffs, past experiments', group: 'Author' },
  { path: '/iq/evaluations',          label: 'Evals',           hint: 'Judge configuration + pass rates',   group: 'Author' },
  { path: '/iq/canary',               label: 'Rollout',         hint: 'Canary A/B, weights, rollback',      group: 'Ship' },
];

/** Pure filter, split out so the platform-role gate is unit-testable without
 *  mounting the hook (DEFECTS.md #10). `seesScores` is the same platform-role
 *  test the rail and the Explore items already use. */
export function promptMgmtItemsFor(seesScores: boolean): SubNavItem[] {
  return seesScores
    ? PROMPT_MGMT_ITEMS
    : PROMPT_MGMT_ITEMS.filter((i) => !PROMPT_MGMT_PLATFORM_GROUPS.has(i.group ?? ''));
}
