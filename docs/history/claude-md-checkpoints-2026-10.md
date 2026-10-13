# CLAUDE.md checkpoint history, 2026-09-19 to 2026-10-10

Moved out of `CLAUDE.md` on 2026-10-12 so the agent context stays short. Every
paragraph below is a dated snapshot of local state at the time it was written.
Pins, "uncommitted" and "blocked" claims describe that date, not the current
tree; `docs/claude-code-handoff-2026-10-12.md` and git are the current state.

## Publication checkpoint — October 10, 2026

The local UI/realtime/deck audit is being preserved on cleanup branches at the user's explicit request to commit and push across repositories. See `docs/demos/work-huddles/README.md` for verified outcomes and remaining native activation work. Private runtime evidence and call captures stay local. Earlier statements below that nothing has been committed describe their dated checkpoint, not this publication pass. No service restart, cloud deployment, or merge into sibling main is implied by these commits.

## Current checkpoint

**2026-10-07 (latest).** Local-only; still nothing committed, pushed to a
sibling main, or deployed (default AWS identity still `InvalidClientTokenId`).
The day was a UX sweep driven by the user's screenshots, run as parallel
lanes, plus one new goal. Pins (full SHA, release branches only, both sibling
mains untouched): ui-components **2.439.0**
`2a9f10c5cd4a10823b9669a43cf87b0ed3f1a9a4` (chain 2.430→2.439.0 on
`release/2.430.0-side-panel-sm` → `2.432.0-rail-inset` →
`2.433.0-composer-call-block` → `2.434.0-table-sm` → `2.435.0-pane-views` →
`2.436.0-ringing-tiles` → `2.436.1-empty-state-sm` → `2.436.2-dock-fit` →
2.436.4 → `2.437.0-header-density` (2.437.1: `PageHeader`/`ScopeHeader`
`density` comfortable|compact + `collapsed` state, `useHeaderDensity`, the
shared `Density` system and `HoverCard`; the portal's `InitiativeHeaderFrame`
and `PersonCardFrame` are deleted) → `2.438.0-pane-rail` (2.438.0/2.438.1:
the ONE pane model — `SidePaneProvider`/`SidePaneSplit`/`SidePane`/
`PaneHeader`, URL `?pane=<tab>&paneRecord=<kind>:<id>`, width 320px–60%
remembered per pane, minimize to a 44px strip, keyboard resize; the ONE rail
model — `railDepth`/`railBand`/`useRailFold`, `SubNavLayout collapsed`,
`ListRailLayout`, data-driven `ConversationRail` sections) →
`2.438.2-work-graph-legend` (`WorkKindLegend`, work-graph header slots) →
`2.438.3-pane-composer` (thread-only pane; the composer is docked in the
content column on every page; huddle chat stacks in the pane when one is
open) → `2.439.0-composer-call-block` (ONE `ConversationComposer` —
`createConversationComposer({ useFileUpload })`: Chat / Agent / To: with
server-decided `maySend` (no default), `/deck` `/summarize` `/doc` `/agent`,
uploads cited only after the gateway confirms, drafts per channel,
`ConversationInputProvider` for one input per conversation, the
`callBlock` slot; ONE call block — `createCallBlockHost(video)` +
`useCallBlock(channel)`, lobby admission stays server-side). The portal
deleted 621 lines of pane/rail models, the `app.css` `!important` fold and
1,543 lines of composer/call wrappers (net −1,761); each release branched
from the previous one, verified against the installed `dist`);
realtime-modules **0.115.0**
`7fa168e4fa294d982b5a610556831e453e06f8e4` unchanged in both consumers.
Install a pin before editing a consumer import; branch a new release from the
CURRENT pin, never from an older base.

Shipped today (all local, judged by the validators named): the **layout
cascade** (`docs/layout-cascade.md`, 127-route sweep + rail-collapse cases in
`portal/e2e/layout-cascade.spec.ts`, judged by `validate-rail-parity.sh`):
primary rail folds to a 44px strip at drill-down depth 3+ (record open, pane
open or a selection) while the section rail stays open, remembered per device
and per depth; every page's list is a flush list rail beside the section rail
(same composite as the Initiatives/Work rail, never a bordered box in the
content); the breadcrumb trail is the content column's first full row, never
collapsed to "…"; landings never placeholders; the baseline of violating
routes went 59 → 6 → 0 except `/iq/search`'s accepted one-row form at wide
widths. A **CDP type-scale sweep** (`portal/e2e/type-scale-sweep.spec.ts`,
burn-down `portal/e2e/type-scale-burndown.tsv`, 674 dated entries (owner surface + due date per entry, since 2026-10-08), run by the same
judge): one scale — 20/600 page title, 14/600 headings, 14/400 body, 12/400
meta — no oscillation down the tree, header actions as `Button size="sm"` /
`IconButton`; six new component-discipline ratchets (`scripts/count-layout-drift.py`:
hand-drawn bars, >17px text, card stat strips off dashboards, stacked table
cells, bare × buttons, raw px sizes). **Admin/observability/ingest/knowledge/
identity/sprints/scores/prompts** pages are on 44px one-line `Table size="sm"`
rows and line stat strips (`e2e/admin-type-scale.spec.ts`). **Initiative
page:** one-line title with inline status, search and repository as icon
buttons, Status deck removed, actions consolidate at narrow width; Agents tab
is one runs-on-work table members can read (`GET /api/bots/initiative-runs`,
session floor, no bot config leaks); uniform 16px tab gap; Discussion is the
far-right shell pane (`HuddleChatSplit`, open by default, pane-responsive
composer, one composer on screen; the work-item page reads ONE live thread
`orgiq:work:<id>` whose history is the former seeded comments — on real
Aurora the comments table and the Dynamo thread are still two stores, a
migration is owed); Details hover card + Details/Docs/Log/Decision/Person pane
tabs (detail opens in the pane, "Open page" on demand); Activity is its own
full-height tab (also on the scorecard and the pipelines run page); the
Initiatives explorer no longer draws a third rail. **Search:** Ask about
selection opens the right pane (graph keeps ≥55% width, re-fits on pane
open/close), selection is the last crumb, Answer rows share one edge
(decision 9 amended to allow the two-row trail at narrow widths).
**Distillation:** flush list rails, no in-record crumb, one record inset,
repository selector moved into the rail's filter popover, and a scripted
**demo** (`docs/distillation-demo.md`, `POST /api/__mock/scenario
{"scenario":"distillation-demo"}`, ~3 min, "Play the demo" on the landing for
ManageBots) with live-updating Knowledge/Review/Activity; the **Computer Lab
demo** (`docs/demos/computer-lab-demo.md`, scenario `demo`, three agents
through the real dispatch path, ui-components 2.428 lab panes). **Live
cursors** on every tenant's shared graph (`orgiq:initiative`,
`assessment:team`, `pipelines:run`, `social:ch`; gateway contracts per
family). **Org › Communication** (`/<tenant>/communication`, `/…/calls`
redirects): the Social workspace embedded in orgiq, assessment and pipelines
on Social's own handlers re-gated on the actor's CURRENT Social grants
(`routes/social-plane.ts`, `communication-plane-authority.test.ts`), the
footer's **Social** button navigates there for granted users (Alt-click still
opens the quick panel; ↗ is the tenant switch); then the new goal
**`docs/communication-plane-goal.md`** (judge
`scripts/validate-communication-plane.sh`): Active now enriched per viewer
(`GET /api/social/plane/active`: status, in-call, activity, work sharing),
host-tenant groups (orgiq `projects?scope=mine`, assessment
`teams?scope=mine`, pipelines `definitions?scope=mine`) with bound channels
(`social_bindings` kinds `team`, `assessment-team`, `pipeline`), org teams
(`GET /api/graph/teams?scope=mine`, `routes/org-teams.ts`), Shared work views
and per-person shared-work graphs filtered server-side by sharing grants
(`lib/work-graph/{sharing,shared-work}.ts`, fixture `social-work-sharing`),
the rail polish (one 16px inset, toggled search, one-row shelf, user-ordered
sections, aligned collapse toggle), a landing that opens a real conversation
or an overview, and the no-grant state on the app scale. Grants: every orgiq
cast member with a linked person now holds `social: participant` (u-eli,
u-layla, u-caleb added); the pipelines cast stays pure (outbound isolation
walks) and a fourth pipelines user carries the plane's Social grant; sign-in
lands in the HOME tenant (`mintSession`: Social is the landing only for the
Social-only cast). **Avatars:** `people.avatar_url` / `app_users.avatar_url`
(additive, not applied to Aurora), `schema.synth avatars` (Amazon Nova Canvas,
~$0.04/image, not yet run — credentials), deterministic SVG faces in
`portal/public/avatars/` from `scripts/avatars/generate-local.mjs`, carried
through every people route and composite; `/select` cards are a uniform grid.
**Huddles** render as the confirmed mockup on every conversation composer —
HuddleBar + participant tiles (self immediately, ringing peers as placeholder
tiles, "+N" overflow) above the one composer, docked in the content or at the
top of the right pane, footer compact status alongside (ui-components 2.433 /
2.436.x, `e2e/huddle-bar-surfaces.spec.ts`).

