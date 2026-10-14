# Layout cascade — two rails, crumbs first, the list a flush rail

**Judge:** `scripts/validate-rail-parity.sh` — its "layout cascade" section
runs static checks in `--quick` and the Playwright sweep
(`portal/e2e/layout-cascade.spec.ts` over `portal/e2e/route-inventory.ts`, the one route inventory)
in full mode. Exit 0 only when every check passes.

## The ask (2026-10-07)

The user, with screenshots of `/iq/distillation/review?sample=rev-027` and
`/iq/distillation/knowledge?nav=distillation`: "the padding and toolbars are
inconsistent… breadcrumbs are in the wrong place and not consistent with what
I have been driving forward… weird padding in the content area… there
shouldn't be any sub page that has [a third rail]", and "there should always
be some type of content". The reference is the Distillation landing: shell
header; the primary rail (ORG groups); ONE section rail (DISTILLATION:
Knowledge / Review / Activity with counts); then the content column, whose
first row is the trail (`Build › Distillation`) with the page's actions on
the right, then the page title, at the standard gutter.

What the review and knowledge pages drew instead: a third full-height column
headed KNOWLEDGE (a run-notes search box and a "Recent" list) beside the
section rail, with the trail pushed to the right of it — or, on Review, the
trail first but the page's title inside the detail pane, 300px to the right of
the trail — and pane padding of 20px against the 24px everywhere else.

## The contract

1. **Two navigation rails, at most.** A page has the primary rail and, when
   it is a section with destinations, one section rail (`SubNavLayout`). The
   only other full-height column allowed at the top of the content area is
   the page's own list rail (rule 5) — it is the page's list, not a third
   navigation. The social chat workspace's `ConversationRail` is that section
   rail (`docs/rail-parity-goal.md` decision 6).
2. **The trail is the content column's first row.** Breadcrumbs (and the
   page's scope controls and links, hung on the right of the same row) come
   before anything else in the content column. On a padded page that is the
   shell's own row; on a flush page (`data-shell-flush`) it is the
   `ScopeHeader variant="crumbs"` band that `SectionContent` draws (or, on a
   page with a list rail, `SectionHeader` as the library `ListRailLayout`'s
   `header`, right of the rail). No page composes its own breadcrumb row inside a pane.
3. **The title follows the trail**, left-aligned with it: the 20px/600
   `PageHeader`, 16px under the trail (`components/shell/headerRhythm.ts`), or
   a `VisuallyHidden` h1 where the design has no visible title. When a record
   is open its own headline stays in the detail pane; the page title is the
   view's name, so it does not jump as the reader moves through the list.
4. **One gutter.** The trail, the title and the body start 24px from the
   content column's left edge (`px-6` — the shell's 24px ring on a padded
   page, `SectionContent` / `SectionHeader` on a flush one; with a list
   rail the content column's edge is the rail's right edge). The sweep measures the trail's x
   against the content edge on every route and requires the same value.
