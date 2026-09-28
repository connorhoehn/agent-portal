# Goal: `/iq/search` is the five-panel Search workspace in `docs/design/search-*.png`, drawn entirely from ui-components

`scripts/validate-search-workspace.sh` is the only judge. Work the backlog in
order, run the script after every slice, and treat each failing line as the
next task. The rules every other goal carries apply here too: no hand-rolled
HTML in pages (ui-components composites; a primitive the library lacks is
ADDED TO THE LIBRARY FIRST, never composed locally), no `npm install` to fix
a missing export (the settling commands in CLAUDE.md say whether it is
really gone), build to the middleware's response shapes, and a page never
invents a key.

## The design (five panels, one page)

The mockups Codex generated on 2026-09-27, saved under `docs/design/`:

| file | panel | what it fixes |
|---|---|---|
| `search-results-mockup.png` | **Results** tab | grouped by record type with per-section counts, a "See all N →" per group, selectable rows with an avatar or kind mark, a meta line ("Owner · Auth Migration", "Matched through initiative membership"), a status dot, a chevron; a hero query field with clear + submit; a filter-chip row (Workspace ▾ scope, "Initiative: Auth Migration ×", + Filter); Results / Answer / Connections tabs with a trailing Relevance ▾ sort |
| `search-answer-mockup.png` | **Answer** tab | the transcript with numbered citations; cited people as rows (avatar, name · role, one line, `[1] [2]`); "Work to coordinate" rows with status; numbered Sources chips; "View these connections →"; "Based on project roles and linked work." |
| `search-connections-mockup.png` | **Connections** tab (query-focused) | Force / Radial / Hierarchy, type filter, "N selected · Clear · Ask about selection →", labelled edges, a legend, zoom − % + Fit ⛶, a collapsed one-line assistant strip with Expand conversation |
| `search-people-connections-mockup.png` | **Connections** with People selected | the whole org graph: "56 people · 131 edges", Top-K and Min-strength sliders, department chips with counts, "Rare skills · org-wide", a Departments + Relationships legend (Collaborates / Mentors / Reports To / Shared Expertise line styles), find-a-person-or-skill |
| `search-scoped-results-mockup.png` | **Results**, entered from an initiative | "← Design System API / Work" crumb, "In: Design System API ×" chip beside "Search entire workspace", the query as an editable title, matched terms highlighted in rows, "Open work item ↗" row actions, "2 results in Design System API", "Ask about these results ↗ · View connections ↗" |

Common to all five: the same two-rail frame as the Initiative Work page
(shell rail · SEARCH rail · content), a SEARCH rail with type rows and
counts, More types ▾, a SAVED group and a RECENT group, a `+` new search, and
the docked rich composer (Agent ▾, context chips, formatting toolbar, Send).

## What exists today (2026-09-28) and what is wrong with it

The middleware half is real and tested: `GET /api/search` (q, type, scope,
limit, offset → results, counts, total, related, edges, partial),
`GET /api/search/records`, `/api/saved-searches` CRUD,
`schema/search_workspace_schema.sql` registered in `load_schema.py`, the
`search_context` numbered tool result, and 40 green jest tests across six
suites. `docs/search-workspace.md` is its contract and stays the contract.

The portal half is a first draft that the component-discipline gate already
fails: 20 raw styled elements in `SearchPage.tsx`, 10 in
`SearchEvidence.tsx`, two raw `<button>`s, a page-local
`searchConnections.css`, and a `SearchConnections.tsx` that drives
`@xyflow/react` directly. Results are one flat list with no grouping, no
avatars, no status dots, no highlights and no sort. The rail is a
`SubNavLayout`, not the `ExplorerLayout` + `RailNavList` frame the
initiative pages just moved to (ui-components 2.399.0). There is no way in
from an initiative. And the org graph the People panel asks for exists —
three times, all hand-rolled: `portal/src/pages/ExplorePage.tsx` (1160
lines, no longer routed: `/iq/explore` redirects into Search),
`portal/src/components/org-graph/` (~1900 lines: force layout, legend,
nodes, edges, tooltip, department chips, search box, person card,
connection path) and `portal/src/components/multi-entity-graph/` (~500).

