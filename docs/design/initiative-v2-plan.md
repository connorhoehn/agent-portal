# Initiatives v2: build plan

**Target:** `docs/design/initiative-overview-v2-mockup.png`. The user adopted it on 2026-09-24 at 23:25 because it has "better typography and layout constraints". It supersedes `initiative-overview-mockup.png` for the Overview. The image wins wherever this file disagrees with it.

**Status (2026-09-25):** L, B and M shipped (ui-components 2.392.0, pinned, plus the seed and mock copy). P and D shipped on `feat/init-v2`. Build screenshots are `initiative-v2-build-{overview,work,mine-empty}.png`, from headless 1642×958 after a dev:mock reset. The ten `initiatives` and `initiative-detail` journey logs were re-walked and sealed. §3 items 1–6 hold. Deviations:
- The Work tab keeps its 368px work column and "Work 11" heading, and takes only the header type scale. At 264px its two-line rows clipped after two words and the switcher pushed the heading out. V1 lets it keep its structure.
- Mine-empty keeps `EmptyState size="lg"`. At `md`, its question read at the same size as "How this view works" under it.
- "Needs attention" lists every blocked item still to do, not just the first, so its count is the rows under it.
- Copy that named v1's "Everyone" toggle now says "All initiatives".
- The Sprints rail sublines say "pts" and carry their full text as a tooltip, because at 264px "points" clipped.
- One gap is left for the library. `ActionRowList tone="warning"` tints noticeably stronger than the mockup's pale amber.

**Baseline:** `main` at `7309a6f3`. v1 is fully built there: the explorer frame, the Overview, the Work brief, Mine-empty, and Settings Profile. It runs on ui-components 2.390.4. v2 is a restyle of that build, not a rebuild. The data contract, the models (`overviewModel`, `initiativeListModel`, `briefModel`, `composerPrompts`) and the composer all stay.

**Scale:** the mockup's shell rail is 206px wide where ours is 200px. Pixel measurements below are therefore divided by about 1.03 to get CSS px.

## 0. Decisions (the default is what this plan assumes)

| # | Question | Default |
|---|---|---|
| V1 | Work tab and Mine-empty have no v2 images. | Restyle both to v2's type scale and rail. That means the same 264px rail, title-only rows, 22px title, and the `label` group headings. Keep their v1 structure. Replace this if images arrive. |
| V2 | The rail has a **+** button. Nothing can create an initiative: initiatives come only from the seed or from graph-builder's `merge_project` (see the "No create-initiative path" memory). | **Omit +.** A + with no action is decoration. If the user wants it, it becomes a disabled control with the reason "Initiatives come from ingestion". |
| V3 | The description is two lines: the summary, then "Focus: actionable alerts, team error budgets, and OpenTelemetry." | **Add a `focus` line to the seed**, not a new column. Put it in `projects.summary` as a second paragraph separated by `\n`. `ScopeHeader description` renders pre-line. This avoids a schema change. The mock mirrors the generator. |
| V4 | The attention subline is "Waiting on the dependency map." The current `blockedReason` is "Eli needs the dependency map before this bug can be planned." | Change the seed's `blockedReason` to the short form. It is only read by the Overview and by the composer's unblock prompt. The Work brief's Next step callout keeps `nextStep` / `nextStepDetail`. |
| V5 | People have photos. There is no photo data. | Use library `Avatar` with initials at 32px. Photos are out of scope until identity carries an image URL. |
| V6 | The rail rows lost "Owner · N agents". | Accept it. Running agents stay visible in the stats line, the header's ▶ badge, and the Everyone table. |
| V7 | "How to move this forward" is gone. | Remove it. The composer's placeholder and prefill carry that job. |

## 1. Element by element (Overview)

Measurements are CSS px after the ÷1.03 correction.