5. **A page's list is a flush list rail stacked beside the section rail,
   using the shared rail composite; the content column (trail first) starts
   after it; the rail never floats, never has a border radius or its own
   gutter box.** A page with records — a knowledge tier, a review queue,
   promotion candidates, compaction runs, a catalog record — draws
   the library `ListRailLayout` (ui-components 2.438, one `ListRail` value)
   exactly as the Initiatives list draws it (`InitiativesExplorer.tsx`: 264px,
   caption title with a count chip, search + filter popover in the rail
   header, `GroupedList` rows with `currentStyle="bar"`, a footer line), its
   rail flush against the section rail from the content top to the footer,
   and the trail band + title (`SectionHeader`) as its `header`, so the content column's first row is the trail
   at the 24px gutter after the list rail. The rail's controls live in the
   rail (a scope such as Distillation's repository is a facet in its filter
   popover), never as a button in the content header. A canvas that is not a
   list (the tier graph) may sit in `SectionContent` framed by
   `SECTION_CANVAS_FRAME`.
   (Revised 2026-10-07: the first version of this rule put the list in a
   bordered, rounded pane under the title; the user, on
   `/iq/distillation/review?sample=rev-027`: "this nested nav should not be
   floating inside the content pane… consistent with… initiatives… stack
   right next to the other two left sidebars… Having this floating thing
   creates wasted padding and space.")
6. **Always some content.** A section's own landing shows real content — an
   overview with the section's lists and counts, or its first destination —
   never a bare "Explore …" / "Browse …" placeholder.
7. **One shell footer, no horizontal page scroll** at 1680×940 and 1280×720.
8. **On a deep page the primary rail gives way first; while a dialogue is
   open, the primary rail and the page's own section/list rail both give
   way** (decided by the user 2026-10-13; the dialogue half below). The depth
   rule (2026-10-07, the user's screenshot of
   `/iq/projects/p-observability?scope=all&tab=work&item=wi-obs-e2-b4`, where
   the work list had folded to a bare ">" strip while the Org rail stayed
   wide). One rule, the library rail model (ui-components 2.438 `railDepth`
   + `useRailFold` + `SubNavLayout collapsed`), declared in `Layout.tsx`
   (`SHELL_RAIL_DEPTH`): depth 1–2 (a section's lists, one
   record) keeps both rails open; depth 3+ (initiative › work item, team ›
   dimension, a run, a document) folds the primary rail to a 44px strip with
   its re-expand control and keeps the section rail open. Depth is the path
   depth under the tenant prefix, plus one for a drill selection in the query
   (`item`, `dimension`, `step`, `sample`, `run`, `candidate`), plus two when
   the right pane explores a selection of the page (`useSidePaneHost().explored`:
   an initiative's Details/Docs/Log, Search's Ask about selection); runs,
   documents and decks are always 3+. A record open beside a page's list rail
   (Distillation's `?sample=` / `?item=` / `?run=`, a catalog
   `/iq/designs/:id` or `/iq/library/:id`) is the selection level, so it is
   deep: the primary rail folds and the section rail and list rail stay open.
   With no dialogue open, the list rail (rule 5) is the page's list and stays
   open at every depth.

   **While a dialogue is open, both rails fold** (the 2026-10-10 huddles
   behaviour, made the rule by the user on 2026-10-13; `useDialogueRailFold`,
   `portal/src/components/shell/useDialogueRailFold.ts`). A dialogue is open
   when the shell's right pane is shown (`useSidePaneHost().shown`: an
   initiative's or scorecard's Discussion/Details pane, Search's Ask about
   selection; a pane minimized to its 44px strip still counts) or a huddle's
   conversation dialogue is open (`ShellCallHost onDialogueChange`). Then, at
   ANY depth: (a) the primary rail folds to its 44px strip (`Layout.tsx`), and
   (b) the page's own section/list rail folds to its strip on the pages that
   fold it for dialogue — today the initiative work list
   (`InitiativesExplorer.tsx`) and Search's rail (`SearchPage.tsx`). A section
   rail a page does not fold for dialogue (the tenant section rails drawn by
   `SubNavLayout`, a `ListRailLayout` list rail) keeps the depth behaviour.
   Each folded rail's own toggle reopens it **for this visit only**: the
   choice is held in memory for the current path (moving between records by
   query — `?item=` — keeps it; another path starts folded again) and is never
   written to storage, so a reload with the dialogue still open folds the
   rails again. When the dialogue closes, the choice is dropped and each rail
   returns to its remembered, per-device state — the dialogue fold never
   overwrites it. The pane's own open/closed state is remembered per device
   (`shell.conversation-pane.open`, open by default), which is why the
   initiative and scorecard pages open with both rails folded. The four
   rail-collapse cases in `portal/e2e/layout-cascade.spec.ts` check both
   halves: with the pane shown, and with `shell.conversation-pane.open=0`.
   Inside the record pane the record has one inset: its header, body sections
   and docked composer share EditorShell's 20px edge (the composer dock takes
   `[--dock-inset:1.25rem]`), and the record carries no breadcrumb of its own
   — the shell trail is the only trail. A window under 1180px folds the primary rail at
   any depth, and only under 768px does the section rail fold — second. With
   no dialogue open, the reader's own toggle wins, remembered per device per
   depth band (`shell.primary-rail.shallow|deep`). The trail stays the content column's
   first row either way. A section rail the reader can fold (the initiative
   work list, `initiatives.rail-collapsed`; the assessment document rail,
   `assessment.documentRail.collapsed`) remembers that fold per depth band
   through the library `useRailFold` (`<key>.shallow|deep` = `collapsed|open`;
   a band-less legacy value is ignored, so a fold set on a list page never
   folds a deep page; only an open dialogue folds it there, without storing). The social chat rail folds sections inside the rail, not the
   rail, so it is unaffected. The shell exposes the result as
   `data-primary-rail`, `data-section-rail` and `data-drill-depth` on
   `[data-shell-nav]`. The strip is the library's `SubNavLayout collapsed`
   (2.438): its header row takes the height of a compact section rail beside
   it, so no consumer CSS reaches into the rail's DOM (`app.css` carries no
   `!important`; `validate-rail-parity.sh` checks).

