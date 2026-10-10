# UX sweep acceptance, 2026-10-07

Written by the closing gate lane between about 13:40 and 15:15 local. Nothing was
sealed, no product code was changed, the shared Tilt stack was not restarted.

## Read this first: the tree was not frozen

The brief said feature lanes had stopped. They had not. Files under
`middleware/src` and `portal/src` kept changing for the whole window (communication
plane: `lib/work-graph/shared-work.ts`, `sharing.ts`, `plane-active.ts`,
`routes/social-plane.ts`, `org-teams.ts`, `user-avatars.ts`; chat pins:
`routes/chat-pins.ts` at 15:08; shell call host in the portal at 15:13). So every
number below is "true at the time given", and the one result that matters most is
not green: **the mock-floor snapshots could not be left current.** Three recaptures
(about 13:44, 14:12, 14:54) each went stale within minutes because a handler source
changed afterwards. The last capture is the one on disk. Re-run the capture once the
communication-plane lane stops; it takes about a minute on a warm throwaway server.

## Pins (verified)

- ui-components 2.431.3, `74c6ec526c3e215942b0dde7cc9aa5dd79b4834b`
  (`release/2.430.0-side-panel-sm`): `portal/package.json` carries the full SHA;
  the identity check resolves to `portal/node_modules/@connorhoehnslalom/ui-components`
  and the installed manifest reads 2.431.3.
- realtime-modules 0.115.0, `7fa168e4fa294d982b5a610556831e453e06f8e4`
  (`feat/orgiq-0115`): the same full SHA in `portal/package.json` and
  `middleware/package.json`; both installed manifests read 0.115.0.
- `CLAUDE.md` "Current checkpoint" still names ui-components 2.429.0 (`e04bb7b2`).
  It is stale against the pin above; this lane did not edit it.

## What shipped today (from the lane records)

- Layout cascade (`docs/layout-cascade.md`): Distillation Knowledge, Review, Asset
  promotions and Activity > Runs draw a flush list rail (264px, full height, radius 0)
  beside the section rail, trail first; the module landing is an overview; Designs and
  Agent library use the same frame for an open record. The sweep, its baseline
  (3 known orgiq violations) and the rail-collapse rules (depth 3+ folds the primary
  rail) are in `portal/e2e/layout-cascade.spec.ts`.
- Distillation demo (`docs/distillation-demo.md`): a registered `distillation-demo` mock
  scenario with a timed director; reset restores the default.
- Computer Lab demo (`docs/demos/computer-lab-demo.md`): Ada, Basil and Cleo work three
  items through `POST /api/bots/dispatch-work`, so each pickup crosses the real gates
  (Cleo is refused by the sprint envelope).
- Social design 4.6: no top binding strip; bound channel is a tab in the bottom Social
  bar; DMs without a Social grant use `SocialConversation`.
- Communication (`docs/nav-server-tier-decisions.md`): Org "Calls" is now Communication
  at `/iq`, `/assessment` and `/pipelines`, the Social plane read through
  `/api/social/plane/*` (active now, groups, shared work). This lane is still open; see below.
- Search workspace decision 9: four-pane Connections, whole trail on its own row,
  "Ask about selection" in the right pane, primary rail folds when the pane is open.
- Agentic flows follow-ups and realtime parity: cursors on every tenant's work graph,
  unread divider on page discussions (0.115), Files view, call logs, pre-join check,
  in-call reactions (`docs/audit-loop/realtime-parity.md`).
- Social chat workspace (commit 8fa606bb) and the lobby/membership fix (86925d4d).

## Mock-floor recapture

- Reset the shared server to `default` first, then captured from a throwaway server on
  :3012 with the exact env in `docs/mock-floor.md` (all four `MOCK_*` flags,
  `MOCK_STREAM_PACE_MS=0`) so the shared server's scenario could not leak in. I stopped
  only the PIDs I started.
