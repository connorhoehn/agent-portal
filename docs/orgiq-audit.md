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

## Settings had no journey row — and that is where four bugs were living (CLOSED 2026-09-17)

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

**The gap is closed.** `settings | /settings | - | member,sme,program-owner,org-leader,hr-admin`
is in `MATRIX.txt` and all five logs are written from live walks, screenshots
included. Measured on the isolated stack at 1728x876, content column left
200px, no horizontal scroll (scrollWidth 1728 = innerWidth), exactly one
`<main>`, breadcrumb "System › Settings", console errors 0 for every role:

| role | tabbable | all focusable | sections |
|---|---|---|---|
| member | 25 | yes | Appearance, Keyboard, Security, About, Gateway |
| sme | 26 | yes | same five |
| program-owner | 27 | yes | same five |
| org-leader | 35 | yes | the five **plus Scores** |
| hr-admin | 37 | yes | the five **plus Scores** |

A fifth defect surfaced while writing these logs and was removed rather than
fixed: a **Masquerade history** card read localStorage
`orgiq:masquerade:history`, which nothing in this repo has ever written — the
only other references are `tenantCaches.ts`'s clear-list and its test. It could
not have worked even in principle, because `masquerade()` in `lib/auth.tsx` has
no caller anywhere in the portal: there is no UI that STARTS a masquerade, only
`MasqueradeMenu`'s "Stop masquerade". So the card was empty for every role in
every deployment while telling the reader "Switch roles via the header menu to
populate" — wrong twice, since switching roles is not masquerading and nothing
populates it either way. Building a masquerade-start flow to give the card
something to show would be a feature; removing dead UI is the audit fix. The
localStorage key stays in the clear-list on purpose — a device that ran an
older build could still hold bytes under it.

## The computer-lab matrix row understated who sees it (CLOSED 2026-09-17)

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

The row reads `sme,hr-admin,org-leader,program-owner` now, and the two added
roles were walked live rather than assumed. Both confirm the read tier is real:
`GET /api/devbox/boxes` answers **200** for a role holding no `ManageDevbox` at
all. org-leader sees all five boxes (fleet-wide per `initiative-scope.ts`);
program-owner sees zero, correctly — `devbox-visibility.ts` scopes
non-fleet-wide roles to computers they own or steward, and every seeded box is
unattributed. One rough edge is queued rather than fixed, because it lives
inside the library composite: with an empty fleet the lab says "Provision at
least one computer" to a role that cannot provision, and with a non-empty fleet
it auto-opens a shell pane that a read-only viewer can never attach (`error ·
Forbidden`). `PaneKind` has no applicability rule, so a consumer cannot pick a
pane per VIEWER any more than per COMPUTER.

## Still uncovered, and one product decision that is not mine to take

Two things this pass surfaced and deliberately did not resolve:

- **`portal/src/pages/sprints` is named by no journey log.** The Sprints lens
  is reached from the Initiatives surface (`/iq/sprints` lands on
  `/iq/projects?lens=sprints`) rather than from a rail item of its own, so it
  has no matrix row and its `pages:` directory is covered by nothing — which is
  how a fabricated denominator lived there. `SprintDetail.tsx`'s "Points done"
  bar took the library `ProgressBar`'s default `showRatio`, so it rendered
  `{value}/{max}` where `max` is `Math.max(pointsTotal, 1)` — a clamp that
  exists only so the bar's width math cannot divide by zero. An unpointed
  sprint therefore read **"0/1"**, a denominator nobody estimated, a few lines
  from the Money tab's StatCard reading "0 / 0" for the same sprint. Fixed the
  way its own sibling `SprintCard.tsx` already does it (ratio off, true ratio
  in `label`), and verified against a sprint created live with `pointsTotal: 0`:
  it now reads "Points done 0/0". A matrix row for the lens is the durable fix.

- **Should SMEs and program-owners see Codebases?** Still open, and still
  recorded in `docs/nav-server-tier-decisions.md` rather than taken. The
  evidence firmed up this pass: `agent-projects.ts`'s READ gate is
  `readForRolesElseAction(['org-leader', 'hr-admin'], 'DispatchAgentRun')` and
  **four of the five orgiq roles hold `DispatchAgentRun`** (sme, program-owner,
  org-leader, hr-admin — member does not), while the nav and the route
  both gate on `['hr-admin']` alone — and the route's own comment justifies
  that with "their APIs require ManageDevbox", which is true of the WRITE path
  and false of the read. So the portal is gated narrower than the API it reads,
  which is exactly the shape that doc exists to adjudicate. Widening it is a
  product call about who Codebases is *for*, so it stays a question.

## Which rail items this matrix does and does not cover