`SectionContent` (`portal/src/components/shell/SectionContent.tsx`) is the
composition: library `ScopeHeader` + `PageHeader` + a body `Stack`, no inline
styles, no fixed heights; its `SectionHeader` is the trail + title band a
`ListRailLayout` takes as its `header`.

## The pane and rail contracts (ui-components 2.438.0)

One model each, in the library (`release/2.438.0-pane-rail`, `dceae5b4`);
the portal declares configuration and draws bodies, nothing else.

**The right pane (`SidePane`).** The shell mounts `SidePaneProvider
storageKey="shell.conversation-pane"` above its rails (`Layout.tsx`) and
`SidePaneSplit` where the page renders (`HuddleChat.tsx` `HuddleChatSplit`,
with the call's media grid as `before` and the huddle chat as `after`). A page
registers ONE pane with `<SidePane title subtitle tabs value onValueChange
trailing footer explores onClose widthPx>`; its body stays mounted while the
pane is off screen. Per device: `shell.conversation-pane.open` (`1|0`) and
`.ratio` (0.4–0.85, default 0.72). The split needs 860 + 300px or the pane
waits for the footer's Message (`reveal()`). A page-owned pane (`onClose`:
Search's Ask about selection, a Communication detail) shows while registered.
The pane draws at `compact` density; its frame is a popover boundary.
Since 2.438.1 (the user: "keep the chat in the main content… just keep the
dialogue thread there… collapse the panes and make the chat pane wider"): the
pane holds the **thread only** and the page's ONE composer is docked at the
bottom of the content column (initiative, work item, Search, the scorecard,
Communication; `e2e/pane-composer-placement.spec.ts`); a live huddle's chat
stacks in the right pane, never beside the content composer. The divider
drags the pane wider (320px–60% of the split, remembered per pane id:
`shell.conversation-pane.ratio[.<paneId>]`), its arrow keys resize, Enter /
Space or the frame's Minimize fold it to a 44px strip with Restore
(`shell.conversation-pane.folded`). On a canvas tab (initiative Activity) the
docked composer takes its compact one-row form and the header folds.

**Collection pages carry the shared command composer (2026-10-12).** Every
list/table page in every tenant docks ONE `CollectionCommandHost`
(`portal/src/components/collections/`) at the bottom of the content column:
a page that *is* one collection converts to `CollectionCommandPage`
(Pipelines Definitions is the precedent); a page whose table is one section
among others mounts the host inside that section, and the host docks itself
(ui-components 2.448.0 `ColumnDock`) into the content column's dock
(`DockedColumn`, which `BuildSectionLayout` and `SectionContent` draw): the
composer spans the column at its bottom, every other block of the page —
trailing links, disclosures — sits above it in the scrolling body, and it
still drives its section's table. Nothing is laid out below a page's composer
and no section draws it on its own inset band (the embedded-section boundary
of 2026-10-12 is retired; the DOM audit's `composer.last` judges both, and
measures the composer against the column). The input speaks the one bounded grammar in
`collectionCommands.ts` (search, at most one existing filter, reset, refresh,
`open <exact ID or title>` over the rows currently shown, page-declared extra
phrases with their own handlers) and drives the same controlled toolbar state;
it never mutates a record, posts to a conversation or invokes an agent, and
its help popover says so. The audit policy (`portal/e2e/ui-dom-audit.policies.ts`
`tenantComposerPolicy`) requires the composer on list routes, searchable
tables and any page with a visible composer, and exempts only on positive
evidence: dashboards of charts, spatial canvases, configuration/settings
surfaces, registration placeholders, the Computer Lab, chat directories with no
selected conversation, observed-404 records, titled record details. A page
without evidence stays visibly unclassified; never exempt a tenant wholesale.
Documented route aliases (`AUDIT_ROUTE_ALIASES` in `ui-dom-audit.routes.ts`)
are the only redirects the audit accepts.

**The pane URL contract (`usePaneState`).** `?pane=<tab>` names a tab;
`?pane=<tab>&paneRecord=<kind>:<id>` a record tab and its record; the resting
tab is no params. Tabs are a registry `{id, label, remember?, recordKinds?}`.
Initiative: Discussion (resting), Details and Docs (remembered,
`initiative.pane.tab`), Log (`run:`), Decision (`decision:`), Person
(`person:`) — `pane=details`, `pane=log&paneRecord=run:<job>`. Search: no
`pane` = closed, `pane=chat` the conversation, `pane=record&paneRecord=person:<id>`
the person beside it (`keepRecord`). `?selection=` is never pane state: Search
keeps it for canvas picks only.

**The rail model.** Fold: `railDepth` (the host's route declaration) →
`railBand` → `useRailFold({storageKey, defaultFolded})` per band, under
`RailBandProvider`; the primary rail's fold is `SubNavLayout collapsed`. List
rails: `ListRailLayout list={ListRail}` (the root carries `data-list-rail`,
which the sweep reads). Conversation rails: `ConversationRail sections` as data
built by `buildRailSection` (count = records held, rows = those the find text
matches, honest loading / failure / note), with `useRailSectionMemory`
(`social.chatRail.folded` / `.layout`) — the Social workspace and the
Communication plane's groups and org teams share it.

## Records open as pages; selections stay put (2026-10-13)

The user, on `/assessment/submissions`: rows did not open, "Revision history"
opened a drawer, and ticking a row inserted a "2 selected" band that pushed
the table down. The rules, for every tenant:

- **A row opens its record as a page, by URL.** New record routes are path
  params beside the list (`/assessment/submissions/:submissionId`,
  `/assessment/feedback/:taskId`, `/assessment/runs/:runId`,
  `/pipelines/definitions/:definitionId`, `/pipelines/approvals/:approvalId`,
  `/access/policies/:id`) — the catalog-record pattern of `/iq/library/:assetId`
  and `/iq/designs/:id`. The list becomes the flush list rail
  (`components/collections/CollectionRecordFrame.tsx` over the library
  `ListRailLayout`) and the record fills the content column; the record level is
  deep (`SHELL_RAIL_DEPTH.leafRoutes`), so the primary rail folds. A record that
  stays beside its list on the same page (Scores' person) keeps its selection
  in the query (`?person=`).
- **Record detail never pops out.** Revision history, details and history are
  sections of the record (or a right-pane tab through the one pane model),
  never a `Drawer`/`Modal`. Confirmations (`ConfirmDialog`) and anchored help
  stay dialogs; a create form opened from a header action is not a record.
- **Rows that open nothing say why.** `DataTable staticRows="<reason>"`.
- **Selection replaces the toolbar row in place.** `CollectionToolbar
  selection={{count, onClear, actions}}` (ui-components 2.442.0); a click on a
  checkbox inside a clickable row only ticks it.

The rendered-UI audit enforces all four (`record.popout`,
`collection.row-activatable`, `collection.selection-shift`; the
`row-activate`, `record-detail-action` and `row-select` states in
`portal/e2e/ui-dom-audit.adapter.ts`).

## What changed (2026-10-07)

- Distillation: Knowledge, Review, Asset promotions and Activity › Runs each
  draw a list rail (now the library `ListRailLayout`) — flush beside the DISTILLATION rail
  (264px, "GUIDES & FINDINGS 12", "PENDING 7", "CANDIDATES 3", "RUNS 14"),
  then trail, view title ("Guides & findings", "Knowledge pending", "Asset
  promotions", "Compaction activity"), record. The repository selector left
  the content header for each rail's filter popover (same `?repo=`); "Agent
  library ↗" stays on the landing, Knowledge and Asset promotions. Review's
  Pending/Reviewed tabs are gone (the section rail chooses the queue) and its
  rows group by what was sampled. Activity › Tier graph stays `SectionContent`
  with the canvas framed. Measured before → after at 1672×941: the list
  started 25px right of the section rail, 89–115px under the content top, in
  an 8px-radius box, 710px tall (Knowledge 320px wide); it now starts at the
  section rail's right edge, at the content top, 824/824px tall, radius 0,
  264px, with the trail 24px right of it.
- The module landing (`?nav=distillation`) is an overview: a tier stat strip
  (each stat opens its view) and the newest five records of each tier with
  its count and an "Open …" action.
- `StackedCatalogLayout` (Designs, Agent library): an open record draws
  a list rail (now `ListRailLayout`) — the record list rail beside the catalog's section rail
  (rows grouped by status / kind), then trail, title, record.

## The sweep

`route-inventory.ts` (the one route inventory every sweep and judge reads; it was `layout-inventory.ts` until 2026-10-08) lists every route in `portalCommands.ts`, `Layout.tsx`
`NAV_ITEMS` and the social/pipelines surfaces files, the section landings,
and the parameterised routes resolved against fixture ids (initiative
`p-auth-migration`, work item `wi-auth-e1-s1`, team `TEAM-001`, document
`page:A100003`, decision `d-aurora`, design `des-auth-rotation`, agent
`orgiq-supervisor`, review sample `rev-027`, guide `art-001`, channel
`general`; runs, jobs, library assets and decks are read from the API at
sweep time and fall back to the route's not-found state when none are
seeded). The spec signs in once per tenant as the seeded admin and measures,
per route: navigation columns at the content top, the page's list rail
(`[data-section-list] nav[aria-label="Explorer"]` — flush against the rail
beside it, at the content top, full height, no rounded ancestor, 264px), the
trail's position and gutter (measured from the list rail's right edge when
there is one), the first h1 after the trail, the footer count, and scroll
width at both viewports. One more case requires a list rail on every list
page (Distillation Review/Knowledge/Promotions/Runs, a design, a library
asset), no repository control in Distillation's content header, and the
repository facet in the rail's filter popover; `rail-parity-measure.mjs`
`RAIL_PARITY_LIST=` measures the same frame against `/iq/projects`. Six more cases assert rule 8: the rail states at depth
≤2 vs 3+ for initiative / work item, team / dimension, runs / run and search /
document, that the reader's re-expand survives a reload, and that a hand-set legacy
`initiatives.rail-collapsed=1` does not fold the work list on a work item. Known
violations at adoption are a ratchet in `layout-cascade-baseline.ts`: the
sweep fails on anything new and on an entry that no longer occurs. `EXEMPT` in the inventory names each deliberate exception and
the decision behind it; nothing else may skip a check.
`LAYOUT_CASCADE_ONLY=<substring>` narrows a run.

## The type-scale step (2026-10-07)

The user, on `/iq/communication`: "walk down the tree on all of the pages and
see that when you get to the content, note if there's oddities on font size
oscillating". The landing read 20 (title) → 16/600 link-styled actions → 18/600
"Pick a channel" → 16/400 body, a placeholder rule 6 already forbade.

`portal/e2e/type-scale-sweep.spec.ts` walks the same inventory, signed in as
its user, and reads every visible text node's computed size/weight, depth and
ancestry per region (content column, in-page rails, right pane, the primary
rail once per tenant). It holds the app's one scale: 20/600 for the page title
alone, 14 for headings and body, 12 for meta; 10–11 only in a pill or count
badge; 16 only in the document editor canvas or the deck editor. It also fails
a size that grows down an ancestor chain, sibling headings of different
sizes, and a title action row holding link-styled or md buttons or text over
14px. Offenders at adoption are a burn-down in `portal/e2e/type-scale-burndown.tsv`
(one row per offender with its owner surface and due date; new offenders fail;
`TYPE_SCALE_PRUNE=1` only removes; the validator fails a row past its due date,
and its `TYPE_SCALE_BASELINE_BUDGET` ceiling may only go down). It runs as the type-scale step
of `validate-rail-parity.sh` and writes a per-route table (route · offenders by
region · worst off-scale oscillation) to `$RAIL_PARITY_LOG_DIR/type-scale-report.txt`.
The library rail family and the conversation surface draw their own scale;
those rows are in `docs/ui-components-queue.md` ("Rail and tile type off the
app scale").

## Tables (2026-10-07)

The user, on `/assessment/submissions`: "the '3 revisions — latest r3'
button is off, shouldn't be there inline. There needs to be rigid rules on
the styling of this table." The page drew a card stat strip, a lone search
field on its own row, ~100px rows whose cells stacked a second line (team id
over the team name; "Form #5" over a bordered button) and a Status pill
clipped at the right edge. These rules hold for every list page in all four
tenants; nothing on a list page decides its own table style.

1. **One composite.** A list of records is the library `DataTable size="sm"`
   (or `Table size="sm"` when the page must own the rows). A list that is
   not tabular — a feed, a document list — is `ActionRowList size="sm"` (the
   library has no `RowList`) or the library list composite built for it
   (`DocumentResultList` on the document explorers, which the
   documents-parity judge owns), never a hand-made table.
2. **One line per row, 44px.** Every body row is exactly 44px and every row
   of a table is the same height. The shell's compact DensityProvider gives
   cells this height and `whitespace-nowrap` without a per-page size prop.
   Nothing inside a cell may make it taller.
3. **A cell holds exactly one thing:** text, one pill (`Chip`/`StatusPill`),
   a number, an avatar with its name, or `IconButton`s. Never a second line
   (no `Stack`, no `MetaLine` under a value, no two block children), and
   never a text `Button` or any bordered control. A secondary fact goes to a
   meta column of its own (`T size="xs" tone="tertiary"`), into the cell's
   `title`, into a count pill with a tooltip (`Chip size="xs" mono
   title="3 revisions — latest r3"` reading `r3 · 3`), or into the row's
   detail pane/drawer. Row verbs are `rowActions` IconButtons with an
   `aria-label` naming the row.
4. **Alignment.** Numbers, money, durations and dates are `numeric` columns:
   right-aligned header and cells, tabular figures. Text is left-aligned.
   Render the value bare in a numeric cell: `T` is a flex `Inline`, so a
   value wrapped in it ignores the cell's `text-right` and sits at the left
   (wrap it as `T className="justify-end"` only when it needs a title or a
   tone; a block such as `DotMeter` goes in `Inline justify="end"`).
5. **The header** is the `size="sm"` header: 12px/600, uppercase.
6. **Nothing clips.** The status column has a fixed `width`, and a table too
   wide for its region scrolls horizontally inside DataTable's own scroll
   wrapper; the last column's cells and their content stay inside the
   table's box at 1680px. A free-text column (a run title, a question, a
   prompt) is capped — `T size="sm" className="block max-w-[32rem] truncate"`
   with the full text as its `title` — because seeded or user text can be any
   length and `size="sm"` cells never wrap.
7. **Selection only with a bulk action.** A checkbox column appears only
   when the page offers a bulk action on the selection (and only to roles
   that may run it).
8. **One controls row.** CollectionPage owns the title and spacing;
   CollectionToolbar owns search, filters, count, advisory popup and icon
   actions. Pages provide data, permissions and handlers. DataTable's
   `searchable` now uses that same toolbar internally; use it for a simple
   searchable list, or supply one external CollectionToolbar for search plus
   filters/actions. Do not stack both toolbars.
9. **Empty is the table's own empty row** (`emptyMessage`), not a card in
   place of the table — except the first-run empty state of a page with
   nothing yet (an `EmptyState` with the action that fills it).
10. **Table above the fold.** Rules 2 and 8 exist so the first rows are on
    screen at 1680×940 without scrolling.

**Judges.** Statically, `scripts/count-layout-drift.py` (a burn-down in
`scripts/layout-drift-burndown.tsv` — per class and file, with an owner surface
and a due date — read by `validate-component-discipline.sh`):
`stackedcell` (rule 3, second line), `cellbutton` (rule 3, a text `Button` in
a `TableTd`, a column `render` or `rowActions`), `tablesize` (rules 1–2, a
`DataTable`/`Table` with an explicit size other than sm), `lonesearch`
(rule 8, DataTable `searchable` alongside another toolbar) and `cardstat` (rule 8). In the browser,
`portal/e2e/table-rules.spec.ts` walks every list route (the inventory's `TABLE_ROUTES`) as
each tenant's own manager and fails a body row over 44px or rows of unequal
height, a bordered text button in a cell, a cell whose text sits on two
lines (measured by each text node's own range), a numeric/date column whose
content does not end at the cell's right padding edge, a header off 12/600 caps, a
last column outside the table's box, a stat value off 14/600 or a card
strip's 17px figures, and competing search/filter rows. A simple searchable list uses one shared
CollectionToolbar even when search is its only control.


## Inheritance audit (2026-10-12)

Run `node scripts/audit-ui-inheritance.cjs --check` after `npm ci` in
`portal`. `--list` gives source locations; `--json` produces a machine-readable
inventory. The component-discipline gate invokes the same check.

The audit separates review candidates from enforced contracts:

| Pattern | Why it recurs | Ownership / verification |
| --- | --- | --- |
| Local control sizing and class/style overrides | Shared primitives can still be restyled differently on every page | Control geometry lives in ui-components; review explicit sizes for intentional exceptions |
| CSS targeting library internals or test IDs | A markup change silently breaks page-specific fixes | Add a semantic prop or shared variant; keep domain/media positioning separate from visual policy |
| Repeated title/toolbar/table compositions | Changing one page leaves its copies behind | CollectionPage and CollectionToolbar; RunsLedger composes the shared ledger across Work, Pipelines and Assessment |
| Fixture-only or local density providers | Tests look correct while the real application uses other defaults | main.tsx wraps the actual App; live-shell browser tests verify inherited dimensions |
| Stale archive or installed dependency | Correct source never reaches the browser | Compare vendor archive SHA-512 with lockfile and every archived file with the installed package |
| Source-shape checks demanding local markup | Tests accidentally reward duplication | Validate shared composition and rendered behavior; Runs no longer needs a local DataTable literal |

Enforced now: the real compact provider wraps App; all three run surfaces use
RunsLedger; Pipeline collection pages use CollectionPage without geometry
class/style overrides on audited controls; composer surface CSS stays in the
library; archive, lockfile and installed UI agree. The inventory is broader
than those contracts and is **not** a list of confirmed bugs.

`portal/e2e/ui-inheritance.spec.ts` signs into the real shell across Pipelines,
Work, Social and Assessment. It changes a single shared token and checks the
rendered controls/table insets on different routes, tests filter interaction,
and checks the composer backdrop reaches its shelf bounds. CDP metrics are
attached for diagnosis, not presented as a performance benchmark.

The remaining review queue is visible in `--list`: eight local collection
compositions, control overrides, and CSS reaching into shared markup. The
older discipline gate also has pre-existing raw-element, density-size and
session-helper violations; this change does not raise their budgets. Review
these by component family and state (loading, empty, error, permission,
light/dark, narrow width), not by repeatedly patching individual screenshots.

Compact headers with a leading back control align that control/title group
to the trail. The browser judge measures the actual group edge, so adding
an accessible back action does not require a route-specific pixel exception.