## Decisions, with the reasoning

1. **The library owns every visual; the portal owns data, URL state and
   callbacks.** That is the user's standing rule ("everything comes from
   ui-components or gets ported back there and organized") and it is what
   the Work page now does with `WorkTableView`. Consequence: a search-row
   list, a cited-record list and a record graph are library composites, not
   page code, and each ships with a `.md`, a story and a test the way
   `WorkTableView` did.

2. **Results get a new `RecordResultList`, not `DocumentResultList` or
   `WorkListView`.** `DocumentResultList` is file-shaped (a `FileKind`, a
   folder, an updated-at, an Add-to-context toggle) and `WorkListView` is
   work-shaped. Search rows are typed org records — a person has an avatar
   and a role, a work item has a status dot, a knowledge item has a kind
   mark — that the user selects with a checkbox and groups by type with a
   count and a "See all". Forcing that into either existing shape loses the
   semantics the mockup draws. It lives in a new `src/components/search/`
   domain in the library, as `work/` does for work.

3. **The org graph is ported, not rewritten, and the typed record graph is
   built on the same layout.** The People panel is, feature for feature, the
   portal's `components/org-graph` (departments, relationship line styles,
   Top-K, min strength, rare skills). The library's `PeopleGraph` /
   `NodeGraph` are simpler (no relationships, no legend, no selection), so
   the richer implementation is the one to keep — moved into
   `ui-components/src/components/graph/org/` as `OrgGraph` with its legend,
   chips, search box, person card and `useForceLayout`, and the d3-force dep
   moves with it (xyflow is already a library dependency via
   `TypedNodeCanvas`). The query-focused Connections view becomes a library
   `RecordGraph` on that force layout with `force | radial | hierarchy`,
   labelled edges, selection checks, a legend and `CanvasZoomControls`. Once
   both are in the library, `ExplorePage.tsx`, `components/org-graph/`,
   `components/multi-entity-graph/`, `SearchConnections.tsx` and
   `searchConnections.css` are deleted — merge or delete, never archive.

4. **The Search rail is the initiative rail.** `ExplorerLayout` for the
   frame, `RailSection` × 3 (SEARCH / SAVED / RECENT) over `RailNavList`
   rows with counts and `currentStyle="tint"`, the same 13px `railType`
   scale — so Search does not become a second rail style the moment the
   initiative pages settled on one.

5. **Three small, honest middleware additions; no new index.** The mockup
   needs `sort` (relevance | recent), a per-record `matchReason` (the
   scoring path already knows whether a row matched on its title, its text,
   or by riding an initiative edge — say so), and `highlights` (the matched
   terms, so the row can mark them). All three derive from what
   `searchRecords` already computes. The People panel reads the existing
   org-graph endpoints under `/api/graph`; Search stays a bounded read model
   over existing providers, as `docs/search-workspace.md` says.

6. **The composer does not advertise what is not built.** The mockup's
   Workflow ▾ and attach controls stay off (`allowAttachments={false}`, no
   workflow menu) until something handles them — the contract in
   `docs/search-workspace.md` already says so. `/agent <name>` and the
   agent picker are the routing surface.

7. **Scoped entry is a link, not a mode.** An initiative page offers
   "Search in this initiative" → `/iq/search?scope=<id>`; the header renders
   the "In: <name> ×" chip and "Search entire workspace" from the existing
   `scope` param. Nothing new in the URL contract.

## Ownership map (what the portal may import, and where it comes from)

