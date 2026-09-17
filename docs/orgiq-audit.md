# The orgiq audit — what changed and why

The org tenant was audited surface by surface as the real seed users
(`docs/orgiq-journeys/`, one log per role × surface from `MATRIX.txt`, one
`RAIL.md` per role) and de-hand-rolled directory by directory. The judge is
`scripts/validate-orgiq-audit.sh`; this page is the narrative behind its
numbers.

## The density rule

A list page's list is the page. On every surface flagged `L` in the matrix
the first data row sits above the fold (`first-row-top` ≤ 640px at a
1440×900 viewport); above it the budget is one selector/filter row and a
one-line description. Status and summary numbers go in a `StatStrip`, not
a stack of cards. The rule came from the distillation review ("a lot of use
of cards with wasted space or not critical information and then I have to
scroll to get to the tables") and is enforced by the protocol and the
validator, not by taste.

## Component discipline, repo-wide

Pages render through `@connorhoehnslalom/ui-components` composites. The
validator counts raw styled HTML elements, JSX `style=` props (an inline
object or a hoisted const — one pass "removed" inline styles by hoisting
them, so the check was widened), native `<select>/<input>/<textarea>` and
raw `<button>` across all of `portal/src/pages`; the raw-element count must stay
under `scripts/orgiq-raw-budget.txt`, which only goes down. A primitive the
library lacks is composed once in a `*Frame.tsx` (≤ 12 raw elements) and
queued in `docs/ui-components-queue.md` with "Composed locally in
`<file>`" — the phrase that exempts it.

### Budget history

| when | raw elements | budget | what landed |
|---|---|---|---|
| 2026-09-05 17:00 | 1114 | 1114 | baseline (assessment + distillation already at 0 outside 5 frames) |
| 2026-09-05 17:45 | 691 | 691 | `work` 158 → 0, `bots` 148 → 0, `iq` 118 → 0 |
| 2026-09-05 17:46 | 382 | 382 | `admin` 115 → 0 (ChangesPage, AgentProjectsPage, ChangeReviewPage; RailLayout + Modal replace hand-rolled grid/overlay) |

| 2026-09-05 17:49 | 364 | 364 | `knowledge` 44 → 0 (registry as a DataTable above the fold, KPIs + pipeline stages as two StatStrips) |

| 2026-09-05 17:50 | 324 | 324 | `iq` inline styles/buttons 96 → 0 (DiffFrame composed; LCS diff extracted to diffFormat.ts) |

| 2026-09-05 17:50 | 309 | 309 | `library` 51 → 0 (asset drawer on composites, real Button in the name cell) |

| 2026-09-05 17:57 | 201 | 201 | `project-detail` 60 → 0 (initiative detail on composites; filter chips in table cells are real Buttons) |

| 2026-09-05 18:02 | 163 | 163 | `capabilities` 130 → 5 (5 inside queued frames: PromptsFrame, VarCombobox ref, TemplateHighlighted); GuardrailsPage 39 inline styles → 0 |

| 2026-09-05 18:05 | 157 | 157 | `budgets` 39, `designs` 34, `observability` 26, `projects` 24, `release` 15, `sprints` 14, `promotions` 14 → all 0; remaining: root pages + `iq` residual (both in flight) |

| 2026-09-05 18:10 | 134 | 134 | `iq` residual 29 → 0 (only DiffFrame's 4 remain, queued); root page files in flight |
| 2026-09-05 18:22 | 111 | 111 | style props now counted whether inline or hoisted (947 across pages, `observability` 312, root 234, `identity` 175, `ingest` 98) and native form controls (17); honest conversion passes sent per directory |
| 2026-09-05 18:30 | 0 | 60 | root pages 81 → 0 (raw elements are gone repo-wide; budget lands on the done line); `ingest` 98 style/3 native/2 buttons → 0, the four layout singletons (`SubNavLayout` active-item `style`) → Tailwind classes; 323 style props, 12 native, 10 buttons remain in `observability`, `identity`, root pages (passes in flight) |
| 2026-09-05 18:55 | 0 | 60 | raw count made multi-line aware (a `<div` with its `className` on the next line had been invisible: 3 found, fixed) and the native-control grep now matches a tag that ends its line (`LineNumberedTextarea`, queued as the line-numbered editor gap); `identity` 175 style/8 native/21 buttons → 0; the last range inputs (Explore, Settings, inference temperature) go through the queued `RangeSliderFrame`; the Review note is the library `Textarea` (it *is* on `/shared`, the queue row claiming otherwise was wrong and is gone) |
| 2026-09-05 19:20 | 0 | 0 | `observability` 433 style/3 native → 0 (`TrafficHeatmapFrame` queued), the hr-admin fix round landed on composites; the ratchet is locked at zero — a raw element anywhere in `portal/src/pages` now fails the goal |

## What the hr-admin pass found, and what changed

Fourteen of the twenty-three surfaces passed on the first hr-admin pass;
nine did not, and each failure was one of three patterns:

- **Counts that don't match lists.** Health's "25 errors" link landed on
  an Invocations page that always read "No invocations yet" (dev:mock never
  filled its ring buffer); Bots kept saying "5 bots" above an empty filtered
  table. The mock now serves a 32-row invocation tail consistent with the
  summary, the failures link carries `?status=error`, and the bots line reads
  "2 of 5 bots match". The Findings list had the same shape from the other
  side — zero rows in every status — and is seeded in dev:mock now too.
- **Silent writes and leaked errors.** Approving a promotion succeeded on
  the server while the open drawer never changed, and a retry 409'd into
  the void; Prompt Studio printed the raw Bedrock error JSON next to "No
  prompts yet". The drawer re-reads its candidate and only offers actions
  the server would accept; the library page renders exactly one of an
  explained `ErrorState` or the empty state, and dev:mock serves a prompt
  library instead of calling Bedrock.
- **The density rule and the keyboard.** Scores put its table 795px down
  under six stacked blocks; Budgets stacked two breakdown cards over its
  table; Scores rows and every Architecture graph node were mouse-only (the
  xyflow nodes computed `visibility: hidden` because they were never
  measured). Scores is one `StatStrip` + one filter row + the table;
  the breakdown cards sit below the Budgets table; rows open from a real
  `Button`; graph nodes carry initial dimensions and an Enter handler.

## Cedar is the source of truth for who sees what

The program-owner pass found the app, the matrix and the copy disagreeing
about Computer Lab: the route and rail admitted program owners and org
leaders, the ⌘I switcher denied them, and the banner named a third set of
roles. The tie-breaker is `middleware/seeds/roles/orgiq/*.cedar` — it is
what the deployed policy store enforces, and it grants `ManageDevbox` only
to `sme` and `hr-admin`. Every role list in the portal (route guards,
`automateNav`, the palette, the matrix) now mirrors the Cedar grant for the
capability behind it; widening a surface means widening Cedar first.

## The ⌘I Computers switcher

Opened onto a blank "type to filter" popover for a role without Computer
Lab, while the fleet loaded, and when the fleet was empty. It now says which
of those is true: the access-denied state names the `ManageDevbox`
capability and the roles that hold it; loading and error states are
explicit; an empty fleet offers the create row. Every role's `RAIL.md`
records what ⌘I shows.

## Follow-ups outside this goal

- **A dispatch in dev:mock stops at the devbox.** Every gate now runs against
  the mock (grant scope → codebase link → run cap → allocation → envelope),
  and the money gates 409 with their `gate` name; past them the runner
  reports a clean 503 "the devbox runtime is not deployed" because
  `createBotRun` returns null in mock by design. A fully mocked run (a fake
  clone + a fake job) would let the SME persona see a run row without AWS —
  worth doing, but it is a new mock surface, not an audit defect.
- **The library gaps** the audit composed around (focus-trapping popovers,
  root-only `Slider`, no `forwardRef` on the layout primitives, no grid
  primitive, no line-numbered editor) are listed in
  `docs/ui-components-queue.md`; each has exactly one local frame.

## Settings has no journey row — and that is where three bugs were living

`/settings` is in every role's rail and is the one nav item the matrix has
never covered. Nothing else in this repo judges it either: it is not a list
surface, it has no goal-doc, and no validator reads it. Opening it once, as an
ordinary audit pass would, turned up four defects — three shipped in
`3221ed7`, one in the commit that adds this section:

1. `GatewayProxyClient` could not issue a request from a browser at all
   (`globalThis.fetch` called unbound → "Illegal invocation"). Queued upstream;
   worked around at both call sites through the library's own `fetch` seam.
2. The header's gateway health dot was therefore painting **red on every page
   of every deployment** — a permanent false alarm nobody had reported,
   because "the gateway is unhealthy" is a plausible thing for a dot to say.
3. The panel could not tell "this host is not a gateway" (BFF-only, the normal
   state here) from "the gateway is down", and printed the raw exception.
4. The **Scores** preference card was offered to every role. Its own
   description is "applied when opening the Scores page", but `/iq/scores` is
   hidden from the rail for everyone but org-leader and hr-admin and the
   server answers 403 on the leaderboard read (`ViewLeaderboard: false` for
   member, sme and program-owner, confirmed live). A setting for a page you
   cannot open can never do anything. It is `Can do="ViewLeaderboard"`-gated
   now — on the capability rather than a role list, so it tracks what the
   server actually enforces.

**To close the gap**, add `settings | /settings | - | member,sme,program-owner,org-leader,hr-admin`
to `MATRIX.txt` and write the five logs. Four of the five walks are already
done and their screenshots are committed at
`docs/orgiq-journeys/<role>/settings.jpg`; the hr-admin walk is the one
remaining. Measured on the isolated stack at 1728x876, content column left
200px, no horizontal scroll (scrollWidth 1728 = innerWidth), exactly one
`<main>`, breadcrumb "System › Settings", console errors 0 for every role:

| role | tabbable | all focusable | sections |
|---|---|---|---|
| member | 27 | yes | Appearance, Keyboard, Security, Masquerade history, About, Gateway |
| sme | 26 | yes | same six |
| program-owner | 27 | yes | same six |
| org-leader | 35 | yes | the six **plus Scores** |
| hr-admin | — | not yet walked | expected: as org-leader |

The member/sme/program-owner counts are post-fix — they were higher before,
by the Scores card's slider and Reset button, which is the defect above.

## The computer-lab matrix row understates who sees it

`MATRIX.txt` says `computer-lab | /admin/devbox | L | sme,hr-admin`, and the
file's own header says a role not listed "must NOT see the surface". That is
no longer true. `Layout.tsx:171` gates the rail item on **four** roles —
`['hr-admin', 'sme', 'org-leader', 'program-owner']`, commented "ManageDevbox
+ the /api/devbox read tier" — and a program-owner rail observed live does
carry Computer Lab. The read tier was widened after the row was written and
the row never followed; what a role without `ManageDevbox` gets is the
read-only fleet ("You can see the fleet but not drive it. Opening a shell or
dispatching work needs computer access, which an SME or a platform operator
can grant"), which is the correct read/write split, not a leak.

Note this does NOT contradict `program-owner/RAIL.md`, which records the ⌘I
Computers *switcher* as denied for that role. The rail item and the
quick-switcher are two different affordances and both records are accurate —
which is exactly why the stale row survived.

The row should read `sme,hr-admin,org-leader,program-owner`. Widening it
makes the validator require `computer-lab` logs for the two added roles, so
the row and those two walks have to land together.

## Reading the journey logs

`docs/orgiq-journeys/<role>/<surface>.md` — `verdict`, `console errors`,
`layout` (measured, with `first-row-top` on list surfaces), `keyboard`,
`empty-state`, `role-gating`, `pages` (the page directories the surface
renders from; a log is stale once any `.tsx` in them is newer than it).
`DEFECTS.md` per role: `## Open` must be empty before the goal is done —
every item is Closed with what was observed after the fix, or moved to a
follow-up section with a reason.
