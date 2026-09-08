# Distillation defects — role: member (u-theo)

## Open

### 4. Two `<main>` landmarks on every distillation page (minor, shared composite)
Unchanged and still open — inherited from the shared `SubNavLayout` composite, which this
repo must not edit (queued in `docs/ui-components-queue.md`). Re-confirmed this pass.


## Open (earlier passes)

### 4. Two `<main>` landmarks on every distillation page (minor, shared composite)
Every `/iq/distillation/*` page has two `<main>` elements: the shell's own and
`SubNavLayout`'s inner content pane (confirmed via `document.querySelectorAll('main')`
on Tiers, length 2, re-confirmed this pass). This is inherited from the shared
`SubNavLayout` composite (same shape `ObservabilityLayout` uses) rather than something
distillation's own pages introduce, so it's not fixable here per `CLAUDE.md` ("do NOT
modify ui-components"). Noting it because duplicate `<main>` landmarks are a real (if
minor) screen-reader navigation defect. Queue candidate for `docs/ui-components-queue.md`
if not already tracked there. Still open — no change since the last pass.

## Retracted (not a real defect)
An earlier pass of this audit flagged Lineage's keyboard handling as broken (Escape
not restoring focus to the ⌘K Search button, Tab going nowhere afterward). Re-testing
showed the identical symptom on Overview and Compactions later in the same session, so
it is a session-wide browser-automation tooling issue (synthetic Tab key presses
stopped moving `document.activeElement`), not a Lineage-specific product bug. See
`lineage.md`'s keyboard line for the corrected finding. This pass's re-audit confirms
Tab traversal works correctly session-wide now (verified on Tiers, Overview) — the
tooling issue did not reproduce.
Round-4 addendum: the tooling issue reproduced again this round (6+ Tab presses from
`<body>` on Compactions never moved `document.activeElement`, both on first load and
after a hard reload). Still treated as session-wide automation flakiness rather than a
product bug, since dispatching `Enter`/`.click()` directly on the same controls works
correctly every time (see compactions.md) — but it means live sequential-Tab evidence
could not be captured this round either. Worth a plain-human spot check outside this
tooling if it keeps recurring.
Round-5 addendum: a related but distinct tooling artifact appeared this round — partway
through the org-leader pass, the automated browser tab lost OS/window focus entirely
(`document.visibilityState` stuck at `'hidden'`, confirmed even for a brand-new tab,
after full page reloads, and after window resizes). Under that condition xyflow's
post-mount `ResizeObserver` node-measurement stalls (see closed #8 below), while
ordinary `<button>` clicks and data polling kept working the whole time — confirming
it's a rendering-measurement stall specific to backgrounded tabs, not a general input
failure. Re-testing member's own node-click after the org-leader pass reproduced the
identical stall, proving it's session-wide and not role-specific. Screenshots taken
while `visibilityState` is `'hidden'` were also shown to be unreliable this round (they
displayed a stale, correctly-rendered frame from before the tab backgrounded, while the
live DOM and accessibility tree at the same moment showed the nodes genuinely
unmeasured and un-clickable) — a methodology note for any future round that leans on
screenshots alone to verify xyflow state.

## Closed

### 22. The Artifacts drawer's mini-lineage clips four of its eight node cards — CLOSED 2026-09-06
Re-observed as u-theo at 23:27, Chrome 1560px (innerWidth 1560, innerHeight 856),
dev:mock, on `/iq/distillation/artifacts` — and independently as u-vera at 23:30,
identical to the pixel.

The fix landed exactly where the defect pointed: `LineageFrame.tsx` now gives the
compact variant a `fitViewOptions` of its own — `{ padding: 0.08, maxZoom: 1.5 }`,
with **no `minZoom`** — while the full-page canvas keeps `{ padding: 0.12,
minZoom: 0.6, maxZoom: 1.5 }`. Dropping the floor is what this entry asked for,
and it is scoped to the variant that needed it.

Measured, row 1 ("Rerun-and-diff triage for a flaky collector-fleet test"):

- canvas **680 × 260px**, x 860 → 1540 (the 180–260 clamp still pinned at its max —
  unchanged, and it was never the problem)
- viewport transform **zoom 0.500**, i.e. below the old 0.6 floor, which is only
  possible now that the floor is gone
- the 8 cards' bounding box is **630 × 169px**, x 885 → 1515 — **25px clear of the
  canvas on the left and 25px on the right**, **92.6%** width fill
- **0 of 8 nodes clipped** on any edge (each `.react-flow__node` rect compared
  against the `.react-flow` rect on all four sides)
- every id renders: obs-021, obs-022, obs-023, cl-019, art-001, fact-001, fact-002,
  skill-flaky-test-triage

Row 2 ("Collector-fleet Fargate tasks are ARM64") is identical in every number:
680 × 260 canvas, zoom 0.500, 630px bounding box, 25px/25px clearance, 92.6% fill,
**0 of 7 clipped**, with obs-024 / obs-025 / obs-026 / cl-020 / art-003 / fact-005 /
insight-arm64-fargate all legible. The 756px-wide, 0.6-pinned render this entry was
filed on does not reproduce on either row.

No regression to the surface the earlier fix was for: the full-page
`/iq/distillation/lineage?focus=art-001` still renders 9 nodes into a 1068 × 514
canvas at **zoom 0.756**, a 953 × 343px bounding box = **89.2% width fill**, nothing
clipped — the same numbers as before this change.

Both roles' `artifacts.md` now read `verdict: pass`.

### 21. Lineage's 13 edges were tab stops of their own, announcing raw ids — CLOSED 2026-09-06
Re-observed as u-theo at 15:21, Chrome 1560px, dev:mock, on
`/iq/distillation/lineage?focus=art-001`.
The fix landed as the one direction this defect asked for and nothing more:
`portal/src/pages/distillation/LineageFrame.tsx:289` now sets `edgesFocusable={false}`
on the `<ReactFlow>` element, leaving `nodesFocusable` alone because the page instructs
"Click or Tab + Enter a node for its record".
Measured: `.react-flow__edge[tabindex]:not([tabindex="-1"])` is **0** where it was 13,
and every one of the 13 `.react-flow__edge` groups now carries no `tabindex` attribute
at all — the edges still render and still keep their `aria-label` for anything that walks
the SVG, they are simply out of the tab ring. The canvas's focusable inventory is now
**22**, none of them an edge: 9 xyflow node wrappers, our 9 inner `role="button"` cards
and the 4 Controls buttons. Page-wide the surface went from 64 tabbable / 60 visible to
**51 tabbable, 51 visible, all 51 accepting focus** — exactly 13 fewer, the 13 edges and
nothing else. Nodes still act: focusing the "Session sess-obs-03" card and dispatching
Enter opens its record (Session / sess-obs-03 / Close / repo / box_id / Focus here),
"Focus here" re-centres to ?focus=sess-obs-03 and Escape clears back to the picker.
Edge labels were re-checked at the same time and are unaffected — a three-label
`elementFromPoint` spot check returned 143/143 label-topmost in light and 143/143 in
dark, 0 label-on-label, 0 label-under-card.
Lineage now matches its sibling flows, which measure 0 focusable edges on Overview and
Compactions (closed defect #11).

### 19. Lineage edge labels landed on each other, two rows read "supports to" — CLOSED 2026-09-06
Re-observed as u-theo at 14:57 and independently as u-vera at 15:15, Chrome 1560px,
dev:mock, on `/iq/distillation/lineage?focus=art-001`.
The fix landed as the first direction this defect listed: `staggerLabelAnchors()`
(`portal/src/pages/distillation/distillationFormat.ts:621`, `LABEL_STAGGER_Y = 16`)
groups every label by its rounded anchor point and spreads each colliding group
symmetrically about that point, keeping input order stable so a re-render never
reshuffles them; `LineageFrame.tsx:225` feeds every edge's anchor through it before
building the edge list.
**The measurement — the same proof that found the defect.** A 1px `elementFromPoint`
walk across the FULL width of all 13 labels, the label layer's `pointer-events`
temporarily forced to `auto` so hit-testing follows paint order, then restored.
- **Light theme: 578 sample points — 578 return the label itself, 0 return a different
  label, 0 return a node card.**
- **Dark theme** (`data-theme="dark"`; pill background computes to `rgb(23, 32, 51)` on
  a `rgb(38, 50, 71)` border over a `rgb(11, 18, 32)` body, so the pill still carries its
  own ground): **578 / 578 / 0 / 0**, identical.
Per label, self/total, the same in both themes and for both roles: distilled into 51/51,
supports 39/39 ×4, published as 53/53, merged into 50/50 ×3, written by 43/43 ×3.
The 152 label-on-label points are gone. The stagger is visible in the coordinates: the
three labels that shared x 1096 now sit at y **326.8 / 338.6 / 369.7**, and the nine that
shared x 711 at **332.7 / 363.8 / 375.6 / 400.7 / 412.5 / 437.7 / 449.5 / 480.5 / 517.5**
— an 11.8px screen pitch, which is the 16 flow-unit stagger at the fit-to-view zoom.
Confirmed by eye at 4× in both themes: the stack that used to read "supports to" now
renders three separate pills ("supports" / "published as" / "supports"), the observation
column shows nine distinct pills instead of four overlaid pairs, and no hop is unlabelled.
#17 still holds alongside it — every pill is opaque over the card it laps. Closed on both roles.

### 20. Review calibration banner refreshed on a 60s poll, not on the decision — CLOSED 2026-09-06
Re-observed as u-vera at 15:27, Chrome 1560px, dev:mock, on `/iq/distillation/review`.
`ReviewPage.tsx` now pulls `refresh` out of the sampling `useFetch` as `refreshSampling`
and calls it in the same success path as the review list's `refresh()`, so a verdict
invalidates the banner instead of waiting for the next 60-second tick.
**The measurement.** Banner before the decision: "· 4% of L1 sampled · **22 reviewed in
30d · 4 pending now · 86.4% agreement**", over exactly 4 Pending cards. Submitting
**Agree on cl-019** with a note, polling the banner's text every 50ms from the click:
- the queue dropped 4 cards → 3 at **998 ms**
- the banner rewrote to "· 4% of L1 sampled · **23 reviewed in 30d · 3 pending now ·
  87% agreement**" at **1000 ms** — the same poll tick
That one second is the two refetches' round trip, not a poll interval; the old behaviour
left the headline contradicting the queue beneath it for up to 60s. The Decided tab
carried the new row at once with its note and author ("cluster cl-019 · Agree · “Audit
re-check of defect #20 — evidence matches the cluster.” — Vera Green"). Member cannot
decide, so this is closed from the org-leader side and re-read as correct from member's.

### 17. Lineage edge labels buried under the node cards — CLOSED 2026-09-06
Re-observed as u-theo at 14:24 and independently as u-vera at 14:28, Chrome 1551px,
dev:mock, on `/iq/distillation/lineage?focus=art-001`.
The fix landed as the first of the three directions this defect listed: paint the label
layer above the nodes rather than try to squeeze a 37–52px label into a 29.2px gap.
`.lineage-canvas .react-flow__edgelabel-renderer` computes to **`z-index: 6`** against a
node layer of `auto`, and each label carries its own opaque pill — computed
`background-color` **`rgb(255, 255, 255)`** in light and **`rgb(23, 32, 51)`** in dark
(toggled with the page's own `data-theme="dark"`, `portal/src/lib/preferences.ts:57`),
neither an `rgba(…, 0)`, on a 1px border of `rgb(223, 228, 236)` / `rgb(38, 50, 71)`.
**The measurement.** A 1px `elementFromPoint` walk across the FULL width of all 13
labels — 564 sample points, the label layer's `pointer-events` temporarily forced to
`auto` for the walk so hit-testing follows paint order and restored afterwards.
**0 of the 564 points return a node card**, in either theme. 412 return the label
itself; the remaining 152 return another label, which is a separate defect (#19).
The three the coordinator asked about:
- **"written by"** (obs-023 → sess-obs-03) — box **709.7–752.2**, 42.5px wide. Card to
  its left `obs-023` ends at **698.0** → gap **+11.7px**; no card in its band to the
  right. Walk **42/42 the label**.
- **"published as"** (art-001 → skill-flaky-test-triage) — box **1090.2–1142.2**, 52.0px
  wide. Card to its left `art-001` ends at **1078.5** → gap **+11.7px**; the `fact-001`
  card to its right starts at **1107.8**, so **34.4px** of the pill lie over that card —
  and the walk is **51/51 the label**, i.e. those 34.4px are painted by the pill, not by
  the card. This is the case that used to lose its tail.
- **"supports"** (fact-002 → art-001) — box **1090.2–1128.8**, 38.6px wide. `art-001`
  ends at **1078.5** → gap **+11.7px**; `fact-001` starts at **1107.8**, 21.1px of
  overhang. Walk **38/38 the label**. It no longer renders as "supp".
The 29.2px inter-column gap is unchanged (698.0→727.3, 888.2→917.5, 1078.5→1107.8); it
simply stopped mattering once a label is allowed to cover a card. Closed on both roles.

### 18. Review calibration banner's counts were a constant — CLOSED 2026-09-06
Re-observed as u-vera at 14:32 (the mutating half) and as u-theo at 14:34, Chrome
1551px, dev:mock, on `/iq/distillation/review`.
`queueDepth`, `reviewedLast30d` and `agreementRatePct` are now computed from
`MOCK_REVIEW_SAMPLES` (`middleware/src/providers/distillation.ts:323–341`) — the same
list the Pending and Decided tabs render — instead of the old `MOCK_SAMPLING` constants
(6 / 214 / 87).
**On load:** "Calibrated — 85.7% agreement at a 4% sample … · 4% of L1 sampled · 21
reviewed in 30d · 5 pending now · 85.7% agreement", over exactly **5** Pending cards,
with `GET /api/distillation/review` reporting 5 pending / 18 agree / 3 disagree — 18 of
21 decided is 85.714%.
**After deciding one sample** (Agree on cl-022 / `rev-006`, note "Evidence matches the
cluster; agreeing."): a "Marked agree" toast, the card left Pending (**4** remaining) and
appeared at the top of Decided with an Agree chip, the note in quotes and the attribution
**— Vera Green**. `GET /api/distillation/sampling` recomputed at once: `queueDepth`
5 → **4**, `reviewedLast30d` 21 → **22**, `agreementRatePct` 85.7 → **86.4** (19 agrees
of 22 decided = 86.36%), and the verdict sentence re-rendered around the new figure.
**The banner then read** "· 4% of L1 sampled · 22 reviewed in 30d · 4 pending now ·
86.4% agreement" over a queue of 4 cards: pending down one, decided up one, percentage
recomputed, headline and list agreeing. Confirmed from the member side at 14:34 — same
banner, same 4 cards, `GET /api/distillation/review` 4 pending / 19 agree / 3 disagree.
The permanent contradiction is gone. What remains is a refresh-timing window — the
banner polls every 60s and a decision does not invalidate it — filed separately as
Open #20.

### 8. Compaction flow: mouse click on a tier node doesn't navigate — FIXED, verified 2026-09-05 (round 5)
Root cause found and fixed: `CompactionFlowFrame.tsx` was rebuilding its `nodes`/`edges`
arrays from scratch on every render (including the page's own polling tick and an
unrelated one-time re-render from the reduced-motion hook), so xyflow's internal
per-node measurement pass could never complete — nodes stayed `visibility: hidden`
forever, `fitView` never ran (viewport transform stuck at the identity matrix), and a
real mousedown/mouseup landed on the pane instead of the node (`.click()`/dispatched
`Enter` bypassed this and worked, which is why the round-4 fix attempt — adding a
pane-level `onNodeClick` — didn't help; the pane-vs-node distinction was never the
actual break). The fix memoises `nodes`/`edges` on `[model]` (and `[model,
reducedMotion]`) via `useMemo`, with navigation threaded through a `useRef` so the
`onNavigate` callback's identity can't churn the memo. A hooks-order regression was
introduced and caught while landing this fix — the new `useMemo` calls were briefly
placed after the component's early `if (error)/if (loading)` returns, violating the
rules of hooks and white-screening the page on re-render — corrected by moving all
hooks above the early returns (see the in-file comment recording why).
Verified for member: `.react-flow__node` = 4, all `visibility: visible`;
`.react-flow__edge-path` = 3, lengths 186/186/192px; `.react-flow__viewport`'s computed
transform is a genuine fitView matrix (`matrix(0.692308, 0, 0, 0.692308, 86, 65.7308)`),
not identity; `document.elementFromPoint()` at the L1 node's center resolves inside
`.react-flow__node`; and a REAL mouse click at that pixel navigated the browser to
`/iq/distillation/tiers?level=L1`. This is the first round a genuine mouse click has
navigated. Org-leader shares the identical code path (no role branching in node
rendering/measurement/click handling) and was independently confirmed via the button-
driven parts of the same page (Compact L0→L1 and L1→L2 both fired real
`POST /api/distillation/compact` calls and showed a live running→succeeded transition)
before the session-wide tab-focus artifact above stalled a live re-click specifically
for org-leader. See compactions.md (both roles) for full detail.

### 7. Compaction flow shipped — DELIVERED 2026-09-05 (round 4); two of three presentation defects fixed live during this audit
The requested compaction flow (top-of-page ladder: L0 Observations → L1 Clusters → L2
Artifacts → Library, 4 nodes, counts + health chips, merge-edge labels, click-to-navigate,
running-state animation) is implemented and its data layer is correct: counts and health
chip tones match Overview exactly and update live as compactions run, node aria-labels
are correct and accessible, and Compact buttons correctly appear only for org-leader.
This round's audit initially found three presentation bugs (edges never rendered a
visible connecting line, labels overlapped the node cards, and a mouse click on a node
didn't navigate). A fix landed in `CompactionFlowFrame.tsx` mid-audit — re-testing
afterward confirms the edge-rendering and label-overlap bugs are FIXED (edges now draw
real, correctly-colored/dashed lines with arrowheads, and labels sit legibly above each
line — confirmed via pixel-level before/after screenshot comparison) and the
running-state dash-flow + travelling-dot animation was caught on screen exactly as
specified. The mouse-click-on-node bug was NOT fixed by the accompanying change — see
Open #8.

### 5. Artifacts table needs its own horizontal scroll — FIXED, verified 2026-09-05 (round 3)
Re-tested at 1440px. The `Artifact` title/description column is now capped at 508px
(was 904.8px, uncapped) with `Type` (101px), `Status` (112px), `Library` (108px) and
`Clusters` (94px) all fully inside the viewport. The table's own `overflow-x-auto`
wrapper needs no scroll at all: `wrapperScrollWidth` 924 = `wrapperClientWidth` 924
(was 1286 vs 924). Verified identically for member and org-leader. See artifacts.md
for both roles.

### 6. Lineage node record panel is reachable only via a non-obvious nested scroll — FIXED, verified 2026-09-05 (round 3)
Clicking a lineage graph node that isn't the already-`?focus=`ed one now opens the
record panel as a right-hand aside BESIDE the graph, inside the same viewport —
`document.scrollingElement.scrollHeight === innerHeight` (702=702) with the panel open,
no scroll of any kind needed to see it. Fixed in `LineageFrame.tsx`: the frame now lays
out the graph and an optional `aside` side by side via `xl:flex-row` at the 1280px
breakpoint, and the graph pane's `preventScrolling` flips to `false` below that
breakpoint so a wheel gesture over the canvas scrolls the page instead of being
captured for zoom (confirmed by source read; the actual sub-1280px stacking was not
independently verified via a live viewport resize — `resize_window` did not change this
automation session's reported `innerWidth`). Verified identically for member and
org-leader, including "Focus here" and Escape. See lineage.md for both roles.

### Compact resolves instantly with no observable running state — FIXED, verified 2026-09-05 (round 3)
Round 2 shipped the middleware fix (`compactNow` inserts a `running` job that completes
after ~3s) but reported the page-side 2s poll as still in flight, and neither round
actually caught a `running` row on screen. This round did: clicking "Compact L0 → L1"
produced an immediate toast ("Compacting L1 — merging L0 into L1") and a `running` row
with a visible pulse dot, `IN`/`OUT` both 0 and `TOOK` reading "running…", which flipped
to `succeeded` within ~4 seconds with no reload. Reproduced twice (L0→L1 and L1→L2) —
see org-leader/compactions.md for full detail including the real 7-artifact L1→L2
result and its cross-surface propagation to Tiers/Artifacts/Lineage.

## Closed

### 1. Tier card item counts didn't match the real item lists (tiers) — FIXED, verified 2026-09-05
Re-audited against the current bundle (note: the bundle changed mid-audit from a
3-stacked-card Tiers layout to a compact single-row `SegmentedControl` — see tiers.md).
Under both layouts, the level counts (L0/L1/L2) equal the real
`fetch('/api/distillation/items?level=...')` totals paged to `next_cursor: null`: 75/22/8,
confirmed exactly. Verified again after running two live compactions as org-leader
(L1 rose to 25, L2 rose to 15) — the displayed counts tracked the change immediately on
both Tiers and Overview, so this isn't a one-time coincidental match.

### 2. Tiers had no filter or search control at all (tiers) — FIXED, verified 2026-09-05
Tiers now has Repo, Initiative, Kind (L0 only — the Kind select correctly disappears
when L1/L2 is selected) and a debounced search box, all URL-backed (`?level=`, `?q=`)
and surviving a hard reload. A filter-driven empty state now exists and works: searching
"zzzznonexistentquery" renders "No items / No L0 items match search ..." with a working
"Clear filters" button. Verified for both member and org-leader.

### 3. `/api/health` shape drift crashed the whole shell — presumed fixed, not re-triggered
Not independently re-triggered this pass (the specific mid-restart race is hard to force
on demand), but zero console errors were observed across every surface and reload in this
entire audit, and the disposition's fix (`Layout.tsx` guards `health.mocks` by shape) is
a straightforward, low-risk change. Leaving closed on the strength of the disposition;
re-open if a shape-drift crash is ever seen again.

## Dispositions (2026-09-05 13:40, superseded in part by the 2026-09-05 re-audit above)

- **#1 fixed** — confirmed by re-audit, see Closed.
- **#2 shipped** — confirmed by re-audit, see Closed.
- **#3 fixed** — presumed by re-audit, see Closed.
- **#4 queued** in `docs/ui-components-queue.md` (SubNavLayout's inner `<main>`) — still open.
- **#5 shipped but incomplete** — the column trim landed but the title column still has
  no max-width, so the defect persists under a new shape. See Open #5.
- **Sign-in roster:** u-vera added to `SelectContextPage`'s curated list — confirmed
  present and used directly for org-leader in this round's audit.

## Dispositions, round 2 (2026-09-05 14:30)

- **Compact resolves instantly — fixed (middleware).** `compactNow` now
  inserts a `running` job (`finishedAt: null`, empty `produced`) and completes
  it after a 3s run window, minting the clusters/artifacts at completion.
  Verified live: `POST /compact` → `comp-91 running`; 4s later
  `/compactions` → `succeeded`, 6 in / 3 out, `produced.cluster_ids`
  `cl-901..903`. Pinned by `distillation-compaction.test.ts` ("runs before it
  succeeds", fake timers). The page-side 2s poll while a job is running is in
  flight.
- **Artifacts title column unbounded — in flight** (title truncation + fixed
  narrow columns so a row fits a 1240px pane without the table's own scroll).
- **Lineage record panel only reachable by scrolling the inner pane — in
  flight** (the panel moves beside the graph as a right-hand aside inside
  one viewport-height frame).
- **Density rule** (`first-row-top` ≤ 640px on list surfaces) added to the
  protocol and validator after the user's review; Tiers rebuilt as one
  selector row (segmented L0·75 / L1·22 / L2·8 + health chips + one line),
  and the other list pages' descriptions cut to one line.

## Dispositions, round 3 (2026-09-05 15:55)

- **#5 fixed** — confirmed by re-audit, see Closed.
- **#6 fixed** — confirmed by re-audit, see Closed.
- **Compact running state — fixed and observed live** — confirmed by re-audit, see Closed.
- **#4 (two `<main>` landmarks)** — still open, unchanged, still queued in
  `docs/ui-components-queue.md`.
- **No new product defects found this round.** One testing-process caveat, not a
  product bug: this round's own "Compact L0 → L1" click on org-leader legitimately
  produced 0 items, because the L0 pool's not-yet-clustered observations had already
  been exhausted by the identical test in round 2 (comp-91, still visible in history)
  and the middleware was never restarted between rounds. The empty-pass path itself
  behaves correctly (succeeded status, no fabricated output, "Produced" section
  correctly omitted) — see `providers/distillation.ts`'s `completeCompaction`. Running
  the L1 → L2 pass instead produced a full, real result (7 new artifacts) and exercised
  every part of the round-3 acceptance criteria. A middleware restart before the next
  audit round would reset the mock corpus and let L0 → L1 produce non-trivial output
  again.

## Disposition, round 3 caveat (2026-09-05 15:05)

The "L0 pool exhausted after one pass" caveat is closed: the mock now
simulates write pressure (`simulateIngest` in `providers/distillation.ts`) —
new observations land at the Overview's advertised ingest rate on every
read, one minute-tick at a time, so repeated Compact L0 → L1 passes find
material. Pinned in `distillation-compaction.test.ts`.

## Fixed (pending re-audit) — flow agent, 2026-09-06 12:56

### #10 — merge-edge labels unreadable
Root cause: `PROCESS_FLOW_COL = 262` (`distillationFormat.ts`) against
`NODE_WIDTH = 168` (`CompactionFlowFrame.tsx`) left only a 94px gap between tier
cards, and the merge-edge label (`mergeEdgeLabel()`, e.g. "140 in · 62 out ·
56% deduped · 1h ago") measures ~123px — every merge label overhung both
neighbouring cards.
Change: widened the process-flow column pitch, `distillationFormat.ts:468`,
262 → 370.
Arithmetic: gap = pitch − NODE_WIDTH = 370 − 168 = 202px, comfortably clearing
the ~123px label — the Compactions ladder's own working pitch
(`COMPACTION_FLOW_COLUMN_WIDTH = 360`, gap 192px) clips the identical label by
only 3–5px, so 202px clears it outright. Verified in `processFlowModel.test.ts`
("the pipeline column pitch leaves room for a merge-edge label").

### #11 — Space ignored, 32 Tab stops for 11 doors
Root cause: two issues in `CompactionFlowFrame.tsx`. (1) The node's own
`onKeyDown` only checked `e.key === 'Enter'`, so `role="button"` ignored
Space, one of the two platform activation keys. (2) xyflow's outer
`.react-flow__node` wrapper is focusable by default (`nodesFocusable` defaults
to `true`), and our own inner div was *also* focusable — every node cost two
Tab stops instead of one — and all 10 edges were focusable with no activation
of their own, contributing 10 more dead stops (32 total for 11 real doors).
Change: `onKeyDown` now handles `' '` alongside `'Enter'` and calls
`e.preventDefault()` before activating (matches native `<button>` Space
behaviour, so the page doesn't scroll); `<ReactFlow>` now sets
`nodesFocusable={false}` and `edgesFocusable={false}` (both verified against
`node_modules/@xyflow/react/dist/esm/types/component-props.d.ts`), leaving our
own inner `role="button"` div as the one focusable element per node. Result:
11 Tab stops for 11 nodes, 0 for edges.

### #12 — 403 rendered as a lying 0
Root cause: `ProcessFlow.tsx` guarded only on `Array.isArray(botsData?.bots)`
and fell through to `0` on a failed fetch, indistinguishable from "0 bots ran
today," and the `bots` source node still navigated to `/admin/bots`, which the
router bounces a member from. The model already had the right shape for this
(`bundleSkills: number | null`) but it wasn't applied to `botRunsToday`.
Change: `ProcessFlowInputs.botRunsToday` is now `number | null`; `ProcessFlow.tsx`
passes `null` when `useFetch`'s `error` is set (covers a 403 even if stale
array data lingers from an earlier successful poll) or the shape isn't an
array. `processFlowModel` builds a distinct `bots` node when null — `count:
null`, `ariaLabel: 'Bot runs, unknown — no access to bot data'`, and no
`navigateTo` (dropped rather than offering the route the caller can't open).
`CompactionFlowNode.count`/`navigateTo` are now `number | null` / optional
respectively; `CompactionFlowFrame.tsx` renders a `null` count as "—" and
renders a node with no `navigateTo` as a plain, non-interactive
`role="group"` card (no click handler, not a Tab stop) instead of a door that
bounces the reader out of Distillation. A real `0` still renders and navigates
normally — the change only distinguishes "unknown" from "counted and it's
zero." Verified in `processFlowModel.test.ts`.

## Fixed (pending re-audit) — pages agent, 2026-09-06 12:59

### #13 — Artifacts and Compactions rows are mouse-only
Root cause: both tables relied on the library `DataTable`'s `onRowClick` alone
— a bare `<tr onClick>` with no `tabIndex`/`role`/keydown, so Tab skipped
every row. Fix: `ArtifactsPage.tsx`'s title cell and `CompactionsPage.tsx`'s
"Started" cell now render a real `Button` (`variant="ghost"`, no border/bg,
underline on hover) that calls `setOpenId` and `stopPropagation()`s so the
row's own mouse click still works — the same pattern already used in
`library/LibraryPage.tsx` and `promotions/PromotionsPage.tsx`. Added the two
pages to the existing `onRowClick` row in `docs/ui-components-queue.md`
rather than filing a new one.

### #14 — Lineage edge labels painted underneath the cards they point past
Root cause: the default xyflow edge label sits at the straight-line midpoint
between source and target, in the same flow coordinates `layoutLineage`
(`distillationFormat.ts`) uses to place nodes on a fixed column grid. Two
shapes of this bug: `published_as` runs artifact (column 2) → library_item
(column 4) and skips the Fact column (3) entirely, so its midpoint lands
exactly on the Fact node — a 45px-wide label centered dead-on a 220px-wide
card is fully covered, not just clipped. `written_by` (observation ↔ session,
both column 0) never leaves its own column, so its midpoint can land on a
*different* node stacked in that same column instead (`obs-023` on this
role's pass).
Fix, entirely in `LineageFrame.tsx` (the column pitch itself is a private
constant in `distillationFormat.ts`, not exported and not this file's to
touch): a custom xyflow edge type (`LineageEdgeComp`, via `BaseEdge` +
`EdgeLabelRenderer` + `getBezierPath`) renders the connector but positions
the label itself at `Math.min(sourceX, targetX) + NODE_WIDTH + LABEL_INSET`
(220 + 16), i.e. 16px into the gap immediately after whichever endpoint sits
further left. Since `layoutLineage`'s own "no node-on-node overlap" contract
means the column pitch is provably wider than `NODE_WIDTH`, that gap band
never holds a node at any row, for any edge — so the label can never land on
top of one regardless of how many columns the edge spans or skips. Vertically
it sits at the midpoint of the two endpoints' `y`.

### #15 — Filtering the Compactions history rewrites the tier ladder
Root cause: `CompactionsPage.tsx` filtered jobs SERVER-side (the Merge/Status
facets were query params on `GET /api/distillation/compactions`) and handed
that same filtered array straight to `<CompactionFlow jobs={…}>`, which feeds
`compactionFlowModel`'s `latestJobFor(level, jobs)` — so selecting "L1 → L2 +
Failed" left no succeeded L2 job in the array `latestJobFor` searched, and
both ladder edges fell back to "no merges yet" seconds after a real merge had
succeeded.
Fix: the page now fetches `/api/distillation/compactions` unfiltered once —
that full list feeds `<CompactionFlow>` (and the running-job toast-tracking
effect) — and the table's own rows are narrowed client-side by a new pure
helper, `filterCompactionJobs` (`compactionsFilter.ts`, tested in
`__tests__/compactionsFilter.test.ts`, 5 cases). The ladder now always
reflects the true job history regardless of what the table is filtered to.

### #16 — Review's Cancel drops focus on `<body>` (org-leader-only; member has no decision form)
Root cause: `SampleCard`'s Cancel button just cleared `choice`/`note` with no
focus restoration. Fix: `ReviewPage.tsx`'s Agree/Disagree buttons each carry
a stable `data-review-trigger` (`` `${sample.id}:agree` `` /
`` `${sample.id}:disagree` ``); the new `cancelForm()` captures `choice` before
clearing it, then — in a `requestAnimationFrame` (the same tick pattern as
`sprints/GrantsPanel.tsx` and `marketplace/EstimateDrawer.tsx`, needed
because the note form has already unmounted and the Agree/Disagree pair is a
fresh render by the time the callback runs) — re-queries that selector and
focuses it.


## Closed on re-audit — 2026-09-06 13:18–13:24, u-theo (member), Chrome 1552px, dev:mock

Every leg re-observed on this role. Numbers below are this pass's measurements; the
org-leader pass at 13:27–13:33 carries the matching numbers for the role-split legs.

### 10. Overview's merge-edge labels are drawn under the tier cards — CLOSED
The process-flow column pitch read straight off the node transforms is now **370px**
(columns at 0 / 370 / 740 / 1110 / 1480), so at the flow's 0.5 zoom a tier card is 84px
wide on screen and the gap between two of them is 101px. The L0→L1 label
("140 in · 62 out · 56% deduped · 2h ago") is 103px wide at x 762–865 against L0's right
edge at 763 and L1's left edge at 864 — 1px of its own padded box overhangs each card and
the sentence inside reads end to end. The L1→L2 label is 102px at x 948–1049 in a gap of
exactly that width: zero overlap with any node. Was 33px and 32px under the cards on both
sides. The other four labels overlap nothing.

### 11. Flow nodes ignore Space, and the flow costs 32 Tab stops for 11 doors — CLOSED
`.react-flow` now holds **one focusable element per node** — 10 for member (the Bot runs
node is deliberately not a door for this role; org-leader counts 11 for 11) — while
`.react-flow__edge` with `tabIndex >= 0` is 0 and `.react-flow__node` wrappers with
`tabIndex >= 0` is 0, so `nodesFocusable={false}` / `edgesFocusable={false}` landed.
Whole-page sweep: 38 tabbable, 37 distinct, all reached in a 50-press Tab run with nothing
missing and all 10 doors among them. **Space** on the focused L2 node navigates to /iq/distillation/tiers?level=L2 with
`scrollY` still 0, so `e.preventDefault()` is doing its job; Enter is unchanged. The same
change reaches the Compactions ladder — 4 focusable for 4 nodes, 0 for edges.

### 12. Overview renders a 403 as the number 0 — CLOSED (both halves)
`GET /api/bots` still returns 403 for member
(`{"error":"Forbidden","action":"ManageBots","role":"member","tenant":"orgiq"}`), and the
node now says so: text "Bot runs —", `aria-label` "Bot runs, unknown — no access to bot
data", `role="group"`, `tabIndex -1`, and a click that leaves `location` on
/iq/distillation/overview instead of bouncing to /admin/bots → /iq/projects. The
org-leader pass is the control — 200, "Bot runs 6", a real door to /admin/bots.

### 13. Artifacts and Compactions rows are mouse-only — CLOSED
Artifacts: 14 of 14 rows carry a real `<button>` in the title cell and a 70-press Tab sweep
visited all 14 (57 tabbable, 51 distinct, nothing missing); Enter opens the drawer and moves
focus to its Close button; Escape closes it and returns focus to the row button.
Compactions: 11 of 11 rows carry a `<button>` in the Started cell, all 11 visited in a
60-press sweep (50 tabbable, 47 distinct), Enter opens comp-91's drawer (WHAT IT MOVED /
COST / PRODUCED art-901…art-906) and Escape returns focus to the row.

### 14. Lineage edge labels are painted entirely underneath the cards — CLOSED
Measured by walking each label's text rect pixel by pixel with `elementFromPoint`:
"published as" is 45px of text with 17px behind a card (was 45 of 45) and reads in full;
"written by" is 35px with 6px behind (was 35 of 35). Nothing is covered any more. The
residual leading-glyph clip is filed separately as #17.

### 15. Filtering the Compactions history rewrites the tier ladder — CLOSED
With Merge "L1 → L2" + Status "Failed" selected the table is empty ("No compactions / No
compaction jobs match this filter.") while the ladder still describes the real pipeline:
"140 in · 62 out · 56% deduped · 2h ago" on L0→L1, "13 in · 6 out · 54% deduped · 58m ago"
on L1→L2, node counts 193 / 22 / 14 and the "published as → Library 5" hop, all unchanged
from the unfiltered view. (org-leader re-ran the same combination at 13:31 with the same
result.)

### 16. Review's Cancel closes the note form and drops focus on `<body>` — CLOSED
Verified on the org-leader pass (member has no decision form and, as this role's review log
records, `document.querySelectorAll('[data-review-trigger]').length` is 0 here — the
controls are absent from the DOM, not disabled). On org-leader the six pending cards carry
12 `[data-review-trigger]` buttons and Enter on Cancel returns focus to the
`[data-review-trigger="rev-005:agree"]` button that opened the form.


## Fixed (pending re-audit) — coordinator, 2026-09-06 14:20

- #17: the lineage edge label was positioned by its CENTRE at the inset
  (`translate(-50%, -50%)`), so half its width sat back over the card to its
  left and clipped the first characters. It now anchors its LEFT EDGE there
  (`translate(0, -50%)`), which is what the inset was computed for.


## Re-audit — 2026-09-06 13:47–14:10, both roles, Chrome 1552px, dev:mock

The coordinator's "Fixed (pending re-audit) — 2026-09-06 14:20" note above concerns
#17 only. Re-audited as u-theo on `/iq/distillation/lineage?focus=art-001` with a
frame forced before every measurement:

- **#17 stays OPEN.** The left-anchor change landed and the leading clip is gone —
  `leadCoveredPx` is 0 for all 13 labels and every label starts +11.7px right of the
  card on its left. But the labels are 37–50px wide and the inter-column gap is 29.2px,
  so 7 of 13 now lose 19–33px off their tail to the card on the right and "supports"
  renders as "supp". See the rewritten #17 above for the per-label numbers. Lineage is
  `verdict: fail` on both roles this round; every other surface re-observed as passing.
- **#10, #11, #12, #13, #14, #15, #16 stay CLOSED** — re-observed this round, all
  still fixed. #16 needs a caveat for whoever checks it next: the focus restore is
  inside a `requestAnimationFrame` (`ReviewPage.tsx:135`) and rAF does not fire on this
  display-less machine, so `document.activeElement` reads `<body>` after Cancel until a
  frame is forced (1px resize + screenshot), after which it correctly reads
  `rev-005:agree`. The environment lies here, not the product.
- **#18 is new** (see above): the Review banner's counts are a constant and disagree
  with the queue as soon as anyone decides an item.


## Fixed (pending re-audit) — coordinator, 2026-09-06 15:35

- #17 (second attempt, from the measurements in the re-audit): no horizontal
  anchor can work — the inter-column gap is 29.2px and a relation label is
  37–50px wide, so centring buries the head and left-anchoring buries the
  tail. The label layer now paints ABOVE the nodes
  (`.react-flow__edgelabel-renderer { z-index: 6 }`, scoped to
  `.lineage-canvas`), and each label carries its own opaque pill ground
  (`--color-surface` fill, `--color-border` hairline, 4px radius) so it stays
  readable wherever it lands. The left-edge anchor is kept: it puts the label
  in the gap when the gap is enough and overhangs the right-hand card only by
  the remainder.
- #18 (review calibration banner reading a constant) is a middleware fixture
  bug and stays Open for a provider fix, not a portal one.

## Fixed (pending re-audit) — middleware agent, 2026-09-06 14:18

- **#18 fixed.** Root cause: `sampling()` in `middleware/src/providers/distillation.ts`
  returned a hard-coded `MOCK_SAMPLING` object (`queueDepth: 6`, `reviewedLast30d: 214`,
  `agreementRatePct: 87`) that was never recomputed, while `/review` and its Decided tab
  read live from `MOCK_REVIEW_SAMPLES` — two views of the same fact with no shared
  source, guaranteed to drift the moment either changed. Fix: `sampling()` now calls
  `computeSamplingState()`, which derives `queueDepth` (count of `verdict === 'pending'`),
  `reviewedLast30d` (count of non-pending samples within a 30-day window) and
  `agreementRatePct` (agree / decided, one decimal place) directly from
  `MOCK_REVIEW_SAMPLES` — the same array `listReview`/`decideReview` read and mutate — on
  every call. `l1SampleRatePct` stays a standalone tunable (nothing in the review list
  encodes the L1 sample rate). `SamplingResponse`'s shape and `samplingVerdict`'s
  thresholds are unchanged; only the inputs feeding it are now derived. Curl proof
  (org-leader session): before deciding, `GET /api/distillation/sampling` returned
  `queueDepth:6, reviewedLast30d:20, agreementRatePct:85`; after `POST
  /api/distillation/review/rev-005 {"verdict":"agree"}`, the same endpoint returned
  `queueDepth:5, reviewedLast30d:21, agreementRatePct:85.7`, matching the pending list
  (5 cards) and the agree/disagree counts exactly. New test:
  `src/providers/__tests__/distillation-domain.test.ts` ("deciding a sample moves the
  sampling banner by exactly one, consistently") decides a pending sample through the
  provider and asserts queueDepth drops by one, reviewedLast30d rises by one, and
  agreementRatePct recomputes from the post-decision counts. `cd middleware && npx tsc
  --noEmit && npm test` green (126 suites / 1745 tests). Mock path only — no Aurora
  table backs this yet, so nothing on the Aurora side changed.


## Fixed (pending re-audit) — coordinator, 2026-09-06 16:30

- #19: four lineage edges share a label anchor by construction — the anchor
  is `min(sourceX,targetX) + NODE_WIDTH + LABEL_INSET` with the endpoints'
  midpoint for y, so two edges from the same column into the same row land
  on the same point and paint over each other ("supports to"; two labels
  invisible). `staggerLabelAnchors()` (pure, in `distillationFormat.ts`,
  tested) spreads every colliding group symmetrically about its shared
  point by `LABEL_STAGGER_Y` = 16px, keeping input order so a re-render
  never reshuffles them; `LineageFrame.tsx` anchors through it.
- #20: the calibration banner polled every 60s and a decision did not
  invalidate it, so it contradicted the queue beneath it for up to a
  minute. `ReviewPage.tsx` now refreshes the sampling fetch alongside the
  review list in the same success path.

## Fixed (pending re-audit) — lineage agent, 2026-09-06

- Lineage graph fit-to-view: fit-to-view parked the graph at roughly half
  zoom in the top two-fifths of a fixed 560px canvas, with card titles
  truncating mid-word ("Rerun-and-diff triage for a fla…"), per both
  journey logs' notes on `art-001`. Two independent causes, both in the
  lineage-only files:
  1. **Wasted canvas.** `LineageFrame.tsx` handed `@xyflow/react` a fixed
     560px-tall canvas regardless of content. `layoutLineage`
     (`distillationFormat.ts`) places one column per node kind
     (`LINEAGE_COLUMN_WIDTH` = 260px apart) and one row per sibling within a
     column (`LINEAGE_ROW_HEIGHT`, was 100px); the `art-001` graph (3
     observations + 1 shared session in column 0, one row each in cluster /
     artifact / library-item, two facts) is only 4 rows tall — a bounding
     box a few hundred px tall against the hard-coded 560, so the leftover
     canvas height just sat empty below/around the graph. Fixed by a new
     pure helper, `lineageCanvasHeight(positions, band)` in
     `distillationFormat.ts`, that sizes the canvas to
     `maxY + LINEAGE_ROW_HEIGHT + allowance`, clamped to a band (220–560 for
     the full page, 180–260 for the Artifacts drawer's compact preview).
     `LineageFrame.tsx` now calls it instead of hard-coding
     `compact ? 260 : 560`; an explicit `height` prop still wins. Covered by
     three new node tests in `distillationFormat.test.ts` (floors an
     empty/one-row graph at the band minimum instead of the old fixed
     height, grows linearly with row count, clamps at the band maximum).
  2. **The zoom itself.** The graph's own content is also wider than the
     page column it renders in (5 columns × 260px pitch ≈ 1260px of content
     vs. a page column well under that), which is what actually drove
     fit-to-view's zoom down toward ~0.5 — a taller canvas never fixed
     that, since the width ratio was already the binding constraint.
     `fitViewOptions` on the `ReactFlow` element now reads
     `{ padding: 0.12, minZoom: 0.6, maxZoom: 1.5 }` (was `{ padding: 0.15 }`,
     i.e. an implicit 0.5 zoom floor) — a firm floor above the "roughly
     half zoom" the audit measured, a tighter padding fraction, and a
     ceiling so a small graph in a wide container doesn't get blown up past
     the card's designed scale.
  - **Truncated titles.** Even at a healthier zoom, a node's title is
    `label` — often a full observation headline — truncated to one line at
    `NODE_WIDTH` (220px), so identifying a node still depended on a
    hover-only `title` attribute. `LineageNodeComp` (`LineageFrame.tsx`) now
    also renders the node's `id` as a second, always-visible line under the
    (still-truncated, still hover-tooltipped) title — short and stable, so
    a reader can tell nodes apart, and match one to a `?focus=<id>` URL,
    without the pointer. `LINEAGE_ROW_HEIGHT` went from 100 → 116 to give
    that extra line headroom without breaking `layoutLineage`'s "no
    node-on-node overlap" contract.
  - Verified: `npx tsc --noEmit`, `node --test 'src/**/__tests__/*.test.ts'`
    (578 passed), `npx vite build` all clean; from the repo root,
    `scripts/validate-orgiq-audit.sh --quick`'s component-discipline block
    is all ✓ (`LineageFrame.tsx` unchanged at 6 raw elements, well under its
    12-element budget). No runtime/browser verification was possible in
    this environment — the fix is reasoned from `layoutLineage`'s layout
    constants and the `ReactFlow`/`fitViewOptions` props, not a rendered
    screenshot.


## Fixed (pending re-audit) — coordinator, 2026-09-06 23:30

- #22: the `minZoom: 0.6` floor added for the full-page canvas OUTRANKED
  fitView in the drawer — a 1260-unit graph pinned at 0.6 renders 756px into
  a 680px canvas, clipping 38px off both ends, which is the leading 29% of a
  card and exactly where the new id line sits. A preview's job is to fit, so
  the compact canvas now uses `{ padding: 0.08, maxZoom: 1.5 }` and keeps
  xyflow's own floor; the full-page canvas keeps its 0.6.
