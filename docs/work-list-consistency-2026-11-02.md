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

The tested integration snapshot is now on library main, and the portal consumes
stable **2.496.0** (`49717b8a`, build `f92e8786`), pushed to main. All preserved call-source hashes still match the integration
manifest and original call worktree. This promotes the already-consumed snapshot;
it does not claim that every separate call-workstream task is complete. The
realtime package remains at 0.141.0.

## Debt closed in this follow-up

- Replaced the combined prerelease pin with stable 2.496.0. The tracked tarball,
  lockfile and installed runtime agree; Vite's dependency cache was refreshed.
- Added `ActionRowList.striped` in the library and adopted it in Up next and
  Recent activity. Removed `work-overview-striped-rows` from the app stylesheet.
  Semantic row tones still win; row navigation and default unstriped lists stay
  covered. Storybook includes default, striped, semantic-tone and dark examples.
- Added an explicit page-heading option to `ChannelHeader` and
  `ConversationSurface`, including its runtime wrapper. Embedded Communication
  pages use one 20px h1; embedded chat panels retain their default h2.
  Mixed-size member counts share the heading baseline, and the header tabs align
  to the available edge while narrow layouts keep a separate tab row.
- Corrected the original shared-work audit's scope: `u-operator` was seeing the
  **pre-join screen**, not the joined list. Its reported 24px description overflow
  was a measurement error: DOM Range included text clipped by its own ellipsis.
  The portable audit now clips that text to its actual element. A valid clipped
  fixture and a failing unclipped neighbor prevent either a false alarm or an
  overflow exemption.
- Kept the page heading in channel loading, error and missing states. The
  loading state is compact, and errors show a useful retry message instead of
  raw server text. The audit recognizes these explicit unavailable states.
- Checked the joined Shared work view separately as a clone of `u-theo`. Added
  its missing page gutter and suppressed graph badges that repeat the first
  detail line verbatim. A different badge remains visible. Graph failures use
  their natural height instead of leaving a fixed-height blank area.

The original follow-ups — stable package, shared striping, and the shared-work
heading/gutter — are closed. The deeper audit has separate follow-ups below;
this report is not a whole-application certification.

## Further audit findings

The full deep sweep of joined Shared work (dark, 900px) exercised 18 states.
The six data states (empty, error, loading, long, many, denied) now pass. The
final report retains four findings in `shared-deep-confirmed`:

- Two `align.grid` candidates in the **Chat transcript** reached by cycling the
  conversation tabs: message text starts 36px inside the reading edge and the
  action controls end 8px inside it. This is the avatar/message layout, not an
  initiative or shared-work list. Review its intended row profile in the shared
  ChatPanel/MessageRow before changing spacing or declaring an audit exclusion.
- Two `coverage.stability` results on the focus walk and design-reviews menu.
  Those measurements changed between samples on the live surface; they remain
  unverified, not passed. Repeat with isolated presence/activity input before
  accepting a deterministic result. Do not relax the contract or reset shared
  user state to make them pass.

Reproduce the joined view with `portal/e2e/shared-work-audit.adapter.ts` and
`UI_DOM_AUDIT_CLONES=1`; it uses a clone of existing member `u-theo`, while the
normal adapter covers the pre-join administrator. The same portable contract
is used by both. Other backlog items remain in `docs/ui-components-queue.md`.

## Verification

Evidence is kept in `.scratch/work-list-consistency-2026-11-02`. Tests compare
actual Overview/Work title and portrait coordinates at 1440px and 900px in light
and dark themes, cover public-key search and owner-cell navigation, and inspect
every initiative returned by the graph API. Business writes are blocked in the
interaction checks.

- Library: 1,028 test files / 11,290 tests passed (2 existing skips), plus
  source/demo type checks and production build. Installed entry files and CSS
  match the committed dist; the tarball matches the lockfile integrity.
- Browser: the existing five Work cases cover all 14 initiatives, public-key
  search, owner-cell navigation and Overview/Work geometry in light/dark at
  1440px and 900px. Four additional cases exercise pre-join and joined channel
  headings, shared-row typography, page gutters and overview striping. All nine
  passed on the stable package; the four related-view cases passed again after
  the final loading/error-state adjustments.
- Joined `#general` currently has no shared list items. The browser checks the
  real empty state first, then intercepts only its own GET response with a
  populated row to verify typography. No messages, grants or memberships are
  written. This is layout coverage, not a new claim of backend share behavior.
- Portable audit mutation suite, skill validator, portal typecheck and component
  discipline checks pass. Final reports and screenshots remain under the same
  evidence directory.
- Pre-join audit: four cases, zero findings, all 10 original findings resolved
  (including correction of the two false overflow measurements). Joined member
  and Work release matrices each pass four cases with zero findings and zero
  unclassified composer policies; see `member-release-audit` and
  `work-release-audit` in the evidence directory.
- Visually reviewed final wide Work and narrow dark Shared work screenshots,
  including the populated list fixture and graph failure state.
