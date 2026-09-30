# Rail parity — every second rail is the concise stacked rail

**Judge:** `scripts/validate-rail-parity.sh` (`--quick` skips the Playwright
measurement). It exits 0 only when every check passes and prints every
failing line.

## The ask (2026-09-29)

The Org tenant's pages with a second navigation column — `/iq/library`,
`/iq/distillation`, the initiative explorer — draw it as a **concise stacked
rail**: an 11px caps caption ("AGENT LIBRARY"), collapsible groups with a
plain count ("KIND 6"), plain 13px/500 rows on the rail pitch with a
right-aligned count, the current row tinted, no card chrome, about 220px
wide (`StackedCatalogLayout` → `ExplorerLayout` + `RailSection` +
`RailNavList`). The Assessment workspace (`/assessment/workspace`) and
realtime-examples' `/documents` drew a different family instead: a wide
card panel with folder and page icons, ages, presence avatars and 36px
`TreeView` rows. The user wants one layout format across both apps, so the
documents rails move onto the Org rail's family.

## Decisions

1. **One composite, in the library.** `StackedRail` (ui-components) is the
   documents rail for both apps: title + actions, groups with count /
   collapse / a presence slot, nested rows with a right meta (a count or an
   age), a hover row menu, drag pass-through, keyboard navigation. A
   `StackedRail` row is pixel-identical to a `RailNavList` row: same tokens
   (`RAIL_ITEM_TEXT`, `RAIL_GROUP_LABEL`, `RAIL_GROUP_COUNT`, the rail pitch).
2. **Nothing the accelerator does is lost.** Pull, New page, drag of local
   drafts, presence on a source, the Recent / Shared views, the read-only
   prompts rail all survive as `StackedRail` props (actions, menu, trailing,
   meta), not as page-side chrome.
3. **Same in realtime-examples.** `DocumentExplorer.tsx` adopts the same
   composite (its session or an agent under the integration exception); the
   adoption commit is recorded below and the validator measures its rail
   when the app is up on :15174, and says so when it is not.
4. **Icons off by default.** The Org rail has none; a documents row may pass
   a small icon, the default is none. Ages sit in the meta slot in
   `RAIL_GROUP_COUNT` ink, as counts do.

## Definition of done

- Measured headless at 1672×941: the second rail on `/assessment/workspace`
  and on `/iq/library` agree on rail width (±8px), caption size (11px caps),
  row font (13px/500), row pitch, current-row treatment, and neither has a
  card background behind the rail.
- realtime-examples `/documents` adopted: commit recorded here; when :15174
  answers, the same measurement passes against it.
- The assessment-tenant and documents-parity validators stay green; the
  journey logs the rail change stales are re-sealed.

## Shipped

- 2026-09-29 — `DocumentRail.tsx` composes `StackedRail` (ui-components
  2.407.31 installed) and imports none of `WorkspaceRail`,
  `TreeView`/`KeyboardTreeView` or `ConversationShelf`; `KeyboardTreeView.tsx`
  and its `useTreeRename.ts` are deleted. Caption "DOCUMENTS n" with New page /
  ⋯ / fold; a Views group; one group per source (count, stored open state,
  presence as `trailing`, Pull or New page as actions, `pending` mid-pull) with
  pages nested beneath (age as `meta`, move `pending`, the ⋯ menu) and Activity
  last; no icons. The before/after/into drop rule moved into the host
  (`railDropPosition` / `railReorderTarget` in `knowledgeFormat.ts`, tested);
  Shift+F10 and double-click rename kept; the selected page's ancestors open.
  The e2e spec (`assessment-documents-parity.spec.ts`) passes 3/3.

## Backlog

- The Org shell's own rail and the Assessment shell rail already share one
  family; nothing to do there.
- **The measurement cannot pass on the assessment side yet, for three reasons
  outside the page.** (1) Width: `ExplorerLayout`'s narrowest `railWidth` is
  `sm` = 240px (measured 239) against the Org rail's 220; the library needs a
  220px option. (2) Pitch: `/iq/library`'s rail is `SubNavLayout` at a 36px
  pitch, while `StackedRail` rows are 32px (`RailNavList`'s) — the goal's
  "pixel-identical to RailNavList" and the reference disagree. (3) Icons: the
  measure counts any `svg` inside a row, so `StackedRail`'s own disclosure
  carets and the hover-only ⋯ menu (the library story's `MoreIcon`) read as
  row icons; it should skip `[data-testid$=-caret]`, group headers and
  `[data-testid$=-menu]`.
- `scripts/validate-assessment-documents-parity.sh` phase 3 / gap 15 still
  asserts the replaced family (`ConversationShelf compact plain size="rail"`,
  `KeyboardTreeView size="rail"` ×2, `railHeading="label"` + `railCount` in
  `ExplorerFrame.tsx`, `rowMenu={rowMenu}` + `label: 'Pull now'`,
  `<SectionPullControl`, `onReorder: props.onReorder, canDragNode,
  canDropNode`); those checks contradict this goal and need rewriting to the
  `StackedRail` shape.

## Adoption record

- ui-components release: `2.407.30` (StackedRail, `d0f975fc`); a geometry fix (caret in the row-text column, one caption x, 18px per level) is in the library session's lane
- aws-agentcore `DocumentRail.tsx`: bdf571d9 (2026-09-29)
- realtime-examples `DocumentExplorer.tsx`: 895dac3f (2026-09-29 20:30, adopted by that repo's session; its audit and visual runs still finishing)
