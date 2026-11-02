# Work list consistency — 2026-11-02

The initiative Work tab now uses the same row hierarchy as Overview: a medium
title, a muted monospace item key beneath it, 24px portraits, and aligned owner
and points columns. Kind and status sit on the secondary line. The decorative
story checkmarks and bug squares are removed. Real completion controls remain
available to authorized users without shifting the title edge. Clicking the
owner or row space opens the item; completion and live-run actions remain
independent.

The shared owner is `WorkTableView` in ui-components 2.495.0 (`8fa66d52`, build
`07712c31`). `WorkListItem.reference` carries the public key in both the table
and the selection rail, including key search. Storybook has an Overview/Work
comparison, narrow and long-content examples. The portable audit now checks
work-row typography, height, title insets, owner widths and portraits, with
valid/broken fixtures.

## Related views

- Every initiative's Work tab shares this component and data mapper.
- The work-selection rail uses the same reference beneath its title.
- Overview's Needs attention, Up next and Recent activity already share the
  compact ActionRowList geometry; their layout remains the reference.
- Conversation/person shared-work lists and the communication landing inherit
  the compact ActionRowList size from the root DensityProvider. No per-page
  size overrides are needed.
- Sprint cards remain board cards: they organize work by workflow column and
  are not copies of this flat work list.

## Package integration

The running app already consumed the separate `2.494.0-huddle.4` call UI
candidate. The integration branch `codex/work-list-huddle-integration` preserves
that work beside the stable Work update; `docs/work-list-integration.json` in
the library records the copied source hashes. The original call worktree is
untouched. Integration-only test updates open message action menus before
checking the existing edit/delete/pin/reply behavior.

Consumed package: `2.495.0-huddle.4-work.1`, built at `6cc684c9` on the pushed
integration branch. The stable work-row implementation is on library main.

## Remaining debt

- Replace the combined candidate pin with a stable UI release once the call UI
  branch lands. Keep the existing realtime package pin required by that work.
- ActionRowList striping still uses the previously documented, token-based
  app stylesheet rule; a shared `striped` option remains in the UI queue.
- The related shared-work route `/iq/communication/channels/general?view=shared`
  has separate shell defects: no page-level heading in both themes/widths and
  a 24px right-gutter overflow at 900px. The read-only audit recorded 10 findings
  across four cases in `.scratch/work-list-consistency-2026-11-02/shared-audit`.
  These are not work-row typography findings and remain open.

## Verification

Evidence is kept in `.scratch/work-list-consistency-2026-11-02`. Tests compare
actual Overview/Work title and portrait coordinates at 1440px and 900px in light
and dark themes, cover public-key search and owner-cell navigation, and inspect
every initiative returned by the graph API. Business writes are blocked in the
interaction checks.

- Library main: 1,028 test files passed, plus source/demo type checks and build.
- Combined package: 1,028 test files / 11,286 tests passed (2 existing skips),
  source/demo type checks and production build passed.
- Browser: five cases passed, including all 14 initiatives and the four
  Overview/Work theme-width comparisons. The all-initiative coverage case
  passed again with writes blocked.
- Work-tab audit: four cases, zero findings; deep Work audit: one case,
  zero findings. The separate communication findings above remain open.
- Portable audit mutation suite, skill validator, portal typecheck, work model
  tests and component-discipline checks passed.
- Visually reviewed the 1440px light and 900px dark Observability screenshots.