| # | v2 mockup | Today (v1) | Renders with |
|---|---|---|---|
| R1 | Explorer rail about **264px** (mockup 207→476) | `railWidth="lg"`, 368px | **NEW** `ExplorerLayout`/`WorkspaceRail` `width="ms"`, 264px. The width map lives in one class switch (`WorkspaceRail.tsx:71`). |
| R2 | Header "INITIATIVES 11": 11px uppercase label, the count in a grey pill, then + ⋯ « | `railHeading="prominent"`, plain count | Exists: `railHeading="label"` and `railCountStyle="chip"`. Omit + (V2). |
| R3 | Search directly under the header | Under the tabs and toggle | Exists (`SearchInput`); it just moves. |
| R4 | Nav list: "All initiatives / My initiatives / Sprints", 15px, no chrome | `Tabs` (Initiatives \| Sprints) plus `SegmentedControl` (Everyone \| Mine) | **NEW** `RailNavList` (items `{label, href/onSelect, current, count?}`), styled like `SubNavLayout`'s item. Or export `SubNavLayout`'s item list as a standalone composite if its markup fits. Items map to `?scope=all`, `?scope=mine` and `?lens=sprints`. The current item gets `aria-current`. |
| R5 | Groups: "IN PROGRESS" on the left, **9 right-aligned** | `groupHeading` title, plain count | Exists: `groupHeading="label"`. **NEW** `GroupedList groupCountAlign="end"`. |
| R6 | Rows are the title only, 15px, about 40px pitch, with ellipsis; the current row is tinted with a left bar | Title plus subline | Exists: drop `subline` in `initiativeListModel` and keep `currentStyle="bar"`. Put the full name in `title=` so truncation stays recoverable. |
| R7 | Footer "11 initiatives" | Same | Unchanged. |
| H1 | Title **22px semibold** with the "In progress" pill | `titleSize="lg"`, 28px bold | Exists: `titleSize="md"`, the default. |
| H2 | Two-line description, 15px, secondary ink | One line | Exists: `description`. **NEW**: render `\n` as a line break (`whitespace-pre-line`). The data comes from V3. |
| H3 | People row: muted "Owner", 32px avatar, name · rule · "SMEs", then avatar + name for each | `peopleStyle="names"` | **NEW** `ScopeHeader peopleStyle="inline"`: a label, then `Avatar` 32px plus name per person, with groups separated by a vertical rule. It sits on its own row under the description. |
| H4 | Repository ↗ and ⋯ | Same | Unchanged. |
| H5 | Tabs Overview · Work 11 · Decisions 2 · Agents · Contributors 3, 15px, on a rule | Same, 15px at `lg` | Keep the header's `border-b` rule. **Check** `itemClassName` at `titleSize="md"`, which currently only applies at `lg`, so the tab size and count gap match. |
| S1 | Under the tabs, one line: "**18** / 52 points delivered [bar] • **2** agents running • **$1.73** of $95 spent" | `StatStrip variant="inline"`: three cells with dividers | **NEW** `StatStrip variant="line"`: dot-separated, with `progress` drawn as an inline 150px bar after its label. Copy: "of $95 spent". A null allocation reads "$1.73 spent". |
| A1 | "Needs attention" 16px semibold, then a muted count **1** | Heading with no count | **NEW** `PageSection` `count` and `size="md"`, with `actions` on the right. Branding forbids page-styled titles, so the heading must be a library size. |
| A2 | One warning row: "Blocked" tag · bold title with the V4 subline under it · avatar and name ┆ "2 pts" ┆ "Open →", tinted, with a left bar | `Banner layout="callout"`, stacked | **NEW** `ActionRowList` additions: `tone="warning"`, `accent="bar"`, `leading` (a `Chip`), `columns` (right-aligned fixed-width cells with vertical dividers), and `action` (a link label replacing the chevron). |
| U1 | "Up next" with "View all 11 →" at the top right | "Plan next", with "See all" as a footer | Uses A1's `PageSection` with `actions`. The data is still `overviewModel.planNext`. |
| U2 | Three rows: title only (15px) · avatar and name ┆ "5 pts" ┆ ›; the columns line up across rows | Title, description, and text meta | `ActionRowList` `columns`, the same as A2. Drop `description`. The person cell is `Avatar` 28px plus name, the points cell reads "N pts". |
| C1 | Composer | Same | Unchanged. |

Vertical rhythm, measured from the mockup:
- title top 80
- description 118
- people 200
- tabs 258, with a rule at 281
- stats 309
- "Needs attention" 358
- attention row 384–434
- "Up next" 478
- rows at a 46px pitch

Pane gutters are 24px left and right. Nothing on the page sets a max width: rows and rules run to the pane's right gutter.

## 2. Slices

**L. ui-components, one additive release** (after 2.390.4). Branch from the latest `origin/main`.