- Last capture (14:54): 767 routes enumerated, 297 of 399 GET routes captured, 109 of
  342 write routes captured, 19 wire vocabularies, no `fetch failed`, no new
  `skipped: HTTP 5xx` entries. First capture (13:44): 293/395 GET.
- `validate-mock-floor.sh` full: **ALL CHECKS PASS** against the 13:44 capture
  (735 routes). After later source edits it fails three lines, none a budget:
  `wire.json` and `writes.json` "captured from DIFFERENT handler sources", and the
  jest step. No budget needed raising; nothing was hand-edited.
- The jest failure in the last run is a real finding from an in-flight lane:
  `portal/src/components/communication/__tests__/planeRailModel.test.ts:83` invents
  status `away`, but `GET /api/social/plane/active` sends `online` and no middleware
  source spells `away` (`wire/__tests__/sweep.test.ts`). Fix the fixture or declare it in
  `wire/allow.ts`.
- Earlier in the window `src/mock/core/parity/__tests__/schema-shape.test.ts` failed
  because `schema/identity_schema.sql` added `app_users.avatar_url` with no fixture
  modelling. A lane fixed it in `parity/shape-entities.ts` (and `mock/avatars.ts`) before
  14:12; `src/mock` jest is 56 suites / 817 tests green at that point.

## Gates

Middleware (14:40 to 14:54, last full run): `npm run typecheck` clean; `npm test`
**471 suites passed, 5 skipped; 6,621 tests passed, 17 skipped, 0 failed**. The 13:55 run
had 1 failure (the `avatar_url` shape test above, since fixed). A run at about 15:08
saw `auth-session.test.ts` ("GET /api/session/users" picker tests) fail while
`providers/identity.ts` was being edited; it passed again in the 14:54 run and I did not
re-run it after the 15:08 edits.

Portal (15:13): `tsc --noEmit` clean; `npm test` 1,607 passed, 0 failed, 0 skipped;
`npm run build` succeeds (only the usual chunk-size warning). At 13:40 it was 1,580 tests;
the difference is lane additions.

