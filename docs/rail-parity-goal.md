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

- `portal/src/pages/assessment/knowledge/DocumentRail.tsx` composes
  `StackedRail` from `@connorhoehnslalom/ui-components` and no longer
  imports `WorkspaceRail`, `TreeView`/`KeyboardTreeView` `size="rail"` or
  `ConversationShelf` for the rail.
- Measured headless at 1672×941: the second rail on `/assessment/workspace`
  and on `/iq/library` agree on rail width (±8px), caption size (11px caps),
  row font (13px/500), row pitch, current-row treatment, and neither has a
  card background behind the rail.
- realtime-examples `/documents` adopted: commit recorded here; when :15174
  answers, the same measurement passes against it.
- The assessment-tenant and documents-parity validators stay green; the
  journey logs the rail change stales are re-sealed.

## Backlog

- The Org shell's own rail and the Assessment shell rail already share one
  family; nothing to do there.

## Adoption record

- ui-components release: `2.407.30` (StackedRail, `d0f975fc`); a geometry fix (caret in the row-text column, one caption x, 18px per level) is in the library session's lane
- aws-agentcore `DocumentRail.tsx`: _pending_
- realtime-examples `DocumentExplorer.tsx`: 895dac3f (2026-09-29 20:30, adopted by that repo's session; its audit and visual runs still finishing)