Closing gate (`docs/realtime-validation/2026-10-07/ux-sweep-acceptance.md`
"Closing pass" is the honest record, then the defect lane's final numbers):
mock-floor recaptured on a quiet private BFF (297/399 GET, 109/342 write
routes) and `validate-mock-floor.sh` ALL CHECKS PASS; middleware typecheck +
6,635 jest (17 skipped, 0 failed); portal typecheck, build and 1,608 tests;
`validate-communication-plane.sh` ALL CHECKS PASS (93 checks, 11 specs, 46
plane tests, 24/24 journey logs walked headlessly and sealed per directory);
`validate-rail-parity.sh` full ALL CHECKS PASS (127 routes; its sweep flakes
with "no shell rendered" on random routes only while another lane hot-reloads
the shared portal — rerun quietly before believing a red); agent-eval,
assessment-decks, assessment-documents-parity, component-discipline,
honest-numbers, nav-parity, the retired-tenant judge and route-coverage ALL
PASS; assessment-tenant (33), branding (4), distillation (6), orgiq-audit
(67), pipelines (23 of 55), search-workspace (10) and social-tenant (40 plus
the four expected `limited` recordings logs) are red ONLY on journey logs
re-staled by today's page edits — that re-walk backlog is the next
maintenance item, and the audit (below) says why it is a tax. Audit-found
authority bugs fixed the same day with contracts: the tenant call log asks
each lobby's read rule; `maySend` defaults to false and derives from the
plane's capability; the initiative maintenance floor comes from the server
(`v_initiative_maintenance_30d`), never summed in the browser; production
`plane-active` no longer imports a mock fixture; the portal's copy of the
lobby rule is deleted. **`docs/audit/2026-10-07-audit-plan.md`** (Opus 5.5,
read-only) and `docs/audit/2026-10-07-touched.jsonl` (1,027 records) are the
honest verdict on today's code: near-zero raw hand-rolling but structural
duplication (≈9 page headers, 4 pane models, 4 rail models, 5 composer
wrappers, three Social permission paths, five "mine" readers, seven notions
of "shared work", two stores for one page thread, seven `size="sm"` props and
three density vocabularies in the library, baselines minted at today's
counts); about a third of today's code should move into the library or one
server module and a third should be deleted. Its sequenced refactor program
and 15-item "stop doing" list are the next engineering work; every future
brief includes that list. Audit steps done on 2026-10-07/08: the density/
header release (2.437), the pane + rail release (2.438.x, the user's pane
goal: composer in the content column, thread-only resizable/minimizable right
pane on every page — `e2e/pane-composer-placement.spec.ts` 10/10), the table
rules (`docs/layout-cascade.md` "Tables": `DataTable size="sm"`, 44px
one-line rows, one thing per cell, `numeric` right-aligned, no inline text
buttons — 20 list routes, `e2e/table-rules.spec.ts`; drift ratchets
stacked-cell 22→10, card-strip 15→7, cell-button 35→21, tables without sm
58→20, px-type 399→358), the scorecard header rows (dimension list starts at
y=230, was 494; Discussion is the right pane), and the work-graph headers on
all seven mounts (`WorkKindLegend`, counts, caption, inspector — four mounts
had passed no title, so the library drew no header and showed 2 of 13
activities silently). Audit step 3 (composer + call block, 2.439.0) done on 2026-10-08:
`e2e` composer/huddle specs pass serially (three flake under `--workers 2`
from shared seed users); the plain `ChatComposer` on InvokePage/JobDetailPage
is not yet ported; journey logs whose `pages:` named the deleted
`DimensionComposer.tsx` now report a missing page and need their `pages:`
repointed on the re-walk. Audit step 4 (server consolidation, Fable, 2026-10-08) done:
ONE Social permission path — `lib/social-authority.ts` `socialGate(action)`
(directory-current grants + epoch + masquerade actor, re-read after the
policy call, no cache) is the only gate on `/api/social/*`, the plane and
the bindings/DM/embedded routes; `requireTenant('social')` stays at the mount
as the data boundary only; the same (user, action, epoch) now yields the same
verdict on the tenant and plane URLs (contract "one Social permission path");
a cookie whose signed role the directory no longer grants is 401 on the
personal-team routes (was 403). ONE "mine" reader — `lib/mine.ts` +
`GET /api/me/groups?kind=initiative|sprint|org-team|assessment-team|pipeline`
(`{viewer, items[{kind,id,name,role,membership,…}], limits}`); assessment
membership is now a row (`mock/assessment-team-members.ts`, additive
`schema/assessment_team_members_schema.sql` registered in both loaders, NOT
applied to Aurora), never display-name matching; `GET /api/graph/teams` and
the `?scope=mine` branches on assessment/pipelines are gone (326 lines).
ONE shared-work notion — `SharedWorkItem` + `sharedWorkInConversation`
(`lib/work-graph/shared-work.ts`) folds page references, deck shares/files
and sharing grants under the viewer's authority, served by
`GET …/conversations/:id/shared-work` on both mounts and behind
`people/:userId/shared-work` and Active now's `workSharing`; the portal's
`SharedWorkView` fetches once. Gate: 6,647 jest (0 failed), route-coverage
769/0, mock-floor full green on a fresh recapture, communication-plane judge
green except the 24 re-staled logs. Audit step 5 (judge rewrites, 2026-10-08) done: ONE route inventory
(`portal/e2e/route-inventory.ts`, parsed from `App.tsx`/palette/rail by
`route-sources.ts`; every sweep and the nav-parity judge read it), ONE
sign-in helper (`portal/e2e/realSession.ts` `signIn`/`demoSession`/`openAs`;
component-discipline fails a spec that logs in on its own), ONE seal helper
(`scripts/journeys/seal.sh` + `scripts/lib/journeys.sh`) with the
rendered-contract freshness rule (`docs/journeys.md`: a log is stale when a
route on its `url:` changed its cascade/type-scale/rail measurement, role
gate or covering-spec `expect`s since the seal; `scripts/journeys/measure.sh`
writes `docs/journeys/contracts/*.json`, ~13 min, deterministic; the old
`--seal` flags exit 2), burn-downs instead of baselines
(`portal/e2e/type-scale-burndown.tsv` 599 entries, `scripts/layout-drift-burndown.tsv`
per class and file, every row owner + due date 2026-10-21 — the judges fail
past-due rows; the dates are a user decision), and shared judge libraries
(`scripts/lib/discipline.sh` one raw-element counter, `scripts/lib/judges.sh`
one typecheck/build/static-judge cache per tree state — social quick 68 s→12 s).
The re-walk (2026-10-08, three headless Sonnet lanes, `openAs` per identity,
defects recorded instead of sealed over): orgiq 36→0, search 10→0, branding
4→0, pipelines 51→0, communication 24→0, social 28→0 role/isolation logs
(the four recordings logs stay `limited` and red on S2 by design),
assessment 49→3 (the two-tab realtime and agent-ledger stretch walks and the
accessibility audit still need a walk that writes to the shared mock),
distillation 6→2 (both Activity logs honestly `fail`: clipped run-row meta,
Open 25 — a fix lane is on it). Judge refinements made for honesty: a file
with no `verdict:` is a record outside the freshness rule; a reasoned
`verdict: limited —` seals in the Social set; a `verdict: fail` walk is left
unsealed without blocking its directory's passing walks; `screenshots:` is
accepted; the five retired distillation surfaces' logs (artifacts,
compactions, lineage, overview, tiers — pages deleted 2026-09-24) are deleted.
55 logs were migrated as "no recorded contract move since the walk", which is
not proof. The single page thread (2026-10-08, Opus): a work item's conversation is ONE
store, the gateway thread `orgiq:work:<id>`; `middleware/src/lib/migrate-work-comments.ts`
copies `work_item_comments` into it (provenance `{migratedFrom, commentId}`,
message id derived from the comment id, a claim ledger
`schema/work_item_comment_migration_schema.sql` registered in both loaders —
NOT applied to Aurora — so re-runs and racing migrators write each comment
once; sender stamped from the author's linked login, unlinked people migrate
under their directory name with no user id); `POST …/comments` writes the
thread and pushes live, `GET` reads the thread under the history floor plus
the table's system rows, the table is audit-only (human writes refused).
Contracts: 5 native PostgreSQL 16 (incl. a real 30-comment race), 2 DynamoDB
Local, 8 memory, 3 route, 55 provider/route; record
`docs/realtime-validation/2026-10-08/page-thread-migration.md`. ⚠️ Deploy
order: apply the ledger schema, dry-run, migrate, THEN deploy this BFF —
otherwise old comments are hidden (not lost) until the migration runs; the
RDS Data API transport, IAM and a real cluster are unproven; the initiative
activity feed and `v_work_item_summary.comment_count` still count the table,
The two readers followed (2026-10-08): the initiative activity feed reads
each item's thread under the reader's floor (table only for `is_system`
audit rows) and `v_work_item_summary.comment_count` is now `NULL::bigint`
("not known here"; a view cannot see the chat store — name/type/position kept
so `CREATE OR REPLACE` applies) with the live count at
`GET /api/graph/work-items/:id/comments/summary`; 7 native PostgreSQL + 2
Dynamo + 6 route + 13 mock contracts. The assessment half is NOT a second
migration: per the parity goal's Recommendation C, document comments already
live in platform-api's store via `providers/document-comment-import.ts` (ledger
`assessment_document_comment_imports`; legacy writes 409 after a document's
import), and `assessment:doc:<id>` is the document's separate Chat. The one
gap is `POST /knowledge/doc/comment`, which still writes the table until that
document's first comments read triggers the import (no UI calls it): retire
it (410) or import eagerly — user decision; the audit plan's D2 row should
drop its assessment clause. Tree gate after these (2026-10-08 ~14:00, run
alone — two concurrent full runs had hung with idle parents for an hour, so
run the full jest and the mock-floor judge sequentially): middleware jest
473 suites / 6,665 passed / 26 skipped / 0 failed; `validate-mock-floor.sh`
full ALL CHECKS PASS.
The gateway split (2026-10-08, Fable): a module split, not a process split
(`/ws` and cookie `/realtime` already run as separately leased routers under
an ownership link; `/realtime` mounts nothing and only pushes the three
`orgiq:distill:*` channels; the gateway stays pinned to one task). ONE
authority facade `middleware/src/lib/gateway/authority.ts` — `admitChannel/
Subscribe/Publish/Cursor`, `admitCall`, `admitCallRecipient`, `admitLobbyRead`,
`admitConversationChat`, `admitSocialConversation`, `admitUploadRead`,
`admitDistillation(+Delivery)`, `admitReader`, `admitPrincipal`,
`producerChannelAllowed`, `holdsFamilyAuthority` — each exactly the
live-principal primitive over the one guard pair, fresh per call; the 11
hand-built `{guard, baseChannel}` sites, 4 `{lobbyGuard, getLobby}` sites,
the producer family check ×3 and two re-spelled family rules are gone;
`realtime-gateway.ts` is composition only (1,163 → 389 lines, every old name
re-exported) with `gateway/{auth,calls,notify-plugins,stats,env}.ts`. 88
table-driven facade contracts (`gateway/__tests__/authority-facade.test.ts`)
assert each verdict equals the pre-split one, incl. `/realtime == /ws` on
distillation. Gate: 474 suites / 6,753 passed / 0 failed (alone, 38 min),
gateway suites 729 passed, route-coverage + honest-numbers ALL PASS,
mock-floor recaptured and full ALL CHECKS PASS (744 routes). Not re-run: the
12 native full-BFF contracts, 3 Redis faults, 1 Dynamo fault — ports
3063/3064 are held by an earlier lane's pre-split BFFs (PIDs 91936/91948,
since 2026-10-07 04:08; not stopped) and the `orgiq-chat-*` tables exist on
neither local Dynamo; the Redis/Dynamo stand-in suites pass. Two
verdict-preserving copies remain (`call-access.ts huddleLobbyTenant`'s team
regex, `agent-loop-create.ts`'s lobby read + HTTP mapping). Record:
`docs/realtime-validation/2026-10-08/gateway-split.md`.
**The audit program's engineering steps are complete**; what remains is the
user's decisions (burn-down dates, the legacy assessment comment route, the
Alt-click quick panel, Communication landing depth, capacity sizing), the
queued library gaps (`CitedRecordList` title, `WorkflowStepper` compact,
`EmptyState` heading), the three honest stretch walks, the native BFF
contracts once 3063/3064 are free, and the Aurora-side proofs once
credentials return.
Remaining audit steps (historical list, all done above):
the gateway split (one Social permission path, one "mine" reader shape,
one shared-work notion), the gateway split, the single page thread on real
Aurora, judge rewrites.
Known flakes: huddle-real back-to-back Start call, social-presence-burst,
shared-stack scenario interference (the demo directors run in the one shared
world — reset with `POST /api/__mock/reset`). Not verified: the pipelines
plane with a real user beyond the seeded walker, `/iq/communication` and
Social channel/team/room huddle blocks (no dedicated spec), the Nova Canvas
run, Aurora application of the three additive schema changes. User decisions
still open: capacity sizing (below), Alt-click quick panel, Communication
landing at depth 3 folding the primary rail. The shared media platform-api
container (`orgiq-media-validation-platform-api`) ran out of memory after
~29 h and was restarted; its polling looks leaky.