Validators (18 scripts, not 17: `validate-communication-plane.sh` is new; CLAUDE.md and
`validate-pipelines-tenant.sh` A.4#21 still say 17). `--quick` where supported:

| Validator | Result |
|---|---|
| agent-eval | ALL PASS |
| assessment-decks | ALL PASS |
| assessment-documents-parity | ALL PASS |
| component-discipline | ALL PASS (re-run 15:13) |
| honest-numbers | ALL PASS |
| nav-parity | ALL PASS (re-run 15:13) |
| newsroom-removal (retired-tenant judge) | ALL PASS (but see tsc note below) |
| route-coverage | ALL PASS (re-run 15:13) |
| mock-floor (full) | PASS at 13:44; red now, see above |
| assessment-tenant | red: 33 journey logs with stale content digests |
| branding | red: 4 logs stale (`orgiq-light`, `orgiq-dark`, `assessment-light`, `assessment-dark`) |
| distillation | red: 6 logs predate their page, plus the tsc line |
| orgiq-audit | red: 54 logs stale |
| pipelines-tenant | red: 22 of 55 logs stale, plus "CLAUDE.md says (17 validators); scripts/ holds 18" |
| search-workspace | red: 10 logs predate a search page edit, plus the tsc line |
| social-tenant | red: 40 stale logs, 4 recordings logs without a pass verdict, assessment dependency |
| communication-plane | red: the goal is open (details below) |
| rail-parity (full) | red: 2 checks, see below |

"middleware: tsc errors" appeared in distillation, search-workspace, social-tenant and
newsroom-removal at about 13:50. It was real at that moment (type errors in
`lib/work-graph/shared-work.ts` and `sharing.ts`, lane in flight) and was gone by 14:40
(`tsc` clean). Those four validators were not re-run, so their tsc line is unconfirmed
either way. Pass lines above that depend on tsc (newsroom-removal) were observed
before the break returned.

Expected reds: social-tenant S2 on the four recordings logs (the Tilt stack has no
recordings from platform-api; `limited` by design) and every digest-stale journey log
(pages changed today; never sealed to clear a mismatch).

Real reds: the stale wire snapshots and the `away` fixture; the communication-plane
goal (below); the CLAUDE.md 17-vs-18 validator count.

### communication-plane (quick) at about 13:55

Open goal, not a regression: route inventory missing `GET /api/social/plane/active`,
`/people/:userId/shared-work`, `/work-graph/conversations/:id/graph`, `GET /api/graph/teams`;
no `team` entry in `BINDING_CONTEXT_TENANT`; `social_schema.sql` `context_kind` lacks
`team`; the authority test lacks plane/active, shared-work, work-graph, graph/teams,
manager and forged-cookie cases; fixture `social-work-sharing` not registered;
`SharedWorkView.tsx` and `communication-shared-work.spec.ts` missing; 24 of 24 walk logs
unwalked. Several of these files appeared later in the day, so the list is probably
shorter now; it was not re-run.

### rail-parity full (`RAIL_PARITY_LOG_DIR` = scratch, ran 480 s)

- Social chat rail frame: `/social/dms` as `u-mira` found no `nav[aria-label=Chat]` or
  `<main>`; channels, teams, rooms, calls and recordings all MATCH (300px at x=200, top
  70, 824/824). I re-ran only that route's measurement but the command failed
  (`timeout` is not installed on this macOS), so the DMs result is unconfirmed.
  Communication rails (`/iq/communication`, `/calls`, `/teams`) and the list rails
  (designs, library) MATCH.
- Layout cascade: the first pass failed on `/pipelines/runs` ("no breadcrumb trail, no
  h1, 0 shell footers"), the Playwright retry failed on `/admin/observability/sessions`
  with the same three symptoms plus the list-pages case. Different routes each time, all
  "page did not render a shell" at once. Orgiq 82 routes, assessment 16, social 14 swept
  clean in passes where they ran; pipelines 15 swept with 3 violations. I read this as
  render flakes under concurrent edits and shared-stack load, not as a cascade regression,
  but I have not proven it.

## Journey-log re-walk backlog (stale or unwalked; none sealed)

- orgiq (54): member 8 and sme 8 (initiatives, initiative-detail, automate,
  automate-findings, ask, explore, library, promotions); program-owner 9 (same plus
  budgets); org-leader 12 (initiatives, initiative-detail, automate, automate-findings,
  ask, explore, promotions, budgets, health, invocations, tool-calls, knowledge);
  hr-admin 17 (those plus library, designs, local-compute, identity-roles, identity-users).
- assessment (33): admin, assessor, lead-assessor, program-lead each
  team-scorecard / workspace / enterprise / rules / prompts (20); stretch
  accessibility, realtime, agent-e2e; `REVIEW-2026-09-05.md`; isolation 9 (sme,
  lead-assessor-outbound, hr-admin, program-owner, org-leader, program-lead-outbound,
  demo-user, assessor-outbound, member).
- social (40): admin, community-admin, moderator, participant each calls / channels /
  contacts / dms / recordings / rooms / teams (28); isolation 12. Separately the four
  recordings logs need a pass verdict that this stack cannot give.
- pipelines (22): admin, author, operator, pipeline-admin each configuration and
  run-detail (8); isolation 14 (assessor, author-outbound, community-admin, hr-admin,
  lead-assessor, member, moderator, operator-outbound, org-leader, participant,
  pipeline-admin-outbound, program-lead, program-owner, sme).
- distillation (6): member and org-leader knowledge, review, activity.
- search (10): member and org-leader people, answer, results, scoped, connections.
- branding (4): orgiq and assessment, light and dark.
- communication (24): member logs for rail, active-now, groups, org-teams and the rest of
  that goal's list.

## Known flakes

- huddle-real: back-to-back "Start call" in one run is unreliable on the shared SFU stack.
- social-presence-burst: intermittent in the browser suite.
- Shared-stack scenario interference: the shared :3001 server was in `distillation-demo`
  when I started; browser validators that run against it (rail parity, orgiq-audit walks)
  see whatever scenario is loaded. I reset it before the capture and again at the end.
  The capture itself used a private port to avoid this.
- Concurrent edits make `tsx watch` and Vite restart mid-run, which produces the
  "no shell rendered" cascade failures above and stale snapshot digests.

## Unverified

- Fresh mock-floor snapshots matching current handler sources (the main open item).
- Any browser journey after 14:00: no log was re-walked.
- social-tenant, distillation, search-workspace and newsroom-removal after the 13:50 tsc
  break cleared.
- `/social/dms` rail, and whether the cascade render failures reproduce on a quiet stack.
- Aurora/IAM, SFU media on physical devices, and the unapplied additive schemas
  (`work_item_documents`, proposals, `app_users.avatar_url`, social `team` context kind).

## Final server state

After the last browser validator I posted `/api/__mock/reset`; `GET /api/__mock/state`
reports `"scenario":"default"`.

## Closing pass (2026-10-07, quiet tree, evening)

Every feature lane had stopped. I wrote no product code. The shared server was reset to the
default scenario before each step and again at the end (`GET /api/__mock/state` reports
`"scenario":"default"`).

### Mock-floor recapture

I reset the shared server, then captured against a private BFF on :3012 started with every
`MOCK_*` flag exactly as `docs/mock-floor.md` prescribes (`MOCK_STREAM_PACE_MS=0`), using
`WIRE_BASE_URL=http://127.0.0.1:3012 npx tsx src/mock/core/wire/capture.ts`. The capture
exited 0. It enumerated 767 routes from `src/index.ts`, captured 297 of 399 GET routes (296
as orgiq/admin, 1 as assessment/admin; the other 102 are listed as reached-nothing in the
snapshot, each with its reason) and 109 of 342 write routes (the writes sweep confirmed the
server reports all four mocks). The private server is stopped and nothing else was killed.
`wire.json`, `writes.json` and `routes.json` were written by the script, never edited; the
three are modified in the tree and uncommitted.

`./scripts/validate-mock-floor.sh` (full) passes every check except one: rule 6 now reads
current (741 routes in `routes.json`, `wire.json` covers all 399 GET routes, both captures
match the handler sources on disk) and the budgets hold (typed aggregates 5 of 5, wall-clock
mints 0 of 0, writes reaching an unmocked provider 25 of 25), but the middleware jest run
inside it fails on three tests. They are stale expectations against the new seed, not
snapshot problems: `roster.test.ts` ("says who holds a social grant only to a caller who
holds one") expects u-eli to have no Social grant and now gets one;
`social-bindings.test.ts` ("refuses a session with no social grant, and a peer outside the
social roster") expects a DM from u-theo to u-eli to answer 404 and gets 200;
`pipelines.test.ts` (GET /api/pipelines/summary) expects one `author` and gets two, because
u-tomas was seeded as a pipelines author. No budget needed raising.

### Communication plane

I walked all 24 logs with Playwright (headless Chromium 1680x940, a fresh signed-in context
per identity, console and page errors read, a screenshot per log). The sealed count is 2
of 24; 22 are unsealed.

- Sealed: `no-grant/rail` and `no-grant/footer-social` (u-hr). The denied state shows, the
  Calls destination opens by Enter, and the page and footer made zero /api/social requests.
- Walked and failing: the four `shared-work` logs (member, org-leader, assessment,
  pipelines), each `verdict: fail`. Two defects. D1: as u-theo, the person view of u-vera's
  shared work, in the default world where u-vera has seeded grants to him, shows "Shared
  work is unavailable - The activity graph could not load" although the snapshot request
  answers 200 with four nodes; the same URL works for u-asha. D2: in every populated
  person view the shared-items list sits under the work graph (graph layout 517px inside a
  420px section), so rows cannot be clicked with a mouse (the react-flow pane takes the
  click); the keyboard works and the far-right pane opens from a DM page reference.
- Walked and passing but unsealed: 18 logs (member 5, org-leader 5, assessment 4,
  pipelines 4). The seal script seals a whole directory
  and refuses if any log in it is not a pass, and each of these four directories holds a
  failing shared-work log, so I did not seal them and did not hand-edit the digest file.
  Re-sealing the four directories needs D1 and D2 fixed and those four logs re-walked.
- Also recorded as D3 (minor) in the member, assessment and pipelines defect files: the
  rail row preview of the open conversation does not update live (the line reaches the open
  panel in about 0.05s, the preview was still old 12s later); and D4 (member): an unknown
  `?person=` id renders a titled empty view instead of a not-found state.
- Limited, not failed: no live call was observable (the activity API reports `inCall` only
  to a viewer in the call, and none was live); "Create team channel" and Bind need
  ManageTeams / ManageChannels, which none of these users hold; u-mira holds no composer on
  #auth-migration so the bound-group live path was not timed; assessment and pipelines users
  cannot send an initiative page reference, so their DM shared-work pane step is not
  observed. One footer click timed out in one org-leader run and passed on rerun; a 401 burst
  once appeared in a u-vera walk (another session for the same user) and did not reproduce.

`./scripts/validate-communication-plane.sh` (full): 91 checks pass, 2 fail, both in item 5
(4 of 24 logs not valid; 18 logs unsealed). Items 1 to 4 and 6 pass, including the two
browser specs against :5183 (9 passed in 46s), the 45 plane suites in jest, middleware
typecheck, portal tests, portal tsc and portal build.

### Gates

- Middleware typecheck clean. Full jest: 469 suites passed, 3 failed, 5 skipped; 6,629 tests
  passed, 3 failed, 17 skipped (the three above).
- Portal `tsc --noEmit` clean; portal tests 1,607 of 1,607 pass; `npm run build` clean.
- Validators with `--quick` where supported, plus the two run in full: PASS agent-eval,
  assessment-decks, assessment-documents-parity, component-discipline, honest-numbers,
  nav-parity, newsroom-removal (the retired-tenant judge), route-coverage, and rail-parity
  in full. rail-parity ran once in full with `RAIL_PARITY_LOG_DIR` in my scratch directory
  and passed on the first run (the cascade sweep covered 127 routes), so there was no
  second run to report. FAIL: mock-floor (jest, above), communication-plane (above),
  assessment-tenant, branding, distillation, orgiq-audit, pipelines-tenant, search-workspace
  and social-tenant, all for stale or unwalked journey logs.

### Remaining reds and their reasons

Mock-floor: three stale jest expectations. Communication plane: D1 and D2 plus 18 unsealed
passing logs. The other seven are journey-log digest or required-field failures that no
code in this pass changes, and none was sealed. social-tenant's S2 recordings logs stay
`limited` (the stack's platform-api holds no recordings), and the social validator also
reports the assessment dependency.

### Re-walk backlog per validator

- assessment-tenant: 33 logs (digest mismatch): four roles times team-scorecard, workspace,
  enterprise, rules, prompts, plus the stretch and isolation logs and the REVIEW file.
- branding: 4 (orgiq and assessment, light and dark).
- communication-plane: 22 (4 shared-work to re-walk after D1/D2; 18 passing walks to seal;
  per tenant: member 6, org-leader 6, assessment 5, pipelines 5; no-grant 2 are sealed).
- distillation: 6 (member and org-leader knowledge, review, activity).
- orgiq-audit: 67 logs fail a required field (member, sme, program-owner, org-leader,
  hr-admin across the initiative, automate, ask, explore, library and promotion surfaces).
- pipelines-tenant: 23 of 55 (author, admin, operator and pipeline-admin configuration and
  run-detail, plus isolation logs).
- search-workspace: 10 (member and org-leader people, answer, results, scoped, connections).
- social-tenant: 40 digest mismatches (admin, community-admin, moderator, participant each
  across calls, channels, contacts, dms, recordings, rooms, teams, plus isolation) and 4 S2
  recordings logs.