The new props:
- R1 `width="ms"`
- R4 `RailNavList`
- R5 `groupCountAlign`
- H2 description pre-line
- H3 `peopleStyle="inline"`
- H5 `md` tab item size
- S1 `StatStrip variant="line"`
- A1 `PageSection count` / `size`
- A2 and U2 `ActionRowList` `tone`/`accent`/`leading`/`columns`/`action`

For each prop, add a vitest. Add a story at `Layout/ExplorerLayout › Initiative overview v2` that composes the whole mockup. Screenshot it at 1642×958 against the PNG.

Acceptance: `npm test && npm run lint && npm run lint:static-styles && npm run lint:hex-colors && npm run snapshot:exports && npm run build`.

**B. Pin:**
- Pin the full 40-character sha in `portal/package.json`, then `npm install`.
- `rm -rf portal/node_modules/.vite`.
- Check for new optional peers.
- Verify each new prop against the installed `dist/*.d.ts`.
- Update the CLAUDE.md pin line.

**M. Seed and mock** (parallel with L):
- `generate_program_seed.py`: add the second line to p-observability's summary (V3) and shorten `wi-obs-e2-b4.blocked_reason` (V4). Regenerate `seed_program.sql`; do not hand-edit it.
- `mock/initiatives.ts` and `mock/work-items.ts` mirror the change.
- Update the tests that assert the old strings: `overviewModel`, `composerPrompts`, and the middleware brief-field tests.
- Recapture wire snapshots with the full `MOCK_*` environment. Never hand-merge them.

**P. Portal** (after B and M):
- `InitiativeListRail`: R1–R6. It uses a nav list instead of Tabs plus SegmentedControl, and URL state is unchanged. Keep `aria-current`, and keep Sprints behind `?lens=sprints`.
- `ProjectDetailPage` header: H1–H5. On Work, keep the condensed header (`statsPlacement="below"`) at `titleSize="md"`.
- `InitiativeOverview`: S1, A1–A2, U1–U2, and drop V7's section.
- `ProjectsPage` list panes and Mine-empty: the V1 restyle only. Headings drop to the `md` sizes.
- Portal acceptance: `npx tsc --noEmit && npx vite build`, `validate-component-discipline`, `validate-branding --quick`, `validate-nav-parity` and `validate-honest-numbers`.

**D. Docs and journeys:**
- Re-walk `initiatives` and `initiative-detail` for all five roles. First-row-top will move up, since the rail rows are about 40px and the nav list is compact.
- Re-shoot `initiative-variants-build-*.png` as `initiative-v2-build-*.png`.
- Run `validate-orgiq-audit --seal`, then all validators without `--seal`.

## 3. Visual acceptance (headless Chromium, 1642×958, dev:mock after reset, u-theo)

1. The rail is 264±4px. The header reads "INITIATIVES" with a count pill and has no +. The search sits directly under it, then the three nav items. Groups read "IN PROGRESS" with the count at the right edge. Rows are one line, and the current row has a tint and a bar.
2. The title is 22px/600 with the pill beside it. The description is two lines. The people row shows 32px avatars, the Owner and SMEs labels, and a rule between the groups.
3. The tabs are 15px and sit on a rule. Directly under them is one stats line with the inline bar at about 35% and dot separators.
4. "Needs attention 1": one tinted row with a bar. It shows the Blocked tag, title, short reason, Eli Garcia, "2 pts" and "Open →", and "Open →" lands on Work b4.
5. "Up next" has "View all 11 →" at the right. There are three title-only rows whose person and points columns line up vertically across rows.
6. The composer is unchanged. There is no horizontal scroll, the clipped-text sweep finds 0 untitled clips, and there are 0 console errors.

## 4. Risks

- **Discipline:** every new visual (the columns, the nav list, the inline stats) goes into the library first. The page composes it with no inline styles and no raw elements. No "Composed locally" rows.
- **Honest numbers:** the attention count and "View all 11" come from rows, not stored totals. The stats line keeps v1's null handling.
- **Journeys:** the `initiatives` and `initiative-detail` logs go stale again, 10 of them. `settings` is untouched.
- **Width:** at 264px, long names truncate ("Real-time Analytics Pip…"). The row's `title=` must carry the full name, or the clipped-text sweep fails.