Diffing the orgiq rail (`Layout.tsx`'s `PLATFORM_ITEMS` + `IQ_ITEMS`) against
`MATRIX.txt`'s url column leaves three items with no row. Two of those are
covered anyway, and re-deriving that each pass is wasted work, so:

| rail item | matrix row? | actually covered by |
|---|---|---|
| `/admin/observability` | no | its `index` redirects to `summary`, which IS a row (`health`); the sub-pages `invocations` and `tool-calls` have rows too |
| `/iq/distillation` | no | **its own journey system** — `docs/distillation-journeys/{member,org-leader}/{overview,tiers,artifacts,lineage,compactions,review}.md`, 12 logs judged by `validate-distillation.sh`, including its own staleness check |
| `/admin/identity` | no | the `index` redirects to `roles`, which HAS a row now (`identity-roles`, added 2026-09-17) alongside `identity-users` |

Every rail item is now covered, here or in its own system. Closing the last
hole — the Identity landing — was worth the trip: the three identity pages
with no journey row (Roles, Policies, Schema) were all still rendering a failed
read through the library's `ErrorState`, while `UsersPage`, the one page there
that HAD a row, used `UnavailableNotice` in three places. The audited page got
the treatment and its unaudited siblings did not, which is the argument for
coverage stated as plainly as it ever gets.

## Six relative-time ladders that disagreed with the shared one (CLOSED 2026-09-17)

Found 2026-09-17 while sweeping timestamps. `portal/src/lib/relativeTime.ts` is
the canonical "2h ago" formatter, and six surfaces carry their own copy:

| file | local helper |
|---|---|
| `pages/observability/OnCallPage.tsx` | `timeAgo` — in a file that already imports and correctly uses `relativeTime` a few dozen lines away |
| `pages/budgets/budgetsFormat.ts` | `ago` |
| `pages/iq/agentDetailFormat.ts` | `when` |
| `pages/knowledge/knowledgeFormat.ts` | `when` |
| `components/canary/nodes/JudgeNode.tsx` | `formatRelative` |
| `components/codebases/RepoDiscovery.tsx` | `ago` |
| `pages/assessment/secondaryFormat.ts` | `formatRelativeTime` — its comment says it deliberately mirrors the SOURCE app's helper, so this one may be intentional |

They all now parse through `lib/pgTimestamp` (done 2026-09-17), so the parsing
is consistent. What still differs is the WORDING, and the same instant reads
differently depending which page you are on:

- the shared helper floors, most local ones round — 45m40s is "45m ago" here
  and "46m ago" there;
- the shared helper says "just now" under 2 minutes, most local ones under 1;
- past a week the shared helper switches to a date ("Jun 9, 2026") while the
  local ones keep counting — "100d ago", indefinitely.

**Closed.** All six now delegate, each keeping the null sentinel its own
callers depend on — `'never'` in budgets and knowledge, `'—'` in agent-detail
and the judge node, `null` in RepoDiscovery (its caller drops the whole line
rather than print a dash). Two details made this more than a find-and-replace,
and are why it took a pass of its own:

- `JudgeNode` needed SECOND resolution and threaded a ticking `now` through as
  an argument. `relativeTimeSeconds` is the shared helper written for exactly
  that case ("where 'just now' is too coarse to show that a poll is live") and
  it reads the clock itself, so the ticking state stays as the re-render
  trigger and the argument goes away.
- `RepoDiscovery` had a years tier the shared helper lacks. Past a week the
  shared one switches to a date, which is the better shape for a repo's last
  push anyway — "Sep 8, 2024" beats "800d ago".

`pages/assessment/secondaryFormat.ts` is deliberately NOT consolidated: its own
comment records that it mirrors the SOURCE app's helper rather than this
portal's, and the assessment tenant is a separate product that happens to share
a BFF. Changing it would make this repo's copy drift from the app it is
supposed to match.

Verified live rather than assumed — budgets reads "24m ago / 1h ago / 1d ago"
with `never` intact and readable local-time tooltips, knowledge reads
"5h ago / 6h ago / 5d ago / never", on-call reads "last incident 1h ago" — and
no surface renders NaN or undefined. Six now-orphaned `pgTimestamp` imports
removed; the one real remaining use (OnCallPage's chart bucketing) kept.

⚠️ And a correction worth keeping, because it nearly shipped as fact: the first
version of this fix asserted these ladders hit the production-only Invalid-Date
bug `lib/pgTimestamp.ts` documents. Measured, they do not. V8 accepts the RAW
wire shape `2026-09-08 08:19:23+00`; what it rejects is the half-normalised
`2026-09-08T08:19:23+00`, which you only get by swapping the space for a `T`
without also widening `+00` to `+00:00`. The comment in that file is accurate
about the form it names — it is the inference to "therefore every bare parse is
broken" that was wrong.

## Reading the journey logs

`docs/orgiq-journeys/<role>/<surface>.md` — `verdict`, `console errors`,
`layout` (measured, with `first-row-top` on list surfaces), `keyboard`,
`empty-state`, `role-gating`, `pages` (the page directories the surface
renders from; a log is stale once any `.tsx` in them is newer than it).
`DEFECTS.md` per role: `## Open` must be empty before the goal is done —
every item is Closed with what was observed after the fix, or moved to a
follow-up section with a reason.