| panel element | library composite | status |
|---|---|---|
| two-rail frame | `ExplorerLayout`, `ScopeHeader` | shipped |
| SEARCH / SAVED / RECENT rail | `RailSection`, `RailNavList` (`currentStyle="tint"`, counts) | shipped (2.399.0) |
| hero query field, clear, submit | `SearchInput` + `Button`/`IconButton` | shipped |
| scope + filter chips | `FilterChip`, `FilterPopover`, `DropdownMenu` | shipped |
| tabs + sort | `Tabs`, `DropdownMenu` | shipped |
| grouped, selectable, highlighted results | **`RecordResultList`** (`search/`) | **to build** |
| matched-term marking | **`Highlight`** (`shared/`) | **to build** |
| cited records under an answer | **`CitedRecordList`** (`search/`) | **to build** |
| typed record graph | **`RecordGraph`** (`graph/`) | **to build** |
| org graph, legend, chips, sliders, person card | **`OrgGraph`** and friends (`graph/org/`) | **to port** from `portal/src/components/org-graph` |
| transcript | `MessageBubble` via `InvokePage` | shipped |
| composer | `RichChatComposer` (`social/rich-composer`) | shipped |

## Definition of done (what the validator checks)

- middleware and portal typecheck; the six search jest suites and the
  portal's `pages/search/__tests__` node tests pass; vite builds.
- `portal/src/pages/search/` has **0** raw styled elements, **0** raw
  `<button>`, **0** inline `style={{}}`, no `.css` file, and no direct
  `@xyflow/react` or `d3-force` import; the portal's `d3-force` dependency
  is gone once the graph is in the library.
- `SearchPage.tsx` imports `ExplorerLayout`, `RailSection`, `RailNavList`,
  `RecordResultList`, `CitedRecordList`, `RecordGraph` and `OrgGraph` from
  `@connorhoehnslalom/ui-components` and no longer imports `SubNavLayout`.
- `ExplorePage.tsx`, `components/org-graph/`, `components/multi-entity-graph/`,
  `SearchConnections.tsx`, `SearchEvidence.tsx` and `searchConnections.css`
  no longer exist.
- routes: `/iq/search` mounted; `/search`, `/invoke`, `/iq/invoke`,
  `/explore`, `/graph`, `/iq/explore` redirect through
  `LegacySearchRedirect`; the palette and the shell rail both target
  `/iq/search`.
- middleware contract: `GET /api/search` validates `sort` (relevance |
  recent) and each record carries `matchReason` and `highlights`; every
  mounted search and saved-search route has a test.
- scoped entry: an initiative page links to `/iq/search?scope=`; the page
  renders "Search entire workspace" when scoped.
- journeys: `docs/search-journeys/{member,org-leader}/{results,answer,connections,people,scoped}.md`
  with the PROTOCOL fields, a screenshot, and an mtime newer than every
  `.tsx` under `pages/search/` (the same freshness rule as distillation).
- `docs/search-workspace.md` names the five design files.

## Backlog (in order)

1. **Library, wave 1a — `search/` domain.** `Highlight` (shared),
   `RecordResultList`, `CitedRecordList`, each with `.md`, stories, tests;
   exports on the root barrel; CHANGELOG entry; export snapshot regenerated.
2. **Library, wave 1b — graphs.** Port `portal/src/components/org-graph`
   to `graph/org/` as `OrgGraph` + `OrgGraphLegend` + `DepartmentChips` +
   `GraphSearchBox` + `PersonDetailCard` + `ConnectionPathStrip` +
   `useForceLayout` + `findConnectionPath` (d3-force becomes a library
   dependency); build `RecordGraph` on the same layout; `.md`, stories,
   tests, exports, CHANGELOG.
3. **Middleware, wave 1c.** `sort`, `matchReason`, `highlights` in
   `providers/search.ts` + `routes/search.ts`, tests, and
   `docs/search-workspace.md` updated.
4. **Release** ui-components 2.400.0 (commit with dist, push), bump the
   portal pin to the full sha, clear `.vite`.
5. **Portal, wave 2.** Rebuild `SearchPage.tsx` on the ownership map;
   scoped entry from the initiative pages; delete the legacy graph code and
   the page-local CSS; update `pages/search/__tests__` and
   `portal/e2e/search-workspace.spec.ts`.
6. **Journeys, wave 3.** Walk the five surfaces as member and org-leader,
   write the ten logs with screenshots, run the full validator.