**2026-10-06.** Local-only; the dirty tree is preserved and nothing
is committed, pushed to a sibling main, or deployed (default AWS identity
still `InvalidClientTokenId`). The Tilt stack (`Tiltfile`: middleware :3001
`dev:mock` + `middleware/.env.tilt.local`, portal :5183, social-sim, the
forwarded platform-api/social-gateway, native SFU :3902) is the shared app
every journey walk and e2e run uses; `LOGIN_RATE_LIMIT_PER_MIN=120` there is
dev-only (production keeps 15/min), and the comment-import env is set so the
documents-parity comments journey runs.

Pins (full SHA, release branches only, both sibling mains untouched):
ui-components **2.429.0** `e04bb7b21603b21bc43b5898ecfcfcde00738aae`
(`size="sm"` on the stat strip, section heading, row list and discussion
heading — the app's one type scale: 14/600 headings, 14/400 body, 12/400
meta; 2.428 shipped in parallel for the Computer Lab demo; 2.427
`MasterDetail` gained a `paneFooter` slot, so the scorecard composer no
longer overrides the pane's overflow; 2.426: 2.425 had committed a per-file `tsc`
declaration emit over the rolled-up `dist/*.d.ts` — a 7 KB `index.d.ts` —
so `build:types` now emits outside `dist/` and the export-surface test checks
every subpath's `.d.ts`; 2.425 made a deleted row name its sender by
`userId` or "a removed member", never a socket client id; 2.424 made
`WrappedChatPanel` forward edit/delete/forward with `canEdit`/`canDelete`; 2.423 added `layout="grid"` to the call
dock so a joined huddle renders participant panes as a grid; the day's chain
2.413→2.429 is recorded in
`docs/ui-components-queue.md` and the flows doc — rich `localMessages`,
`ContextComposer` slots, `HuddleBar` phases/idle group/`T` typography,
`SuggestChanges`/`parseDeckText`, work-node titles, RecordGraph mouse clicks,
ComputerLab empty state, AddPeoplePicker effect, deterministic dts); and
realtime-modules **0.115.0** `7fa168e4fa294d982b5a610556831e453e06f8e4`
(`feat/orgiq-0115`) in **both** consumers (0.108 plugin AuthorityScope +
`workGraph()` stream; 0.109 presence frame lane, sender publish-check dedupe
7→1 per send with per-recipient peer checks kept, `parseDmLobby`; 0.110 DM
send 6.7→3.9 Dynamo requests, `SOCIAL_CHAT_MAX_SOCKETS`; 0.111 the `join`
call verb so a targetless page huddle registers and lobby joins take atomic
seats, which is what lets call chat admit a page huddle; 0.112 the deck
engine as the `/deck` subpath — `middleware/src/lib/deck` is gone,
`lib/deck-shared` keeps the Express/AWS glue, `pptxgenjs` is a direct dep;
0.113 `join` adopts the lobby's live page huddle instead of minting a second
call id and a page huddle no longer tears down when its last peer leaves;
0.114 `cursor({ resolveIdentity, metadataAllowlist })` — the server stamps
cursor identity from the socket's auth context, so a client cannot spoof
another participant's name/colour; 0.115 per-(user, channel) read cursors on
channels without a member list, admitted by the page read gate on every
read/receipt — tenant Discussions now get the unread divider and badges). Install a new pin
**before** editing a consumer import — a premature import crashed the shared
`tsx watch` BFF once today.

