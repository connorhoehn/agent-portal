// Known layout-cascade violations at adoption (2026-10-07), keyed by the
// inventory route (or its App.tsx pattern for a parameterised route). A
// RATCHET: the sweep fails on any violation not listed here, and on any
// listed one that no longer occurs — remove it then. Never add an entry to
// make the sweep pass; fix the page (docs/layout-cascade.md).
import type { Invariant } from './route-inventory';

export const LAYOUT_CASCADE_BASELINE: Record<string, Invariant[]> = {
  // The work item's title is EditorShell's (doc-editor), whose head is px-5:
  // 20px against the trail's 24px gutter (ui-components queue row,
  // 2026-10-07). Trail→title is 48px since the header band left that gap.
};