Shipped today (all judged locally; see `docs/agentic-flows-migration.md`
slices 1–12 and `docs/activity-graph-migration.md`): `/agent` loop with a
Nova planner (plan card → Approve → summarize/deck/diagram/doc/draft/
document:create/meeting:create steps, durable resume that fails closed on a
moved epoch, box steps out of scope); deck narrative and Revise… for every
tenant through explicit per-tenant drafter modes with a numbers-from-facts
check, `/deck` from the chat thread in every tenant (Social, assessment
scorecard, initiative Discussion, pipelines run) under one write rule
(`deckWriteAuthority`: whoever may run the tenant's agent on the subject); shared/revisable assessment evidence drafts (CAS-decided Accept/
Discard); `/doc` Save resolves document authority; room-call recording
summaries; work graph with sprints/decisions/agent jobs/flow runs and a
person-scoped day over the gateway stream, and tenant-parameterised
pipelines (`/pipelines/activity`) and assessment (`/assessment/activity`,
scorecard Activity tab) graphs on the same stream behind each tenant's read
gates; typing indicators + presence in
all four tenants; message edit/delete/forward in every shared conversation panel
(author-only at the gateway; Forward targets the discussions the actor can
post to); a pre-join device check (library settings form, remembered via
device prefs, "Check devices…" in the footer) in front of every huddle join;
in-call emoji reactions over the tiles on the seat-only huddle namespace;
a Files view for every conversation (`GET /api/uploads?channel=` under the
download's read rule and history floor — the floor now applies to downloads
too); a call log for every tenant (Calls tab per discussion, `/iq/calls`,
`/assessment/calls`, `/pipelines/calls`, over the same call-log rows Social
reads, under each lobby's authority; page huddles are now logged);
the unread "new messages" divider and missed-huddle bell items in every
tenant; live collaborative cursors on the assessment
document canvas (gateway `cursor()` behind the document family's authority —
the orgiq/social/pipelines canvases are still to wire); the bottom Social footer carries the page context (Huddle/
Message) when idle and the full call bar in-call, on every route (93-route
sweep); explore graph mouse clicks and readable zoom restored; a presence-
burst render loop fixed (shell roster copy + library picker effect).

Gate at the close of the 2026-10-06 session (08:30 on the 7th, tree frozen,
every journey log re-walked after the last code lane): middleware typecheck
+ 6,534 jest tests (17 skipped); portal typecheck, build and 1,540 tests; 16
of 17 validators ALL PASS (agent-eval, assessment-decks,
assessment-documents-parity, assessment-tenant, branding,
component-discipline — now ratcheting raw typography utilities —
distillation, honest-numbers, mock-floor, nav-parity, the retired-tenant
removal judge, orgiq-audit, pipelines, rail-parity, route-coverage,
search-workspace). The one red is expected: social-tenant's S2 check on the
four recordings logs, which stay honestly
`limited` — the Tilt stack takes recordings from the real platform-api,
which holds none, so playback and the recording summary cannot be observed
there (they pass on a private stack with the seeded fixture,
`e2e/social-recording-flows.spec.ts`). All four work-graph jest suites freeze
the mock clock at exactly midnight (the assessment provider now stamps
runs/evidence from `mock/core/clock.ts`; a v2 snapshot at the first instant
of the day observes one millisecond in, and `lib/work-graph/day-overlap.ts`
keeps a point event stamped exactly at midnight); `lib/assessment-broker.ts` TTLs still use wall time,
which is fine for TTLs. The audit loop (`scripts/audit-loop/run.sh`,
install-guarded) reports both gates green and only queue-covered upstream
items. Journey walks were concurrent and shared seed users, so a few logs
record a 401 ~30 s after sign-in: the designed session-epoch revocation
tripped by another walker switching tenants as the same user, reclassified
as environment. Follow-ups noticed and not yet chased:  cursors are wired on
the assessment canvas only. The unread "new messages" divider now also works
on the page discussions (initiative/work, assessment team/document, pipelines
run): realtime-modules 0.115.0 (`7fa168e4…`, `feat/orgiq-0115`, unmerged, no
tag) `cursorMode: 'readers'` keeps a cursor per CURRENT reader with no member
list, admitted per frame by the page read gate (`lib/page-thread-unread.ts`,
families marked `cursors` in `lib/tenant-channels.ts`); unread reaches readers
as a bell item, the rail door count and palette rows via
`GET /api/discussions/unread` (server-counted, re-gated per call). The bell item
is also the per-user index of threads, so a memory inbox loses it on restart.
See `docs/realtime-validation/2026-10-07/page-cursors/`.

Capacity (100 calls / 1,000 sockets) is **unaccepted and now understood**:
one 1-vCPU BFF — the deployed single-task size (`middlewareCpu` 1024 when
the gateway is pinned) — is CPU-bound on its JS thread; more Dynamo sockets
or batching do not help at 1 vCPU, and 2 vCPU with 0.110 reaches burst chat
p95 1.2 s / soak 0.7 s (closest, not passing). All 12 native, 3 Redis and 1
DynamoDB contracts pass on the real socket send path; a fenced cookie router
now retires its `/ws` sibling. Evidence:
`docs/realtime-validation/2026-10-06/capacity-{real-send,latency,0109,sizing,sockets}/`
and `2026-10-05/capacity-progress.md`. Decisions left to the user: raise
`middlewareCpu`, accept a smaller profile on 1 vCPU, or lift the
single-gateway safeguard for the Redis multi-node router; also deck
save-permission unification and the initiative-overview Discussion vs agent
composer. Open parity gaps (ranked in `docs/audit-loop/realtime-parity.md`):
huddles on run/document pages, `cursor()`/`rooms()` mounting, work graph
beyond orgiq.

Work resumed after the 2026-10-03 reboot pause. Embedded Social and explicit
To-person delivery now pass real BFF/WebSocket/Dynamo browser checks while
preserving the source tenant, page, shared pin and call runtime. Workspace
presence is shell-owned and reused by Contacts and chat; the cold-DM
joining-to-ready send cancellation is fixed. Current directory role/epoch,
masquerade actor and policy checks surround channel delivery, call
preflight and direct call/notification recipients. The recipient stage installed
realtime-modules 0.101.0 at full SHA
`6fcb05171634767653b8a75be3a66ab442d12838` on
`fix/current-direct-recipients`; its upstream gate passed 1,991 tests.
The current 0.102.1 transport pin is recorded below. Sibling main was not
merged or released. On 2026-10-04, canonical DM page
attachments passed 40 browser checks, 208 backend tests, the fresh 616-route
mock-floor capture, portal typecheck/build and all 1,316 portal tests. Stored
references carry only kind/ID; current reader authority resolves titles and
routes, with unavailable states and explicit workspace selection on Open.
The portal pins ui-components 2.408.0 at
`69d0283d1e6e0cf6d9a3684eaa78dcbf465b3901` on `fix/chat-reference-renderer`;
its full gate passes 10,443 tests and a packed-consumer check. Sibling main
remains untouched. See
[DM acceptance](docs/realtime-validation/2026-10-04/dm-page-reference-acceptance.md)
for current evidence and
[resume acceptance](docs/realtime-validation/2026-10-03/session-resume-acceptance.md)
for the earlier container continuity results.
Work/document links now use explicit canonical OrgIQ corpus associations
(the user confirmed this library on 2026-10-04);
save/reload/open/remove, reader permissions and delayed-receipt navigation
pass local browser acceptance. That phase passed 1,318 portal tests,
342 backend tests, 43 distinct browser checks and a fresh 621-route floor
capture. The additive `work_item_documents_schema.sql` is registered in both
schema loaders but has not been applied or verified on Aurora. Source content
keeps its own permissions; the new page displays the ingested document record.
See [work/document acceptance](docs/realtime-validation/2026-10-04/work-document-association-acceptance.md).
Direct call signalling and notification live/history/reconnect delivery now
recheck current recipient authority, retain inbox rows after filtering, and
fence stale connection/subscription results. The final source and dependency
pin pass 364 backend tests (2 skipped), 1,318 portal tests, 17 real-BFF browser
checks, both consumer typechecks, the portal build, a fresh 621-route floor
and the production gateway build/artifact check. The existing soak container
was not replaced. See
[recipient acceptance](docs/realtime-validation/2026-10-04/direct-recipient-acceptance.md).
Real bidirectional SFU media now passes bounded local acceptance with actual
participant credentials, native WHIP/WHEP connections and synthetic capture.
Audio/video continue through Work selection and People navigation; controls,
remote playback, explicit Leave and invalid credential denial pass.
Focused Work uses the existing grouped list in the rail, compact initiative
context, wrapped 26px item titles, aligned content and a docked composer.
All five OrgIQ roles pass desktop navigation checks, including 1024px; a
390px keyboard-accessible list dialog preserves room for the selected item.
The portal now pins ui-components 2.409.0 at
`f873b424899057a4344664dd9bc1a5b2abb940c0` on `fix/work-item-title-wrap`.
Its full gate passes 10,444 tests (2 skipped), both typecheck targets, build
and packed-consumer checks. Sibling main remains untouched.
The exact work/document provider SQL and three canonical schemas pass six
native PostgreSQL contracts, including 12 concurrent identical links;
all 14 association provider/route contracts pass. This replaces only the
RDS Data API transport and does not establish Aurora/IAM acceptance.
See [focused Work acceptance](docs/realtime-validation/2026-10-04/focused-work-acceptance.md).
The retirement-stage Redis gateway passed eight full BFF process contracts: shared native
SQL directory authority, protected page/chat delivery, current epoch and
operator admission, private membership removal, shared presence, durable
notification replay and abrupt node loss/rejoin after the default 30-second
lease. At that stage both consumers pinned realtime-modules 0.104.0 at full SHA
`68581f7023b9948b7f16cc094d723dc332683039` on `feat/redis-realtime-router`.
The library adds shared presence, trusted peer invalidation hints and readiness;
call fixes preserve caller ownership, group continuity and explicit DM closure.
Its full gate passes 2,023 tests (9 skipped), including 27 native transport/
service contracts, plus build/export and packed-consumer checks. That stage’s
application gate passed 258 tests (2 skipped) in 24 suites with native stores;
portal passes 1,318 tests and nine browser checks use a freshly restarted BFF.
Both consumers pass typecheck/build. Its ARM64 local-only image was
`sha256:0501270a4371409c1e570b60611c163f667a5b961327b653eb219bc5f0802bb3`;
network-disabled inspection confirms its exact library pin and compiled fences.
Normal startup opts into Redis with `REALTIME_GATEWAY_ROUTER=redis`; the default
remains LocalRealtimeRouter. No cloud deployment or guard removal is accepted.
Three actual Redis failure contracts now pass: lost subscriber connections
permanently fence owners, health returns 503, and replacement owners preserve
accepted call seats, caller page ownership and chat history. Stalled command
and publish replies are bounded independently of node-redis's queue timeout.
Late Redis recovery cannot revive a fenced owner; unreleased leases expire
naturally. The full eight-process contracts and nine fresh browser checks pass.
See [retirement acceptance](docs/realtime-validation/2026-10-05/cluster-retirement-acceptance.md)
for that historical stage’s digests, runtime identities and fixture limits. The historical
[two-process service acceptance](docs/realtime-validation/2026-10-05/cluster-service-acceptance.md)
retains its 0.103.0 pin. The newer admission stage below covers cookie-path
ownership and one REST producer; broader producer/outage and capacity work remain open. The earlier
[foundation record](docs/realtime-validation/2026-10-05/cluster-foundation-acceptance.md)
retains its historical source pins and explicitly labels its stale-process
browser evidence. The full integration is approximately 85–87% complete as an
engineering estimate, not a measured acceptance ratio.
The shared page still changes only through explicit sharing. Aurora/IAM and
tenant cloud acceptance, distributed capacity, provisioned directory capacity,
internet/TURN and physical-device media checks, and broader role journeys remain open.
The current default AWS credentials return `InvalidClientTokenId`; no cloud
changes were attempted.
The sealed admission stage used realtime-modules **0.105.0** at
`be54e682d50d750ede04bdae5f47302039826626`. Atomic accepted-seat claims fix a
reproduced cross-node two-tab race; lifecycle reconciliation preserves huddle
joining. Cookie `/realtime` now owns a separate leased namespace and checks
current directory/actor authority on upgrade, subscription and delivery. A
real REST job producer reaches both cookie and JWT peers and stops after an
epoch bump. Directory reads share only before SQL dispatch; later requests
cannot reuse an already-started pre-revocation snapshot. Health diagnostics
refresh independently with pending/stale indicators and immediate router 503s.
See [admission acceptance](docs/realtime-validation/2026-10-05/cluster-admission-acceptance.md):
2,030 library tests, 287 application tests (1 skipped), ten full BFF contracts,
three Redis faults, one durable-store fault, 1,318 portal tests, nine fresh
browsers, packed/compiled artifact checks and both typecheck/build gates pass.
The accepted constrained collision profile establishes 100 calls over 1,000
connections: ten of ten competing-tab races have one winner; all unchanged
latency/health/memory thresholds pass, with 198.1/209.0 MiB peak memory.
The current local ARM64 image is
`sha256:86d3dd3c30818d7850274eae771e3d13df42df8c54287d9bb52e271030dfea8d`.
The full 0.105.0 matrix is complete and unaccepted: both ring-storm/churn
shapes and steady group four passed, while steady group two failed health
p99 and soak/burst still exceeded latency targets. Results remain preserved.
Both consumers then pinned realtime-modules **0.106.0** at
`c5c967ee18fb2fa6dabe126e2dcdd023a4a64dac`. Its fresh local/peer readable
subscription probe lets message producers avoid unnecessary unread alerts;
actual peer DM/private-channel negative and positive delivery checks pass.
Inbox authority work batches only within one reply, without a settled cache.
A real 200-record replay exposed a cold-peer guard ordering bug; fresh resource
hydration now precedes the final synchronous guard, retaining current identity
and pending-resource fences. Replay/removal preserves all stored records.
The 0.106 library gate passes 2,034 tests (9 skipped), build/export and packed
API checks. The sealed inbox-stage gate passes 292 application tests (1 skipped), all 12 native BFF
contracts, 1,318 portal tests and nine fresh local browser checks (stub media).
Both consumer typecheck/build gates and the compiled artifact pass. See
[inbox/producer acceptance](docs/realtime-validation/2026-10-05/cluster-inbox-acceptance.md).
Current local image is
`sha256:9493e0964c2bc1a72f89315c4d84cf96e1fce91cc32b15d54a7b22ec0dc96ac2`.
The unchanged synchronized burst still fails latency and peer health targets;
100 calls/1,000 sockets succeed without collisions, but chat p95 is 4,712.6 ms.
A read-only direct-store route pilot did not show a repeatable improvement
with warmed pools in both orders; its evidence is preserved and only its
additional pilot network attachment was removed. Count/timing-only table
profiling shows membership authority dominates the query queue. The owned load
launcher now checks actual HTTP/router readiness before ramping. The unchanged
readiness-gated burst still fails latency and both health targets.
A later SDK dispatch prototype combines only reads still waiting for a
transport slot and retains fresh snapshots, bounded queue waits and all
revocation fences. Its initial gate passed 60 offline authority tests. A later review reproduced
an overdue-timer race that could start expired jobs; monotonic deadline checks
and iterative draining now prevent it. The latest gate passes 62 offline
authority checks, typecheck/build and compiled controlled-client consumption,
including 1,000 expired jobs. Native performance remains unverified.
The new restricted workspace policy denies the task Docker socket and
localhost listeners. The required access denial has persisted across three
goal turns; the goal is blocked pending environment restoration. Current STS
access is also unavailable; the last reachable identity was invalid. Runtime/image/browser evidence remains at the sealed
inbox stage, and default AWS identity remains invalid. One passing collision profile does not
accept all capacity. See
[current capacity work](docs/realtime-validation/2026-10-05/capacity-progress.md)
for live handles, fixture identities and full remaining scope. Keep the
single-gateway safeguard and all unrelated uncommitted work.

Claude session `895623a5-39e4-4b2a-bc9d-9609a0a84aea` was recovered on
2026-10-01 after its weekly limit interrupted the release and audit work.
The previously approved sibling fixes are now pushed and integrated:
realtime-modules v0.99.4 (`94bf705e9a4be312d1b54aac83b374b227a2ca4e`)
and LVS worker placement (`1c26334bd7508fc5fc6afbb1319e6d2fd7a0aa45`).
Both sibling trees are clean. This repo's accumulated changes remain
uncommitted; preserve them.

Feature work resumed from the latest Social design (§4.4) on 2026-10-01:
shared message pins are implemented. Pin/unpin actions and the Pinned view
use the installed conversation composites and `usePins`; peers update live,
pins survive reloads, and Jump opens the original message. Failed saves
roll back with a visible explanation. The BFF authenticates every pin
request and checks current Social grants and channel/DM/team membership.
It derives excerpts, authors and timestamps from the stored original, respects
member history floors, and hides missing/deleted originals. Authenticated
older-message lookup makes Jump work beyond the loaded transcript and
explains an intervening history gap. The host accepts 256-character channel
identifiers; a real private-team regression covers the former 50-character
limit. Conversation send readiness requires a chat join and persisted send
acknowledgement; errors/timeouts retain the draft with a visible explanation.
The library owns `MemoryChatPinsStore` and `DynamoChatPinsStore` (90-day TTL).
The recovery stage pinned realtime-modules 0.100.2 at
`373182242a7ee115ef1d787a61b25054105c5a14`, pushed on `fix/persisted-call-restart`;
the current 0.102.1 pin above includes the earlier `feat/chat-pins` release
and atomic Redis-backed participant resume/conditional prune contracts for
gateway restart recovery. The sibling main remains at the approved 0.99.4
release above. The Social
stack now grants the middleware access to `chat-pins`; no AWS deployment
was performed. See `docs/social-tenant-goal.md` for the implementation
record and the new S1 pin checks.

On 2026-10-03, personal team Pin/Unpin was wired into the installed
`TeamChannelTree` menu using the existing upstream membership-favorite API.
Only the authenticated member's preference changes. The BFF checks current
Social role grants, exact session epoch, masquerade actor authority, active
team membership and the upstream receipt; forged actor/tenant bodies refuse.
Participant Leave now uses ViewSocial for self, while removing someone else
still requires ManageTeams and the team's owner. Membership writes fence
older list/detail reads so they cannot restore gateway admission after Leave.
The actor-scoped frontend waits for persistence, shares per-team locks with
Leave, rejects stale reads and guards delayed errors/navigation. Receipt
reconciliation expires after one poll interval so another tab may supersede
the same actor's preference. The feature passes 13 pure client/model tests
and 41 registered-handler/provider tests; the full portal suite passes 1,254.
Portal and middleware typechecks, portal production build, component
discipline, nav parity and 78 wire/policy tests pass. Twelve new browser
contracts are prepared and discovered, but unrun because localhost binding
is still denied with EPERM. A code-derived installed TeamChannelTree keyboard
menu defect has a separate unskipped contract and a ui-components queue row.
The 24 previously sealed Social role/surface logs now need a fresh walk;
their old digests were retained. No live-media acceptance or deployment is
claimed. See `docs/social-tenant-goal.md` for the bounded implementation.

With three subagents, feature work continued from Social design §3.4 and
the Assessment document parity plan: completed drafter replies are stored
as versioned proposal metadata, recovered on reload and by other authorized
editors, and notify the canonical document owner. Apply claims the version
before insertion; a receipt in the Yjs transaction and a fresh canonical
save acknowledgement guard completion and reload recovery. Failed
confirmations retain the claim and retry without inserting twice. Discard
is shared; readers have no mutation controls. The additive Aurora proposal
schema has not been deployed. See the document parity goal, decision 8.
Proposal notification links now open the exact source-scoped draft in the
Editor tab, including targets beyond the active-list cap and retained
applied/discarded metadata. Readers get its content preview. Missing targets
leave unrelated edits available; failed lookups can be retried. Navigation
guards discard old-target responses and refreshes preserve newer decisions.
The installed `Revise…` action now refines ready drafts with their prior text
as separate context and preserves the original selection/caret. Revision CAS
updates the same metadata row, keeps source/author/target immutable and makes
same-actor response-loss retries duplicate-safe. Stop/generation failure
restores current metadata; transient save failures keep the generated candidate
and Retry reuses it. Concurrent decisions refresh rather than overwrite.
Revise waits for unsaved initial drafts, rejects empty source context and
keeps structured requests within the invoke route's actual size limit.

Initiatives now uses `InitiativeHeaderFrame` because the installed
`ScopeHeader` lacks a 20px size. All/My/Sprints/detail measured 20px/600
at 16–17px under the visible trail, with its controls and tabs checked.
The Inbox's spacing margin and its admin action alignment are fixed.
The previous recovery validated all four branding journeys. Current feature
checks pass: portal typecheck, 1,254 tests and production build; library
0.100.1 typecheck/build and 1,919 tests; 20 pin API tests; 89 proposal/broker
tests before Revise; and 37 current pure portal edit/client tests. All four real pin browser
journeys pass, including 1,001 newer messages before Jump and real-server
rejection/draft retention/retry; all five pin
forgery/history-floor/deletion checks pass. Before Revise, twelve proposal browser contract
journeys passed for recovery, failed Discard/retry, reader controls, exact targets
beyond 100 rows, applied/discarded previews, missing/failed lookups, navigation
and delayed-response regressions. They explicitly stub proposal responses
and unavailable canonical services, so they do not validate a real Apply/save.
At that preceding checkpoint, mock-floor (607 routes,
329 GET entries, 265 captured responses), component discipline, nav parity
and route coverage passed.
Revise currently passes 70 provider tests, 18 direct registered Express handler
contracts, 77 wire/policy tests and middleware typecheck. Non-HTTP middleware
checks use a temporary config omitting the unrelated global listener hook;
standard HTTP tests remain intact and could not run because localhost binding
is denied with EPERM. The browser spec discovers 25 cases (12 existing,
13 revision cases), all unrun after this feature in the restricted sandbox.
Component discipline, nav parity and document parity quick checks pass.
The route scanner directly reports 608/609 covered routes, at the unchanged
one-route budget; its shell wrapper's tsx IPC listener is also blocked.
The static route inventory now has 609 routes. Revision and personal team
preference capture refusals were generated from their policies; prior response data, capture timestamps and
server digests remain unchanged. Fresh wire/write captures and the full
mock-floor gate are pending until the dev HTTP server can bind again.
Direct headless rail measurements on the dedicated :5261/:3061 stack pass
for Assessment and all six Social surfaces. The rail wrapper expects the
owner ports and cannot measure when they are down; do not start them.
The earlier full middleware rerun passed 376 suites and 5,293 tests (one integration
skip); the subsequent long-team gateway regression and tenant suites pass
19 tests. Before the personal team preference feature, all 24 Social
role/surface audits were re-observed and sealed:
12 conversation records pass and 12 media records remain limited by the
unavailable platform-api/SFU stack. All local interactions pass with no
console errors or overflow; this does not establish live media acceptance.
The prior Social stack's 46 tests pass. The mock scanner distinguishes named
RegExp constants from Aurora `exec` calls without increasing its budget.
LVS: lint and 224 test files pass;
the same two baseline failures remain (createRetry and a missing-Redis timeout).

The original 100-call / 1,000-socket 1:1 churn scenario now passes: 20/20
reconnected sockets, zero early-ended calls or cross-call deliveries,
health p99 36.8ms, peak RSS 235.3MiB. See the capacity review's final section.
The previous mock wire/write snapshots were recaptured from the restarted
server before Revise; they require another real capture for the changed
handlers. At the recovery checkpoint, eleven of
the sixteen quick validators passed. The remaining audit work is below
(Social includes the Assessment validator).

The remaining audit work is to re-observe and seal 63 Org, 10 Search and
6 Distillation journey logs, then close the 34 open Org defect records with
fresh evidence. Assessment needs 19 records refreshed: workspace, enterprise,
rules and prompts for all four roles, plus `stretch/accessibility.md`,
`stretch/realtime.md` and `REVIEW-2026-09-05.md`. Social needs all 24
role/surface logs refreshed after the personal team preference changes;
its validator also remains red through limited live-media acceptance and
the Assessment freshness dependency. The earlier shared-message pin checks pass.
Do not seal logs merely to clear a digest mismatch.
AWS deployment/media validation remains outside the completed local checks.
The original Claude transcript is at
`~/.claude/projects/-Users-connorhoehn-Projects-aws-agentcore/895623a5-39e4-4b2a-bc9d-9609a0a84aea.jsonl`;
its per-lane scripts and reports are under that session's directory in
`/private/tmp/claude-501/-Users-connorhoehn-Projects-aws-agentcore/`.

The 2026-09-19 checkpoint was pushed as `f837bd68`; the user subsequently
resumed work. Read [the handoff](docs/handoff-2026-09-19.md) for the checkpoint's
completed fixes/tests and unfinished browser verification. Its pause is
historical; do not treat the checkpoint as full acceptance.

