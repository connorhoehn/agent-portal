# aws-agentcore — agent context

Organizational Intelligence Platform (OrgIQ) accelerator. Multi-agent system
on Amazon Bedrock AgentCore: ingests org docs → builds knowledge graph → scores
expertise → serves conversational search. See CONSTITUTION.md for full spec.

**How to read this file.** *Orientation* (Architecture → Common workflows) is
the map: where things live, what deploys what, how to run it. *The docs map*
points at the long-form design docs and the validators that judge them.
*Gotchas* is the scar tissue — each entry is a day someone lost, grouped by
the area it bites in, and each says **why**, not just what. Skim the gotcha
headings; read the one whose area you are about to touch. Everything here is
meant to be checkable: if a claim disagrees with the code, the code wins and
the claim is a bug in this file.

---

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

# Orientation

## Architecture

- **notebooks/** — JupyterLab exploration. Split by cloud: `notebooks/aws/` (Python 3.12, boto3, bedrock-agentcore SDK) and `notebooks/gcp/` (Python 3.12, google-cloud-aiplatform, vertexai, google-genai). Both mount `notebooks/` at `/workspace` so the file browser sees both flavors.
- **agents/** — 8 Strands Agents (6 OrgIQ + 2 assessment), Python 3.12, deployed to AgentCore Runtime via multistage Docker. Shared helpers in `agents/_shared/`; common base image in `agents/base/`. `agents/devbox/` is a ninth runtime but not a Strands agent (it runs Claude Code — see the devbox gotcha).
- **infra/** — CDK TypeScript stacks (Aurora, OpenSearch, Guardrails, KB, AgentCore Memory/Policy/Capabilities/Runtime/Gateway/Telemetry, Authorization, Authentication, SpanProjector, PromptCanary, Devbox, MiddlewareService)
- **middleware/** — Express 5 + `@connorhoehnslalom/realtime-modules` (AG-UI SSE proxy, RDS Data API queries against Aurora, WebSocket bridge, OI trace sink)
- **portal/** — React 19 + Vite 7 (ui-components library, @xyflow/react for graphs)
- **schema/** — Aurora SQL (`orgiq_schema.sql` + `orgiq_work_items_schema.sql` + observability + `program_schema.sql` + `assessment_schema.sql` + `identity_schema.sql`) and LLM-driven synth corpus pipeline

## Local dev

```bash
node scripts/docker/prepare-libraries.mjs # export exact locked library commits
docker-compose up --build            # jupyter + middleware + portal
docker-compose up jupyter            # AWS notebooks at :8888 (cd /workspace/aws)
docker-compose up jupyter-gcp        # GCP notebooks at :8889 (cd /workspace/gcp)
docker-compose up middleware portal  # App stack at :3001 + :5183
```

**Working without AWS** (stack torn down, credentials expired, offline):
```bash
cd middleware && npm run dev:mock    # then `cd portal && npm run dev` as usual
```
`dev:mock` turns on the `MOCK_*` providers, sets `DEV_OFFLINE=true` +
`NODE_ENV=development` + `AUTH_DEMO_MODE=true`, *and* blanks `POLICY_STORE_ID`,
`SESSION_SIGNING_SECRET_ARN` and the `COGNITO_*` vars. Blanking matters:
`.env.aws` is only read for vars the shell leaves undefined, so a stale
`POLICY_STORE_ID` makes every gated route 503 with "authorization unavailable",
and stale Cognito vars redirect login to a hosted UI that may no longer
resolve. Blank means open-mode authz (dev-only) plus the user picker. The mock
fixtures mirror `schema/seed_program.sql`, so initiatives, work items, budgets
and sprint envelopes all render with the real cast.

**The mock is a contract, not a pile of stubs** — `docs/mock-floor.md` is the
working guide and `middleware/src/mock/core/contract.ts` is the reasoning (the
five bug classes that put it there). The short version: a fixture exports rows
and selectors, never a number it could have counted from rows it also exports;
every timestamp comes from `mock/core/clock.ts`; every wire-shaped string is
checked against a captured real response rather than typed from memory; and a
write mutates a **registered** fixture so `POST /api/__mock/reset` undoes it.
To see an empty or error state, ask for it — `GET /api/__mock/scenarios`,
`POST /api/__mock/scenario {"scenario":"empty","fixture":"bots"}` — instead of
damaging shared state and warning the next person in a journey log.
`GET /api/__mock/state` reports what is currently loaded. The router
(`middleware/src/routes/mock-control.ts`, mounted at the app root in
`index.ts`) 404s unless `NODE_ENV !== 'production'` **and** at least one of
`MOCK_AURORA` / `MOCK_AGENTCORE` is on, and each route additionally honours an
optional `MOCK_CONTROL_SECRET` header check.
`./scripts/validate-mock-floor.sh` is the judge, and its budgets are ratchets:
they may go down, never up.

**Agents are NOT in docker-compose.** Develop agents with:
```bash
cd agents/<name> && agentcore dev    # Hot-reload local server at :8080
```

The agent unit tests (`agents/_shared/test_*.py`) import `botocore`, which the
host's `python3`/`python3.12` does not have — run them in the synth venv, which
does: `cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_prompt_source test_callbacks`
(61 tests). Never `pip install` to fix this.

Requires `~/.aws` credentials. Run `aws-azure-login --mode gui` first — the `default` profile assumes `aws-innovationlabs-washingtondc1-admin` in the **innovation lab account `647757222309`** (us-east-1). ⚠️ Account `264161986065` is a personal account and must NOT be used for this project.

## Key SDKs

Python pins live in `agents/base/Dockerfile` (the shared base installs them
once) and are mirrored per agent in `agents/*/pyproject.toml`. All eight
Strands agents pin identically.

| Package | Version | Purpose |
|---------|---------|---------|
| `strands-agents` | >=1.55 | Agent framework (@tool, Agent, stream_async) |
| `bedrock-agentcore` | >=1.9 | Runtime, Memory, Identity, AG-UI, A2A |
| `ag-ui-protocol` | >=0.1.18 | AG-UI event types + SSE encoder |
| `ag-ui-strands` | >=0.1.8 | Strands → AG-UI adapter (StrandsAgent) |
| `aws-opentelemetry-distro` | >=0.12.1 | ADOT — **not** vanilla `opentelemetry-distro`, see the ADOT gotcha |
| `boto3` | >=1.34 | Bedrock, RDS Data API (Aurora), S3, DynamoDB, OpenSearch, Verified Permissions |
| `@aws/agentcore` | latest | AgentCore CLI (npm global install — bundled into the jupyter image; install globally on the host if you want `agentcore dev`/`agentcore exec` outside Docker) |

Two deliberate exceptions: the supervisor takes `bedrock-agentcore[a2a,ag-ui]`
(everyone else takes `[ag-ui]`), and `agents/devbox` pins only
`bedrock-agentcore` — it is not a Strands agent and has no ag-ui dependency.

⚠️ Those extras are what each `pyproject.toml` DECLARES, not what the images
install: `agents/base/Dockerfile` installs the superset
`bedrock-agentcore[a2a,ag-ui]` once and `agents/Dockerfile.agent` is a thin
`FROM ${BASE_IMAGE}`, so every shipped agent image carries the `a2a` extra
whether or not its pin asks for it — and nothing uses it. The supervisor's
sub-agent calls are `invoke_agent_runtime` against each sub-agent's runtime
ARN, the plain Runtime API, not A2A; its docstring claimed otherwise until
2026-09-16. See `docs/research-strands-graph-2026-09-16.md` for why the
routing stays hand-rolled rather than becoming a Strands `Graph`.

## CDK vs AgentCore CLI — what deploys what

| Resource | Deployed by |
|----------|-------------|
| Aurora Serverless v2 cluster (PostgreSQL + pgvector) | CDK (`OrgIQ-Aurora`) |
| OpenSearch Serverless + Bedrock KB | CDK (`OrgIQ-KnowledgeBase` — `CfnKnowledgeBase` + `CfnDataSource`) |
| Bedrock Guardrails (one per role, `orgiq-guardrail-<role>`) | CDK (`OrgIQ-Guardrails` — `CfnGuardrail`) |
| Verified Permissions policy store + Cedar policies | CDK (`OrgIQ-Authorization`) |
| Cognito User Pool + Hosted UI + app client (enterprise SSO) | CDK (`OrgIQ-Authentication`) |
| S3 buckets, DynamoDB tables, IAM roles | CDK (`OrgIQ-Foundation`) |
| CloudWatch dashboards + budget alarm | CDK (`OrgIQ-Observability`) |
| Agent ECR repos + execution roles (8 agents + shared base) | CDK (`OrgIQ-AgentCoreRuntime` — phase 1). `OrgIQ-Agents` owns the *agent* IAM roles and Managed Prompts for the same 8. |
| Agent Runtime (`CfnRuntime` + `CfnRuntimeEndpoint`, all 8 agents) | CDK with `--context deployRuntimes=true` (`OrgIQ-AgentCoreRuntime` — phase 2) |
| MCP Gateway + targets + Cedar policies | CDK (`OrgIQ-AgentCoreGateway` — `CfnGateway`, `CfnGatewayTarget`, `CfnPolicy`) |
| AgentCore Memory | CDK (`OrgIQ-AgentCoreMemory` — `CfnMemory`) |
| AgentCore Policy Engine | CDK (`OrgIQ-AgentCorePolicy` — `CfnPolicyEngine`) |
| AgentCore Capabilities (Code Interpreter, Browser + profile, Workload Identity) | CDK (`OrgIQ-AgentCoreCapabilities`) |
| Custom Evaluators + alarms + anomaly detectors | CDK (`OrgIQ-AgentCoreTelemetry` — `CfnEvaluator`) |
| Online Evaluation config | CDK with `--context enableOnlineEvalConfig=true`. No L1 exists — it is a raw `CfnResource` of type `AWS::BedrockAgentCore::OnlineEvaluationConfig`. |
| Span Projector Lambda (OpenInference → Aurora observability tables, 1-min schedule) | CDK (`OrgIQ-SpanProjector`) |
| Prompt canary (A/B + judge managed prompts, SSM params, SFN controller) | CDK (`OrgIQ-PromptCanary`) — `deployCanary` defaults **true** in `cdk.json` |
| Devbox runtime (Claude Code in a microVM, session storage) | CDK with `--context deployDevbox=true` (`OrgIQ-Devbox`) |
| Middleware on ECS Fargate + ALB | CDK with `--context deployMiddlewareService=true` (`OrgIQ-MiddlewareService`) |
| Social calls: image repos, the SFU (+ optional coturn, `deployTurn`), platform-api + Redis + tables | CDK, opt-in: `deploySocialImages` / `deploySocialMedia` / `deploySocial` (`OrgIQ-SocialImages`, `OrgIQ-SocialMedia`, `OrgIQ-Social`) — `docs/social-calls-deploy-plan.md` §8–§9, sizing and the 100-call profile §11 |
| Portal on S3 + CloudFront; HTTPS without a domain for the middleware, platform-api and SFU signalling | CDK, opt-in: `--context deployPortal=true` (`OrgIQ-Portal`, plus the ALB side on the middleware/social stacks); publish with `node scripts/portal-publish.mjs` — §10 of the same doc |

## Agent Dockerfile requirements (AgentCore Runtime)

These live in **`agents/base/Dockerfile`**, the shared base image every agent
extends. `agents/Dockerfile.agent` is a ~20-line `FROM ${BASE_IMAGE}` plus two
`COPY` layers — it carries none of these directives, so a change here goes in
the base.

- Multistage: `uv` builder → `python:3.12-slim` production
- Non-root user: `bedrock_agentcore` (UID 1000)
- Ports: 8080 (HTTP/AG-UI invocations), 8000 (health/MCP)
- Health check: `GET /ping` on 8080
- CMD: `opentelemetry-instrument python -m main`
- Max image size: 2 GB (AgentCore Runtime quota)
- ARM64 at deploy — built locally with `docker buildx`, not CodeBuild (see the build-order gotcha)

## Conventions

- TypeScript strict mode for middleware, infra, portal
- Python 3.12+ for agents and notebooks
- Org graph lives in Aurora PostgreSQL as relational tables (no Neptune, no AGE — see `schema/orgiq_schema.sql`)
- Graph access via RDS Data API + parameterized SQL. Read tools enforce SELECT/WITH only.
- AG-UI protocol for agent→frontend streaming (SSE transport, POST not EventSource)
- A2A protocol for agent→agent communication
- Cedar policies live in **Verified Permissions** (`OrgIQ-Authorization` stack); the supervisor resolves a role per request and attaches the role-specific guardrail at model-build time
- All notebooks share `config.json` for cross-notebook state (progressive enrichment). It is gitignored — `notebooks/aws/config.json` is generated by `01-setup-credentials.ipynb`.
- Resource tracker (`notebooks/aws/cleanup_utils.py`, mirrored in `notebooks/gcp/`) tracks all AWS resources for safe teardown
- `INSERT ... ON CONFLICT DO UPDATE` for idempotent upserts (handled by graph-builder `merge_*` tools)
- Scores stored as columns on `people` (`expertise_score`, `pagerank_score`, `composite_score` — `schema/orgiq_schema.sql`)
- Titan Embeddings V2 at 1024 dimensions everywhere (`node_embeddings vector(1024)` in Aurora + Bedrock KB)
- **OpenInference instrumentation** lives in `agents/_shared/instrumentation.py` (root AGENT span, RETRIEVER spans, guardrail capture). Spans are exported via ADOT and projected into Aurora observability tables by the `OrgIQ-SpanProjector` Lambda
- Default model is `amazon.nova-pro-v1:0`, overridable per agent via `MODEL_ID` env var (AWS-native only — no Anthropic models)

## Naming conventions

- AWS resources: prefix `orgiq-` (`orgiq-knowledge-base`, `orgiq-aurora`, `orgiq-guardrail-<role>`, `orgiq-agent-base`)
- CDK stack names: `OrgIQ-Foundation`, `OrgIQ-Aurora`, `OrgIQ-KnowledgeBase`, `OrgIQ-Guardrails`, `OrgIQ-Authorization`, `OrgIQ-Authentication`, `OrgIQ-Agents`, `OrgIQ-Observability`, `OrgIQ-AgentCoreMemory`, `OrgIQ-AgentCorePolicy`, `OrgIQ-AgentCoreCapabilities`, `OrgIQ-AgentCoreRuntime`, `OrgIQ-AgentCoreGateway`, `OrgIQ-AgentCoreTelemetry`, `OrgIQ-SpanProjector`, `OrgIQ-PromptCanary`, `OrgIQ-Devbox`, `OrgIQ-MiddlewareService` (18 with `cdk.json`'s defaults); opt-in: `OrgIQ-SocialImages`, `OrgIQ-SocialMedia`, `OrgIQ-Social`, `OrgIQ-Portal`
- Agent names: `orgiq-supervisor`, `orgiq-search`, `orgiq-scoring`, `orgiq-advisor`,
  `orgiq-ingestion`, `orgiq-graph-builder`, `orgiq-assessment-scorer`, `orgiq-assessment-drafter`
- DynamoDB tables: `orgiq-scores`, `orgiq-sessions`, `orgiq-leaderboards`
- S3 buckets: `orgiq-documents-{account}-{region}`, `orgiq-artifacts-{account}-{region}`
- Tenants (`TENANTS` in `middleware/src/lib/session.ts`, four): `orgiq`, `assessment`, `social`, `pipelines`; portal trees `/iq` + `/admin`, `/assessment`, `/social`, `/pipelines`; API prefixes `/api/assessment`, `/api/social`, `/api/pipelines` (orgiq's routes are unprefixed)

## Common workflows

```bash
# Deploy all infrastructure (18 stacks with cdk.json defaults) — cleans up
# orphaned resources first, then reconciles every stack's real CFN status
cd infra && ./scripts/deploy.sh

# Deploy a single stack
cd infra && ./scripts/deploy.sh OrgIQ-Aurora

# Phase 2: deploy runtimes after pushing container images to ECR
cd infra && ./scripts/deploy.sh OrgIQ-AgentCoreRuntime --context deployRuntimes=true
# ...or only the agents whose images actually exist:
cd infra && ./scripts/deploy.sh OrgIQ-AgentCoreRuntime --context deployRuntimes=true --context onlyAgents=supervisor,search

# Turn on online evaluation. `enableEval` is already "true" in cdk.json, so in
# practice only the config resource needs asking for:
cd infra && ./scripts/deploy.sh OrgIQ-AgentCoreTelemetry --context enableOnlineEvalConfig=true

# Destroy everything — drains Cedar policies, orphan gateways, runtimes and
# the Aurora cluster first, destroys the opt-in stacks too, then sweeps for
# survivors that still bill (PURGE_RETAINED=true also deletes the RETAINed
# social tables and image repos)
cd infra && ./scripts/destroy.sh

# Middleware image (ARM64, locked library commits) → orgiq-middleware:latest
node scripts/docker/middleware-image-build.mjs --dry-run
# Portal bundle → OrgIQ-Portal's bucket + invalidation (deployPortal=true)
node scripts/portal-publish.mjs --dry-run

# Run CDK synth (dry-run). Needs live credentials for context lookups.
cd infra && npx cdk synth

# Invoke deployed agent
agentcore invoke --agent orgiq-supervisor --prompt "Who knows auth best?"

# Test agent locally
cd agents/search && agentcore dev "Find Kubernetes experts"

# Middleware tests (jest + supertest) and typecheck
cd middleware && npm test && npm run typecheck

# Agent unit tests — in the synth venv, which has botocore
cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_prompt_source test_callbacks

# Golden-set eval harness — structural mode (free, offline, no AWS); see docs/agent-eval-goal.md
cd agents/tests && ../../.venv-synth/bin/python golden_runner.py
# Live grading against a deployed runtime or `agentcore dev` — real Bedrock $, needs credentials
cd agents/tests && ../../.venv-synth/bin/python golden_runner.py advisor --mode live

# Generate the synthetic demo corpus (personas, ADRs, postmortems, perf reviews,
# Slack threads, all-hands recaps).
# Requires Aurora + KB deployed and schema/seed.py applied first.
python3.11 -m venv .venv-synth && .venv-synth/bin/pip install -r schema/synth/requirements.txt
.venv-synth/bin/python -m schema.synth all                # full pipeline
.venv-synth/bin/python -m schema.synth all --skip-load    # generate only, no Aurora/S3/KB writes
.venv-synth/bin/python -m schema.synth stats              # corpus + cache snapshot
```

## Project dependencies

- **ui-components** (`~/projects/ui-components`): `@connorhoehnslalom/ui-components`,
  installed at **2.407.40** (sha `e95120a8`, verified 2026-09-30 with the two settling
  commands below; 2.407.9 carries the CallDock render fixes and `--dock-floor`). 2.385 added `@tiptap/extension-mention` to what the rich
  composer imports; it is an *optional* peer, so npm does not install it and Vite
  fails at runtime with "Could not resolve @tiptap/extension-mention" — the portal
  now lists it directly. Check new optional peers after every bump. The portal pins it by **git sha** in `package.json`
  (`github:connorhoehnslalom/ui-components#<sha>`) rather than resolving a range
  from GitHub Packages — bump by moving the sha. It resolves over SSH, so no
  `GITHUB_TOKEN` and no registry `.npmrc` are needed; `portal/.npmrc` holds only
  `strict-ssl=true`. (Older instructions here described a
  `@connorhoehnslalom:registry=https://npm.pkg.github.com` + `_authToken` setup —
  that applied when the dep resolved from GitHub Packages and no longer does.)
  Peer deps include react 19, @xyflow/react 12, recharts 3, yjs 13, @tiptap/* 3,
  @xterm 6.

- **realtime-modules**: `@connorhoehnslalom/realtime-modules`, pinned by sha in
  **both** middleware and portal. The middleware uses
  `.../agent-streaming` (`routes/agents.ts`, the AG-UI streaming route). The
  generic service-signing proxy in `routes/gateway-proxy.ts` is retired (410):
  it had no verified user/channel-membership contract. Portal health probes
  still use `.../proxy-client`. The library replaced the older
  `distributed-core` import — nothing in the repo depends on `distributed-core`
  any more, and a lone stale comment in `providers/distillation.ts` still names
  its EventBus. ⚠️ Two remotes, two version lines: this repo pins the
  **`connorhoehn/realtime-modules`** canonical repository (the slalom fork is
  the second remote and is not what either package.json points at). As of
  2026-10-05 **both** consumers pin
  `39263ce8deb3811dd2e6147e980c23d3da51c565` (0.112.0; the 0.105.0 admission stage above used `be54e682d50d750ede04bdae5f47302039826626`).
  Earlier `94bf705e9a4be312d1b54aac83b374b227a2ca4e` (0.99.4, tag `v0.99.4`: reconnecting
  call participants regain their seats and peers stay through rejoin grace;
  jittered socket retries; `maxPayload`, set to 256 KiB on `/ws`;
  0.99.3: tenant-prefixed
  DM / group lobbies knock for outsiders; 0.99.2 resolves a relative WHIP/WHEP
  `Location` against the endpoint so Leave's DELETE reaches the SFU, uses the
  SFU's ICE answer as-is (offer-ready ~140 ms, was ~3 s), names remote tiles
  from the SFU frames and exposes `appUserId`, `archiveRoom` POSTs
  `/archive`; 0.99.1 makes every callee socket ring with the first `accepted`
  taking the call; 0.99.0 = `c09930fa`: `DynamoChatStore` under `server/stores/dynamo`
  with `chat(store.chatOptions(extra))`, `FeaturePlugin.onMessage`/`onConnect`
  carry `userId`, `onReaction` carries the sender's `org`; the gateway also
  serves `notifications()` since 0cf97d21 — see `docs/social-tenant-design.md`
  §3; before that `71a46567` = 0.98.7, tag `realtime-modules-v0.98.7`; from `d84d9612`/0.98.3 via 0.98.4–0.98.6 — 0.98.4
  fixed the ghost participant after both call sockets close under
  `attachRealtime`, recognises tenant-prefixed `<org>:dm:` lobbies, and
  refuses targetless invites by default (`calls({ allowUntargetedInvites })`);
  0.98.5 stamps chat/presence/reaction sender identity from the socket's
  auth context instead of trusting the frame (`chat({ resolveSender,
  trustFrameSender })`, default untrusted — so our gateway `auth` MUST return
  `displayName`, and it does) and ships `typesVersions` so the `/server`
  types resolve under `tsconfig.test.json`'s `moduleResolution: "node"`;
  0.98.6 makes the router the single authorization point — a refused
  presence/reactions/cursor subscribe reaches no service state, and every
  fan-out (presence `set`, reactions, cursor, chat send/edit/history/members)
  runs `authorize` first, answering `AUTHZ_CHANNEL_DENIED`; chat channels
  arrive at the hook unprefixed, only presence/reactions/cursor wrap as
  `presence:`/`reactions:`/`cursor:` (`splitServiceChannel` strips them);
  0.98.7 gates presence `get` by `targetClientId` on a readable shared
  channel, answering an unreadable target like an unknown one; middleware
  typecheck and the gateway tests unchanged — one test had to change:
  `distillation-realtime.test.ts` asserted "no frame names the refused
  channel", and since 0.98.6 the refusal itself is an error frame naming
  it). ⚠️ `jest.config.cjs`
  ignores TS2307/TS2304/TS2345, which is how a `/server` type import once
  became `any` silently — un-hiding those codes is an open follow-up. 0.98.x adds the conversation-call surface
  under `/client/video` — `useConversationCall`,
  `useIncomingConversationCalls`, `conversationCallDockProps`,
  `useDevicePreferences`, `dmLobbyName` — and `calls({ lobbyGuard })` on the
  server; the initiative call (`portal/src/pages/projects/InitiativeCall.tsx`)
  uses it. `/client/video` ships its own `LVSProvider` and WHIP/WHEP
  transport: it neither bundles nor peer-depends on `@connorhoehn/lvs-react`
  / `lvs-client`, so no LVS package is installed here. 0.97 dropped `./package.json` from the
  package's `exports`, so the settling version check is
  `node -p "require('./node_modules/@connorhoehnslalom/realtime-modules/package.json').version"`
  from `portal/` or `middleware/` — `require('…/package.json')` by package
  name throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The portal's socket
  authenticates with the BFF's realtime token: `portal/src/lib/realtimeToken.ts`
  fetches and caches `GET /api/session/realtime-token` (cleared by
  `clearTenantScopedCaches`), and `OptionalGatewayProvider` hands it to
  `GatewaySocketProvider`'s `token`, which the library sends as
  `Sec-WebSocket-Protocol: bearer-token-v1, <jwt>`. A changed `token` prop
  reconnects the socket, so the token is swapped only when the socket is
  down, never proactively while connected.
  The middleware also imports `.../server` and `.../adapters/tiptap`
  (distillation realtime, document canvas), not only `agent-streaming`.
  The dependency key remains
  `@connorhoehnslalom/realtime-modules` so existing imports keep working.
  The former slalom 0.17.0 pin advertised server/typed-documents subpaths with
  absent built files. Server exports now load. The full document workflows
  additionally depend on platform-api; see
  `docs/document-backend-integration-2026-09-19.md`. Do not confuse that REST
  backend with the package's typed-documents subscription service.
  [The workspace reuse research](docs/document-workspace-reuse-research-2026-09-20.md)
  records the shared canvas composition, converter regressions, and the user
  requirement to preserve the accelerator's navigation/draft/publish UX.

**Realtime integration task exception (user-authorized 2026-09-19):** the user
explicitly requested fixes in the owning sibling repos while making the MQ/DC/
realtime middleware and supporting Docker containers reusable and deployable
through CDK. For this work, read each repo's instructions, fix shared contracts
upstream, and record commits and consumer verification. Preserve unrelated
in-flight edits. Do not rebuild UI that those projects already provide.
See [the middleware deployment research](docs/realtime-middleware-deployment-research-2026-09-20.md).
Outside that task, consume libraries and queue UI gaps in
`docs/ui-components-queue.md`.

## Synthetic corpus pipeline (`schema/synth/`)

Generates a complete demo corpus from the seed graph using AWS-native models.
Reads people/teams/skills/projects/decisions from Aurora, writes documents +
mentions + node_embeddings back. Per-doc disk cache makes reruns free.
`verify_adr.py` / `verify_docs.py` spend real Bedrock $ — don't run them
casually. Corpus size is not fixed: the per-type counts in `synth/config.py`
are env-overridable defaults multiplied by live row counts, so read
`schema.synth stats` rather than trusting a remembered total. Ballpark cost for
a full demo-grade run is well under a dollar.

## Program operating model

See `docs/program-operating-model.md` for the full frame. In short: one **owner**
runs each initiative and a few **SMEs** attach across several — never a ten-person
team per initiative. A release manager (`org-leader`, holds `ManageBudgets`)
allocates `initiative_budgets` monthly and grants an SME a sprint envelope
(`budget_grants`); the SME (`sme` role — member + `DispatchAgentRun`, explicitly
forbidden `ApproveTransaction`) spends it by assigning agents to work. Work is
estimated in **complexity** (`story_points`) and **dollars**
(`estimated_cost_usd`), never human-hours. Cron bots are the **baseline cost of
maintaining** an initiative's repos — `v_initiative_maintenance_30d`
(`schema/program_schema.sql`) is that floor, and an allocation should be read
against it. Bots on an initiative target enqueue `agent_jobs` for the fleet
dispatcher rather than running directly, so scheduled maintenance rides the same
governed pipeline as hand-driven runs.

Seed data lives in `schema/seed_program.sql`, generated by
`schema/seeds/generate_program_seed.py` (regenerate, don't hand-edit): 14
canonical initiatives with owner+SME contributions, epics/stories/bugs
carrying both estimates, sprints, grants, and maintenance bots with ~30 days of
run history. The middleware's no-Aurora fallbacks mirror it exactly.
⚠️ Initiative ids and *person* ids share the `p-` prefix — the 14 initiatives are
the slug-shaped ones (`p-auth-migration`, `p-rag-search`, `p-soc2`, …) while
people are `p-001`…`p-056`, so a bare `grep 'p-'` conflates them. Initiatives
are rows in `projects`, not a table named `initiatives`.
⚠️ Seeded bots are **parked** and no `queued` jobs are seeded — `initBotScheduler`
registers every enabled cron bot at boot and the dispatcher claims queued jobs
as soon as a box is idle, so either would fire against repos that don't exist
yet. Provision the repo, then un-pause the bot. ⚠️ The retired `seed_work_items*.sql` /
`schema/seeds/work_items_*.sql` family targeted a `proj-*` project family that
no seed ever created — those files are gone; don't resurrect those ids.

🔒 **Every GitHub repo generated for an initiative MUST be created private, and
"private" is the default to assert, not a preference to ask about.** Fourteen
`orgiq-*` repos (`orgiq-auth-service`, `orgiq-rag-search`, `orgiq-zero-trust`,
`orgiq-llm-platform`, `orgiq-finops`, `orgiq-compliance`, `orgiq-data-lake`,
`orgiq-feature-store`, `orgiq-stream-analytics`, `orgiq-inference-platform`,
`orgiq-observability`, `orgiq-mobile-app`, `orgiq-design-system`,
`orgiq-design-system-api`) were provisioned **public** in
`github.com/connorhoehnslalom` and stayed that way until 2026-09-29, when they
were flipped private. Nothing in this repo creates them, which is exactly why the
default went unchecked: the provisioning lives outside the tree, so no code
review here ever saw a visibility flag. These repos are the targets cron
maintenance bots and dispatched work items push commits to, so a public one
publishes generated code, branch names and commit messages describing internal
initiatives. Visibility is also not fully reversible — anything public may
already be cached, forked or indexed. Check with
`gh repo list <owner> --visibility public` after provisioning rather than
trusting the creating call's default, and pass `--private` (or `private: true`)
explicitly.

## The docs map

Long-form design lives in `docs/`. Several features follow a **goal-doc +
validator** pattern: `docs/<feature>-goal.md` states the definition of done and
`scripts/validate-<feature>.sh` is the only judge — it exits 0 only when every
mechanical check passes, and prints every failing line so one run shows the
whole backlog. Most take `--quick` to skip the slow suites (jest, vite build).

| Doc | What it is | Judge |
|-----|------------|-------|
| `program-operating-model.md` | How work, people, money and agents relate. Read before touching initiatives, budgets or the work queue. | — |
| `assessment-tenant.md`, `assessment-parity.md`, `assessment-goal.md` | The second tenant's contract, its parity with the source app, and its goal | `validate-assessment-tenant.sh` |
| `mock-floor.md`, `mock-floor-goal.md` | The `dev:mock` fixture contract | `validate-mock-floor.sh` |
| `orgiq-audit.md`, `orgiq-audit-goal.md` | Surface-by-surface audit of the org tenant as the real seed users | `validate-orgiq-audit.sh` |
| `journeys.md` | Journey logs (`docs/*-journeys/`): a log is stale when a walked route's **rendered contract** changed (the cascade/type-scale/rail measurements `scripts/journeys/measure.sh` records over `portal/e2e/route-inventory.ts`, the route's gate, the assertions of the specs that cover it) — not when a source file was touched; only `scripts/journeys/seal.sh <dir>` seals, after a walk. One implementation (`scripts/lib/journeys.sh`) for every judge below that holds logs | the tenant/goal validators' freshness sections |
| `branding.md`, `branding-goal.md` | The token/colour system the portal paints from | `validate-branding.sh` |
| `distillation.md`, `distillation-goal.md` | `/iq/distillation` — the fleet's shared memory | `validate-distillation.sh` |
| `layout-cascade.md` | Page frame contract: at most two rails, the trail as the content column's first row, title under it at the 24px gutter, lists as panes inside the content (`SectionContent`), landings never placeholders. Route inventory + sweep in `portal/e2e/layout-{inventory,cascade}.*` | `validate-rail-parity.sh` |
| `route-test-coverage.md` | Route ↔ test parity across every router | `validate-route-coverage.sh` |
| `research-honesty-checks-2026-09-16.md` | The four "numbers that lie" bug classes, the class-4 triage rule (rates vs latencies), and each scanner's false-positive story | `validate-honest-numbers.sh` |
| `nav-server-tier-decisions.md` | Nav ↔ route parity: the rail, the palette and `App.tsx` must gate every page the same way, every palette jump must resolve, and a nav item must not be gated narrower than the API it reads (that last one is ratcheted — the doc is where those get decided) | `validate-nav-parity.sh` |
| `ui-components-queue.md` | Composites the library is missing — and, since it is the ledger the component-discipline gate reads, the ONLY thing that exempts a file from it. A row must say "Composed locally in `<file>`" to mint an exemption. | `validate-component-discipline.sh` |
| `social-tenant-design.md`, `social-tenant-goal.md`, `pipelines-tenant-goal.md` | The third and fourth tenants (`social`, `pipelines`) and the header activity bell: the design (decisions E1–E5 taken from the user's direction, the bell fed by the gateway's `notifications()` feature, the work in judged lanes) and the two goals it names | `validate-social-tenant.sh`, `validate-pipelines-tenant.sh` |
| `communication-plane-goal.md` | The Communication plane (`/<tenant>/communication`): the Social workspace seen from orgiq / assessment / pipelines — Active now, the user's initiative/team/pipeline groups, org teams, shared work — under re-gated Social authority; journey logs in `docs/communication-journeys/` sealed per directory by `scripts/journeys/seal-communication.sh` | `validate-communication-plane.sh` |
| `agent-eval-goal.md` | Per-agent golden sets (`agents/tests/golden/*.json`) + `agents/tests/golden_runner.py` — a `--mode structural` offline regression suite the validator runs, and a `--mode live` operator workflow (real Bedrock $, needs a deployed runtime or `agentcore dev`) it deliberately does not | `validate-agent-eval.sh` |
| `agentcore-preview-surface.md` | Verified preview-API research + the machine-callback operator runbook (§6a) | — |
| `agentcore-preview-plan.md` | The sequenced work plan against that research | — |
| `bots-and-work-marketplace.md` | Bots, the work marketplace, authorize → review → gate | — |
| `asset-library-and-promotion.md` | How fleet instructions are stored, typed, gated and shipped | — |
| `sdlc-capture-delivery-model.md` | Commit-per-capture: how a run's change is scoped to its own work | — |
| `local-compute-presence.md` | A developer's machine as a fleet participant | — |
| `devbox-interactive-terminal.md`, `handoff-computer-lab.md` | Devbox terminals and the environments domain | — |
| `deploy-via-operator.md`, `researcher-pipeline-crd.md` | Kubernetes deployment via `dc-k8s-operator` CRDs | — |


⚠️ This table is not the whole set — one further goal-doc/validator pair records
the removal of a retired tenant, and it deliberately asserts that the removed
tenant's name appears **nowhere** in `CLAUDE.md`, so it cannot be listed here by
name without failing its own check. `ls docs/*-goal.md scripts/validate-*.sh`
(18 validators) is always the authoritative list — `validate-communication-plane.sh` joined on 2026-10-07.

---

# Gotchas

## Deploying and tearing down

- **Agent runtimes are a genuine second phase — the images must exist first.** `OrgIQ-AgentCoreRuntime` creates the agent ECR repos *and* the runtimes that pin images from them, so a rebuild has a chicken-and-egg: deploy it with runtimes on and every `CfnRuntime` fails with an invalid-image error against the empty repo it just created. `cdk.json` used to set `"deployRuntimes": "true"`, which made that failure the guaranteed outcome of the first deploy after any teardown. The default is now unset, restoring the documented order: deploy the stack (repos + execution roles), run `agents/base/build.sh` then `agents/build-all.sh` (local `docker buildx`, ARM64 — **not** CodeBuild), then redeploy with `--context deployRuntimes=true`. `--context onlyAgents=a,b` restricts phase 2 to the images that actually exist. Note the eight agent repos *and* the shared base repo *and* the devbox repo are all `RemovalPolicy.DESTROY` with `emptyOnDelete`, so a teardown takes their images with them; only `orgiq-middleware` is RETAIN (so a failed-stack delete doesn't destroy the image, and `deploy.sh`'s orphan sweep adopts it next time).
- **AgentCore runtimes delete slower than CloudFormation will wait.** `AWS::BedrockAgentCore::Runtime` regularly exceeds the resource handler's timeout, failing with `NotStabilized` ("Request timed out while deleting") and dropping the stack into `DELETE_FAILED` — which aborts `cdk destroy --all` partway through the fleet. The runtime finishes deleting server-side anyway; only CFN gave up. `destroy.sh` pre-drains runtimes (endpoints first — the API rejects a runtime delete with `ConflictException` while any endpoint remains, and `DEFAULT` can't be deleted separately) before `cdk destroy`. Both calls also reject while a delete is already in flight, so "already deleting" is success. If a stack still lands in `DELETE_FAILED`, retry `delete-stack --retain-resources <failed logical ids>` — and note the retain list must **exclude the stack's own name**, which appears as the `LogicalResourceId` of the stack-level `DELETE_FAILED` event; passing it makes CFN reject the whole call.
- **The deploy/teardown scripts self-heal the Aurora Data-API cold-start race and the custodian.** A cluster of fixes so a rebuild after teardown stops wedging: (1) `destroy.sh` no longer CFN-pre-deletes `OrgIQ-Aurora` — downstream stacks still import `orgiq-aurora-cluster-arn`, so the delete cancelled with "Cannot delete export … in use" and `wait` polled to its ~60-min ceiling; it now only pre-drains the RDS *cluster* and lets `cdk destroy --all` tear the stack in dependency order, then runs a read-only billing sweep (Aurora, OpenSearch Serverless, AgentCore runtimes/memories/browsers/code-interpreters, S3) that records survivors and exits non-zero. (2) `schema/load_schema.py` retries `HttpEndpointNotEnabledException` and sibling resume/scale transients (6×3s, warm-up `SELECT 1` first) — the first Data API call to a cold 0.5-ACU cluster fails until the endpoint enables — and fails loud on genuine SQL errors (non-transient re-raise immediately). (3) The KB stack gates its `DbInit` chain on a `DataApiReady` custom resource (boto3 Lambda polling `SELECT 1` ~9 min, cold-cluster transients only). (4) `OrgIQ-Foundation` sets **both** S3 buckets to `RemovalPolicy.DESTROY` with a *self-role* emptier Lambda (identity-based IAM, paginates object *versions* + delete markers) rather than CDK's stock `autoDeleteObjects` — the stock provider gets its perms via a bucket resource policy the custodian strips, wedging teardown in DELETE_FAILED (other Foundation resources still RETAIN). (5) `deploy.sh` reconciles every expected stack's real CFN status after `cdk deploy --all` (a mid-fleet failure doesn't reliably exit non-zero) and exits 1 on any not `*_COMPLETE` — and treats `ROLLBACK_COMPLETE`/`UPDATE_ROLLBACK_COMPLETE` as the failures they are despite the `_COMPLETE` suffix — and single-shot auto-recovers the KB `CREATE_FAILED` Data-API race (delete the failed KB stack, redeploy once, bounded by `KB_RETRIED`).
- **This account silently closes open security groups.** `custodian-restrict-security-group-admin-ingress` revokes `0.0.0.0/0` ingress within seconds — CFN authorized the middleware ALB rule at 14:20:22 and custodian removed it at 14:20:28, with no stack event and no drift. The task was running and the target group healthy while the load balancer accepted no traffic. `OrgIQ-MiddlewareService` therefore sets `openListener: false`; pass `--context albAllowCidr=<ip>/32[,<cidr>...]` to reach it, and synth warns when you don't. When something here is deployed, healthy and unreachable, read the live SG's `IpPermissions` first. ⚠️ `deployPortal=true` admits CloudFront through the managed prefix list `com.amazonaws.global.cloudfront.origin-facing` on its own SG (never a CIDR); whether custodian tolerates a prefix-list rule is **unverified** — check it survives 60 s after the first deploy (`docs/social-calls-deploy-plan.md` §10). Because that list is every CloudFront customer, the same flag turns the ALB's default action into a 403 and forwards only requests carrying the portal's secret origin header or coming from `albAllowCidr`.
- **The middleware task runs on ARM64.** Fargate defaults to x86_64; the image is built on Apple Silicon, so the default produced tasks that failed with `exec format error` in the entrypoint and were replaced in a loop while the stack sat in UPDATE_IN_PROGRESS. `MiddlewareServiceStack` pins `runtimePlatform` to ARM64 (also the cheaper option). The stack owns its ECR repo *and* pulls from it, so it deploys in two phases: the first lands the repo with the service scaled to 0 (the L2 pattern rejects `desiredCount: 0`, so it is forced on the underlying `CfnService`), then `--context deployMiddlewareService=true` scales it up.
- **`OrgIQ-MiddlewareService` reaches `CREATE_COMPLETE` with an empty ECR repo and zero running tasks.** The stack owns its repo *and* pulls from it, so on a fresh account or after a teardown the service is created against a repo with no images: CFN reports success, `describe-stacks` says `CREATE_COMPLETE`, and the service sits at `desiredCount 1 / runningCount 0` retrying forever with `CannotPullContainerError: ... orgiq-middleware:latest: not found`. Nothing in the stack status says so, which is why "all 18 stacks healthy" is not the same claim as "the middleware is serving" — check `aws ecs describe-services --cluster orgiq-middleware --services orgiq-middleware --query 'services[0].[desiredCount,runningCount]'`, or `aws ecr list-images --repository-name orgiq-middleware --query 'length(imageIds)'`. The repo being `RETAIN` protects an image that exists; it does not create one. Note the consequence for the machine-callback guards: they flip to *required* the moment this stack deploys, so with no task running the deployed fleet's callbacks have no endpoint at all — a local `npm run dev` middleware (secrets unset → guards open) is the only listener. Build and push the middleware image, then redeploy with `--context deployMiddlewareService=true` to scale it up.
- **The KnowledgeBase stack's exports are imported by four stacks** (Agents, AgentCoreGateway, Observability, AgentCoreRuntime), so once consumers exist the KB id export can be neither deleted nor changed. ⚠️ Precision the CDK tests added: only `OrgIQ-MiddlewareService` imports `orgiq-knowledge-base-id` by that **stable name** (and `OrgIQ-AgentCoreRuntime` once runtimes deploy); Agents, Gateway and Observability consume the KB through CDK's auto-generated hash exports. The freeze is real either way, but it is spread across several export names rather than concentrated in the one you would grep for — `infra/test/cross-stack.test.ts` therefore asserts that at least three stacks import *some* KB export, which is the honest form of the claim. The consequence is unchanged — a knowledge base deleted out-of-band (e.g. by `destroy.sh`'s KB pre-drain) cannot be replaced via CFN without a multi-stack teardown. Recovery without that: recreate the KB + S3 data source via the Bedrock API with the same config (Aurora `bedrock_kb` table, Titan v2 @1024d, `orgiq-kb-service-role`), point the fleet at it with `cdk deploy OrgIQ-AgentCoreRuntime --context kbId=<new-id>`, refresh `KNOWLEDGE_BASE_ID` in `.env.aws` and the `knowledge_bases` registry row, then run an ingestion job. The stale export stays as known drift until the KB stack is rebuilt cleanly.
- **`middleware/.env.aws` rots on every rebuild, silently.** Capability ids are minted fresh when `OrgIQ-AgentCoreCapabilities` is recreated, and the file is not regenerated — so `BROWSER_ID`, `BROWSER_PROFILE_ID`, `CODE_INTERPRETER_ID` and `MEMORY_ID` keep pointing at resources that no longer exist. The failures are unhelpful: the Code Interpreter says "not found", the browser says "Browser profile not found" and surfaces as a bare 500, and `site-survey`'s browser fallback fails *soft* — a dead `BROWSER_ID` is indistinguishable from "this site has no JavaScript-only pages". Reconcile with `aws bedrock-agentcore-control list-browsers | list-browser-profiles | list-code-interpreters | list-memories`, or regenerate the file with `./schema/dump-stack-outputs.sh`. Note `config.ts` only fills vars that are `undefined`, so anything exported in the launching shell shadows the file.
- Aurora Serverless v2 has a 0.5-ACU minimum that bills even when idle (~$45/mo). The cluster also takes 10–20s to scale up from a cold call. `./scripts/destroy.sh` pre-drains it before stack teardown.
- OpenSearch Serverless has 2 OCU minimum billing even when idle. Budget alarm is critical.

## Agent runtimes and images

- **Agent images must install `aws-opentelemetry-distro` (ADOT), not vanilla `opentelemetry-distro`.** AgentCore Runtime injects `OTEL_PYTHON_CONFIGURATOR=aws_configurator`, which only exists in the ADOT package — with the vanilla distro no configurator loads and *no spans are ever exported* (`aws/spans` stays silently empty, which starves the span projector, `/recent-invocations`, and online evaluation). Runtime env also sets `OTEL_TRACES_EXPORTER=otlp` + `AGENT_OBSERVABILITY_ENABLED=true`; account-level X-Ray Transaction Search (`aws xray get-trace-segment-destination` → CloudWatchLogs/ACTIVE) must be on.
- **The devbox fleet is persisted, and the write path is order-sensitive.** The registry in `middleware/src/lib/devbox-fleet.ts` is still two in-memory Maps — synchronous, read on every request — but it is now mirrored to Aurora (`devbox_boxes`, `schema/devbox_fleet_schema.sql`) through a `FleetStore` seam, hydrated at boot by `providers/devbox-fleet-store.ts`. It exists because a restart used to drop every box while the AgentCore sessions kept running, and `devbox-reaper` reaps only what `listBoxes()` returns — so a forgotten session sat outside BOTH the 20-minute idle timeout and the 60-minute ceiling, permanently, with no way to find it again (no AgentCore API enumerates live *runtime* sessions; `list-sessions` is Memory). Under `tsx watch` that happened on every file save. Three things bite here, each found by running it rather than reading it: (1) the RDS Data API returns `TIMESTAMPTZ` as a NAIVE string, and `new Date()` reads that shape as LOCAL time — a box came back 4h in the future, making `age` negative so the ceiling never fired; `lib/devbox-fleet-rows.ts::utcIso` is the fix and the reason that mapping is a separate, tested module. (2) Writes are fire-and-forget (the mutators can't await Aurora), so they are serialized per box id — without that, `DELETE`'s `markStopped`-then-`removeBox` reordered and the row came back from the dead. (3) `touch` coalesces on a 15s flush, so a structural write must drop any queued touch first or a stale snapshot replays over it — that is how the reaper's own stop got undone. Boxes marked `stopped` are pruned at boot rather than restored, so the fleet does not fill with corpses. Everything degrades to the old in-memory behaviour when Aurora is mocked, unconfigured, or missing the table.
- **Session storage (`/mnt/workspace`, preview) is wiped on every runtime version update.** The runtime stacks digest-pin container URIs so CFN rolls the runtime on every image push — meaning every `build-all.sh`/devbox image push + deploy wipes all session workspaces for that agent. Treat `/mnt/workspace` as a cache, never a durable store; push work out via git or the command API. Also resets after 14 days idle. Limits: 1 GB/session, session IDs must be ≥33 chars.
- **Devbox model exception**: the `orgiq-devbox` runtime runs Claude Code, which requires Claude models — via Bedrock inference profiles (`us.anthropic.claude-*` IDs, currently haiku-4.5; bare foundation-model ids don't support on-demand invocation), so still AWS-hosted/AWS-billed, no Anthropic API key anywhere. This is a deliberate, devbox-only exception to the "AWS-native models only" convention; the 8 OrgIQ agents stay on Nova.
- **Agent system prompts are resolved from Bedrock Prompt Management at run time.** Each agent reads `orgiq-<agent>-system-prompt` (DRAFT) via `agents/_shared/prompt_source.py` on every invocation, cached `PROMPT_REFRESH_S` (60s), and rebuilds its Strands `Agent` when the text changes — so a Prompt Studio edit reaches the deployed fleet in ~a minute with **no image rebuild and no redeploy**. The `SYSTEM_PROMPT` literal in `agents/*/main.py` is a fallback used only when the library is unreachable (missing prompt, AccessDenied, throttle) so a Bedrock outage can't take the fleet down; `PROMPT_SOURCE_DISABLED=1` pins an agent to it. Traces record the *resolved* prompt sha as `promptVersion`, so observability shows which prompt actually served a request. ⚠️ The `bedrock:GetPrompt`/`ListPrompts` grant must be on the **runtime execution role** (`orgiq-<agent>-execution-role`, created by `OrgIQ-AgentCoreRuntime`) — the `OrgIQ-Agents` `orgiq-<agent>-role` is a different principal and granting it there has no run-time effect. `ListPrompts` must be paginated: the un-paginated call returns only the first page and silently misses prompts.
- AgentCore Runtime is deployed via CDK `CfnRuntime` gated on `--context deployRuntimes=true`. Do NOT use the standalone `agentcore deploy` CLI for cloud deploys; it'll drift from the CDK source of truth. (`agentcore dev` is still the right tool for local hot-reload; it runs on host arch, unlike the ARM64 deploy images.) For the record of what you are giving up: `agentcore deploy` builds via remote CodeBuild and needs no local Docker at all — that convenience is the price of keeping CDK as the single source of truth, and it is why the documented build path is a local ARM64 `buildx`.

## Observability

- **A2A topology edges require the supervisor's streaming path to set its TraceContext.** `_handle_streaming` (what the portal uses) originally never called `_current_ctx.set(...)`, so `_invoke_sub_agent` threaded no `parentInvocationId`, every sub-agent trace persisted with `parent_invocation_id NULL`, and `/api/topology/a2a` could never return an edge for real user traffic. Both handlers now establish the context and emit a root trace.
- **Trace sampling gates persistence.** `observability.sampling_config.rate` is applied in `trace-sink.processTrace` *before* the insert — at the old 0.1 a low-traffic lab wrote ~1 row in 10 while `[cw-ingest]` logged "persisted N" for every parsed bundle, so observability pages looked broken with no signal why. The seeded `default` row is now 1.0 and an unlisted template id falls back to it. ⚠️ There is a second, quieter default: `FALLBACK_RATE = 0.1` in `trace-sink.ts` applies when the sampling cache is empty — an Aurora that never had `observability_schema.sql` applied, or a first config read that failed — so the 10% behaviour can still reappear on a half-provisioned cluster. The poller reports persisted / sampled-out / duplicate separately. Traces reach Aurora via the CloudWatch log poller (30s) parsing `ORGIQ_TRACE:` lines — agents cannot POST to a laptop middleware.
- Span projection runs on a 1-minute schedule (Lambda) — span data in the Aurora `observability_*` tables can lag CloudWatch. ⚠️ `OBS_USE_LEGACY_POLLER` (`lib/cw-trace-ingest.ts`) defaults to **`'true'`**, i.e. the middleware polls CloudWatch directly *unless* you turn it off — the reverse of how this used to read here.
- **Error rate ≠ answer quality, and phantom rows are dropped at the sink.** Two related observability fixes: (1) `errorRate` counts only *real failures* — a guardrail intervention (`guardrail_action` present and not `'NONE'`) or non-conforming output (`schema_valid = false`) — not `judge_score < 0.3`. A weak answer to a request that otherwise succeeded is surfaced separately as `lowQualityRate` (judge<0.3); folding it into errors made a healthy fleet giving mediocre answers alarm as erroring. `invocation_traces` has no dedicated error column, so these are the honest stand-ins, matching the canary rollup view. ⚠️ Only `routes/traffic.ts` (`/per-agent-summary`) reports both: `routes/oncall.ts` (`/timeline`) shares the error predicate but has **no** `lowQualityRate` field — its judge threshold lives in the separate judge-regression alarm. (2) `trace-sink.processTrace` drops a **phantom** row — partial/aborted bundles or pre-agent middleware writes — only when *every* substance axis is empty (no model AND empty response AND no tokens AND no tool calls AND no guardrail signal AND no memory events), `test:*` exempt, before any Bedrock spend, so a real short answer is never dropped. The poller counts these in a distinct `phantom-skipped` bucket instead of miscounting them as duplicates.
- **Prompt canary** is deployed via `OrgIQ-PromptCanary` (subject A/B + judge managed prompts, SSM weight/control params, SFN controller); `deployCanary` is `"true"` in `cdk.json`, so it deploys by default. The LLM-as-judge config (enable, model, rubric weights, sample rate) lives in SSM `/orgiq/canary/judge_config` and is edited from `/iq/evaluations`. That parameter is owned by `middleware/src/lib/judge-config.ts` — **not** the canary stack (which owns `/orgiq/canary/{weight_b,control,config}`) and not `lib/canary-judge.ts`, which merely calls `getJudgeConfig()` on every canary ask and otherwise talks to Bedrock. Online evaluation needs `--context enableOnlineEvalConfig=true` on top of `enableEval` (already default-true in `cdk.json`); the config resource requires `ServiceNames` + `ExecutionStatus: ENABLED` and an exec role that can create its results log group.
- **The KB registry is bookkeeping, and drifts.** `/admin/knowledge` reconciles `knowledge_bases` rows against live Bedrock (`middleware/src/providers/kb-reconcile.ts`) and names each disagreement; a seeded row claimed a knowledge base id that never existed while the real one went unregistered. Adoption repoints a broken row and captures its data source id — repointing `bedrock_kb_id` alone leaves a row that still rejects every sync. The corpus load now repoints the row itself (`schema/synth/load.py::reconcile_kb_registry`, called from `trigger_kb_sync`) because that step is the one thing already holding both live ids, so the link repairs itself after a KB rebuild instead of waiting for a hand-driven adoption. ⚠️ `resolve_kb_id` filters on `status = 'ACTIVE'`, so a row left at the seeded `PENDING` makes every agent fall through to the `KB_ID` env var — which usually *works*, and therefore hides the drift rather than surfacing it.

## The knowledge base

- **Bedrock's DEFAULT search type ranks this store's results BACKWARDS.** Against the Aurora/pgvector vector store, `bedrock-agent-runtime:Retrieve` with no `overrideSearchType` returns the correct k nearest neighbours **in exactly reverse relevance order**, reporting cosine *distance* in a field named `score` that every caller reads as "higher is better". Measured against ground truth (`ORDER BY embedding <=> query` on `bedrock_kb`, the same table Bedrock reads) over 8 representative queries: **top-1 correct 0/8 on the default, 8/8 on `HYBRID`**. "Why did we choose Aurora over Neptune?" put `adr-d-iceberg.md` first (distance 0.831) and the actual `adr-d-aurora.md` *last* (0.492, the nearest chunk). This is why the KB read as a **false flag** rather than an outage — real org documents came back, so nothing looked broken, while the model was handed the least relevant evidence and the right answer fell off the end. Two things compound it: nothing in the agents sorts by `score` (results reach the model in Bedrock's order), and `middleware/src/lib/turn-tool-calls.ts` trims oversized result lists **from the tail**, discarding the most relevant document first. All three production call sites — `agents/search/main.py` `query_knowledge_base`, `agents/advisor/main.py` `retrieve_context`, and `infra/lambda/gateway-tools/kb_query.py` — now pin the search type; the agents share `agents/_shared/kb_resolver.py::vector_search_config()`, and the gateway Lambda carries a deliberate literal copy because it ships on its own. The four notebook `retrieve` sites are pinned too (`notebooks/aws/04-knowledge-base.ipynb` ×3, `06-strands-agent.ipynb` ×1) — they are how a human forms their first impression of whether retrieval works, and two of them are the rerank *demo*, whose whole point is a before/after ordering: on the default search type the "before" column is reverse-ranked, so the demo measures the missing search type rather than the rerank model and makes it look far better than it is. `KB_SEARCH_TYPE=SEMANTIC` reproduces the inversion for diagnosis. `HYBRID` is supported here, not a workaround: it needs the GIN full-text index the KB stack creates as `bedrock_kb_text_idx` (`DbInitTextIndex`), and it is the better mode for this corpus anyway since the queries carry exact proper nouns ("Neptune", "Kubernetes", "SOC2"). ⚠️ That index is a real dependency, not a detail: `04-knowledge-base.ipynb`'s hand-driven table setup created only the HNSW index, so a table built from the notebook rather than the CDK stack would fail every HYBRID retrieve while looking complete — the cell now creates `bedrock_kb_text_idx` as well, and the two must stay in step. Regression tests: `agents/_shared/test_kb_resolver.py::SearchType` (the helper) and `agents/tests/test_kb_retrieve_config.py` (both shipped tools) — they assert the key's *presence*, because the bug was an omission.
- **A corpus run reported success against an empty knowledge base.** `schema/synth/load.py::sync_knowledge_base` needs BOTH `KnowledgeBaseId` and `DataSourceId` from `OrgIQ-KnowledgeBase`'s outputs and skips ingestion when either is missing — one warning, **exit 0**. Only `KnowledgeBaseId` was ever published, so the skip was unconditional and no ingestion job had ever run in this account. The stack now also outputs `DataSourceId` (no `exportName` on purpose — the consumer reads `describe-stacks`, and a CFN export can't be changed once imported). If the KB looks empty, check for an ingestion job before suspecting retrieval.
- **`staged/` outlives the code that wrote it.** `schema/synth/staged/` is gitignored scratch, so a retired tenant's 46 `news_article` JSONs stayed on disk after its generator was deleted, and `load_staged()` globbed the directory blind — re-uploading them to S3, re-upserting them into `documents` and re-indexing them into the KB on every run. They carried **0 mentions** (linked to no person, team or project) and still outranked the authoritative ADRs. `load_staged()` now filters on `generate.DOC_TYPES` and logs what it skipped, so an orphaned artifact stays inert: no generator, no load. Adding a doc type means adding a planner AND a name to that tuple.
- **`documents.doc_type`/`headline`/`published_at`/`section` are ADD COLUMN in `orgiq_schema.sql`, on purpose.** A retired tenant's schema file originally added them, and deleting that file took the only definition with it — so a cluster built from `orgiq_schema.sql` alone had none of them and the corpus load died on `column "doc_type" does not exist`, while a cluster built before the removal had all four. They are defined in `orgiq_schema.sql` now precisely so both converge; `generate.py` populates all four for live doc types, so they are live columns, not residue of the retired tenant.

## Identity, authz and tenancy

- **Identity & tenancy are real, not cosmetic.** Users/tenants/grants live in Aurora (`schema/identity_schema.sql`: `tenants`, `app_users`, `user_tenant_roles`) with an in-memory fallback mirroring the seed when Aurora is unconfigured. The signed session cookie carries `grants` (tenant→roles) and `act` (real identity while masquerading); every role/tenant switch is validated against grants in `middleware/src/routes/session.ts` — no grant in the target tenant → 403. Cedar policies live per tenant in `middleware/seeds/roles/{tenant}/{role}.cedar` (orgiq: `member`, `sme`, `program-owner`, `org-leader`, `hr-admin`; assessment: `assessor`, `lead-assessor`, `program-lead`; social: `participant`, `moderator`, `community-admin`; pipelines: `author`, `operator`, `pipeline-admin`) plus cross-tenant `admin.cedar`, the only role granted `Masquerade`, and condition on `principal.tenant`; the AVP decision cache key is `tenant|role|action`. `requireTenant()` guards the assessment, social and pipelines tenants' routes and graph/scores (orgiq). Supervisor caches one Agent per `(tenant, role)`; admin rides hr-admin's guardrail. Provision users/tenants from `/admin/identity/users` (gated `ManageUsers`), including linking a user to an org-graph person after creation via `PUT /api/identity/users/:id/person` (`null` clears) — previously `personId` was settable only at creation, dead-ending the "link it from Identity → Users" remediation. ⚠️ authz open-mode (no `POLICY_STORE_ID`) DENYs when `NODE_ENV=production`; cookie-less requests still get the permissive `demo-user` identity in dev — but only while `demoFallbackAllowed()` holds, which is false whenever Cognito is fully configured even in dev. "Permissive" there means permissive *grants*, not a blanket ALLOW: the demo session still carries `DEFAULT_ROLE` and still faces Cedar.
- **New Cedar actions must ALSO be listed in `CAPABILITY_ACTIONS` (`middleware/src/lib/authz.ts`).** `GET /api/session/capabilities` evaluates only that list, so an action that is gated server-side but missing there reads `undefined` in the portal's `can()` — every control behind it hides for every role, including roles Cedar permits. This is how all eight assessment-tenant actions shipped invisible. Same list feeds the masquerade menu. (One action is probed with attributes rather than bare: `ApproveTransaction` goes in with `{ amount: 20000 }` so the amount-conditioned policies decide honestly.)
- **Open-mode authz (no `POLICY_STORE_ID`) treats the admin wildcard as every action.** `admin.cedar` is an unconstrained permit; the role registry records it as `['*']`, and until 2026-09 the seed-matrix decision did a plain `has(action)`, denying admin on every plain `requireAction` gate while the read gates that special-case `role === 'admin'` let it through. Fixed in `seedPolicyDecision`; regression test in `lib/__tests__/authz-open-mode.test.ts`. If a new gate 403s admin locally, suspect the gate, not the wildcard.
- **A tenant/role switch invalidates the pre-switch cookie within ≤120s — `session_epoch`.** The session is a stateless signed cookie (`orgiq.session`, HMAC-SHA256, no server store), so re-minting on switch (`mintSession`/`issue` in `routes/session.ts` `POST /tenant`/`/role`) scopes the *new* cookie but can't retroactively kill copies already minted — other tabs/devices, or a stolen cookie. `session_epoch` (INTEGER on `app_users`, `schema/identity_schema.sql`, embedded in the cookie) closes that window: every tenant/role switch and `POST /api/session/revoke-others` calls `bumpSessionEpoch` (`providers/identity.ts`), and the periodic grants-refresh in `sessionMiddleware` (`lib/session.ts`, every `GRANTS_REFRESH_S`, default **120s**, compared in seconds) drops any cookie whose `epoch` is below the stored one — shrinking the stateless replay window to ≤120s. Masquerade deliberately does *not* bump (carries the target's epoch) and `revoke-others` 409s while masquerading; a cookie minted before the column existed carries epoch 0 and matches a never-bumped user. Client side: the switch/logout **hard-navigates** (tearing down in-memory React state) AND `clearTenantScopedCaches()` (`portal/src/lib/tenantCaches.ts`, wired into `auth.tsx` `enterContext`/`login`/`logout`) removes tenant/user-scoped localStorage — judge-config, devbox fleet+session, terminal dock, masquerade history, `chat.session.*`, and the sessionStorage context marker — while **preserving** device prefs (theme, `projects-view`, `sprints-view`). The bytes would otherwise survive at rest on a shared browser even though `requireTenant` won't render the other tenant.
- **Second tenant: `assessment`** (roles `assessor` / `lead-assessor` / `program-lead`; seeds in `middleware/seeds/roles/assessment/`; routes `/api/assessment/*` behind `requireTenant('assessment')`; portal `/assessment/*` with its OWN shell-rail hierarchy — Assess / Analyze / Informatics / System — against orgiq's Plan / Design / Build / Release / Operate / Org / System). Both hierarchies are declared in `GROUP_ORDER_BY_TENANT` in `portal/src/components/shell/portalCommands.ts`; `Layout.tsx` only consumes the derived `groupRank`, and an unlisted group sorts last. Design contract and the source-app reverse-engineering live in `docs/assessment-tenant.md`. Agents `orgiq-assessment-scorer` / `-drafter` never persist scores; the provider's deterministic `applyScores` validates and applies their envelope. (There were briefly three; the removed one's record is the unnamed goal-doc/validator pair noted under The docs map, and `middleware/src/lib/session.ts` `TENANTS` is the authority on how many there are now — four since 2026-09-29.)
- **Third and fourth tenants: `social` and `pipelines`** (design `docs/social-tenant-design.md` §4–§5; judges `validate-social-tenant.sh`, `validate-pipelines-tenant.sh`). `social`: roles `participant` / `moderator` / `community-admin`, actions `ViewSocial` `PostMessage` `StartCall` `ManageChannels` `ManageTeams` `ManageRecordings` `ManageSocialConfig`, cast `u-mira` / `u-lena` / `u-sana`, routes `/api/social/*` behind `requireTenant('social')` at the mount, portal `/social/*` (Talk / Meet / People / Library / System, front door `/social/channels`). `pipelines`: roles `author` / `operator` / `pipeline-admin`, actions `ViewPipelines` `AuthorDefinition` `RunPipeline` `ApproveStep` `CancelRun` `ManagePipelineConfig`, cast `u-ines` / `u-kofi` / `u-dara`, routes `/api/pipelines/*` behind `requireTenant('pipelines')`, portal `/pipelines/*` (Catalog / Runs / Sources / System, front door `/pipelines/runs`). The curated orgiq cast and the assessment cast hold `participant` in social; each new tenant's own cast holds a grant only there. ⚠️ `permissiveGrants()` deliberately leaves both out, so the cookie-less demo identity holds no grant in either — the isolation walks need that session; a demo persona cannot enter them, sign in as a seeded user instead. Every page is an empty state at registration (`pages/social/socialSurfaces.ts`, `pages/pipelines/pipelinesSurfaces.ts` name the lane that fills each); `GET /summary` on each router counts members from grants and surfaces from the registered `social.surfaces` / `pipelines.surfaces` fixtures.
- **The auth floor: `requireSession` vs `requireAction`.** `requireAction('X')`/`readForRolesElseAction` gate a *capability*; `requireSession()` (`lib/authz.ts`) gates *authentication only* — its label arg is just an audit string. Some surfaces are readable by every role (the work queue, the agent fleet, session history, sprints), and "every role" means *signed-in*, not anonymous: mounting those with no guard let anonymous callers read them (transcripts included). They now take a `requireSession` floor. ⚠️ **Not every route on an observability/tooling router is human-facing.** `POST /api/observability/approvals/request` and `POST /api/observability/harness/trace` are **agent callbacks** — deployed runtimes POST to them with no session — so they carry an *optional service-auth* guard, never a session floor. A blanket session mount over those routers silently 401s the fleet's trace emission. Gate machine-callback routes per-route, not at the mount.
- **Service auth is one module with per-route specs.** `middleware/src/lib/service-auth.ts` owns the mechanism: a `Callback`-style spec per sessionless route, `requireServiceAuth(spec)` (open outside production when the secret env is unset; 503 in production when unset; constant-time `timingSafeEqual` header check when set), and `serviceAuthOr(...)` for routes that accept either a session or a secret — note `serviceAuthOr` is deliberately **not** open when unset. The guards you'll see at call sites (`requireTraceAuth` in `routes/harness.ts`, `requireRunCompleteAuth` in `routes/assessment.ts`) are route-local consts built from it, not exports of the module. The five specs: `APPROVALS_REQUEST_SECRET`/`x-approvals-auth`, `HARNESS_TRACE_SECRET`/`x-harness-auth`, `ASSESSMENT_RUN_COMPLETE_SECRET`/`x-assessment-run-auth`, plus `LAB_CALLBACK_SECRET` and `MOCK_CONTROL_SECRET`.
- **Closing the machine-callback guards is a coordinated two-stack deploy with a real blackout window, not a flip of one env var.** `OrgIQ-MiddlewareService` (`infra/lib/middleware-service-stack.ts`) mints `orgiq-approvals-request-secret` / `orgiq-harness-trace-secret` / `orgiq-assessment-run-complete-secret` in Secrets Manager and wires them as ECS container secrets — the moment that stack deploys, all three guards flip from open to required, with no staged "mint but stay open" mode. `AWS::BedrockAgentCore::Runtime` has no ECS-style `Secret.fromSecretsManager` equivalent (its `EnvironmentVariables` is a bare string map) and `AgentCoreRuntimeStack` is instantiated before `MiddlewareServiceStack` in `app.ts` with no dependency edge, so the runtime side takes the three values as plain `--context` strings the operator copies in by hand after reading them with `aws secretsmanager get-secret-value`. ✅ **The agent half has shipped** — `agents/_shared/callbacks.py` defines the three callbacks and both `instrumentation.py` (trace POST) and `approval_tool.py` (approval POST + poll) send the matching header, but **only when the secret env var is set**; unset sends byte-for-byte the old request. That makes the halves independent, so the required order is: roll the agent images first *with no secret context* (a behavioural no-op, and the slow step), then deploy the middleware, then read the secret values, then redeploy the runtimes with the three contexts. Skipping the image roll makes the window unbounded — a pre-`callbacks.py` image sends no header no matter what env it is handed. ⚠️ The header is not the only half: the agents POST to `MIDDLEWARE_URL` (default `http://middleware:3001`, the compose name), which no stack set until 2026-10-01, and a runtime's AWS egress addresses are not in `albAllowCidr` — so the reachable URL is the CloudFront portal origin (`deployPortal=true`), passed as `--context portalPublicUrl=https://<id>.cloudfront.net` on that same runtime redeploy. Full runbook, including what the window costs per callback, in `docs/agentcore-preview-surface.md` §6a.
- **platform-api's call-lobby admission asks the BFF, and turning it on is an ordered two-step rollout.** platform-api cannot know whether a caller may use a particular `orgiq:initiative:<id>`, `assessment:team:<id>`, `pipelines:run:<id>` or private `social:ch:<slug>`. With `LOBBY_AUTHORITY_REQUIRED=true` it therefore forwards the caller's realtime token to `POST /api/realtime/lobby-access` (`middleware/src/routes/realtime-lobby-access.ts`). That route gives the gateway's own fresh `join` admission, and platform-api admits the lobby only on 200 `{allowed:true}`; every failure refuses. Order: (1) deploy the middleware with the route; (2) only then set `LOBBY_AUTHORITY_URL`, plus the flag, on platform-api. In the cloud that is `--context lobbyAuthorityUrl=…` on `OrgIQ-Social`. The reverse order refuses every OrgIQ call until step 1 lands. The `social` compose profile has it on, while platform-api's own default is off. The record, including why this is a callback and not lobby grants in the token, is in `docs/social-calls-plan.md` "Lobby admission at platform-api" and platform-api's `docs/lobby-authority.md`.
- **Enterprise SSO is Cognito + a BFF OIDC flow** (`OrgIQ-Authentication` stack). Cognito is only the *authenticator*: `middleware/src/routes/auth.ts` drives authorization-code+PKCE (`lib/oidc.ts`), verifies the ID token against the Cognito JWKS (`aws-jwt-verify`), resolves the OrgIQ user by `app_users.external_sub` then email (linking on first login), and mints the **same** signed session cookie via `mintSession` — so grants/masquerade/Cedar are unchanged and the browser still holds only that cookie. Turns on when `COGNITO_USER_POOL_ID`/`COGNITO_CLIENT_ID`/`COGNITO_DOMAIN`/`COGNITO_CALLBACK_URL` are set (`config.cognito`); unset → the user picker is available only in demo mode. Both `POST /api/session/login` and `GET /api/session/users` return 403 in `NODE_ENV=production` unless `AUTH_DEMO_MODE=true`, whether or not SSO is configured. Portal shows "Sign in with SSO" (`auth.tsx` `signInWithSso`/`ssoEnabled` from `GET /api/auth/config`). **Deployed pool** (⚠️ minted fresh on every `OrgIQ-Authentication` rebuild — the id below was the latest as of 2026-09 and is the first thing to re-check, not to trust): `us-east-1_YAQjmVEw2`, client `5m0776daodsm1lmhrhvd8v71s5`, domain `orgiq-auth-647757222309.auth.us-east-1.amazoncognito.com`; seed users = the 20 `app_users` emails including the release-manager, SME, assessment, social and pipelines casts (the stack's `seedUsers` list is kept in step with `schema/identity_schema.sql`; the assessment cast was missing from it until 2026-09-29, so a pool deployed before then has only the first eleven), passwords set via `aws cognito-idp admin-set-user-password`. Regenerate `middleware/.env.aws` after any auth rebuild with `./schema/dump-stack-outputs.sh` (it fetches `COGNITO_CLIENT_SECRET` from the API — CFN never exports it — and sets `PORTAL_ORIGIN` so the BFF post-login redirect lands on the portal, not the middleware). ⚠️ Cognito rejects non-localhost **http** callbacks, so the deployed ECS middleware needs an HTTPS origin before `COGNITO_CALLBACK_URL` is set there (the stack leaves it unset until then; production picker access requires explicit `AUTH_DEMO_MODE=true`). Without a domain, `OrgIQ-Portal` (`deployPortal=true`) is that origin: register it with `--context portalPublicUrl=https://<id>.cloudfront.net` on `OrgIQ-Authentication`, then redeploy the middleware with `--context portalPublicUrls=true`, which reads `COGNITO_CALLBACK_URL`/`PUBLIC_BASE_URL`/`PORTAL_ORIGIN` from the portal stack's SSM parameters. Local run: `COGNITO_USER_POOL_ID=… COGNITO_CLIENT_ID=… COGNITO_CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client … --query UserPoolClient.ClientSecret --output text) COGNITO_DOMAIN=… COGNITO_CALLBACK_URL=http://localhost:3001/api/auth/callback npm run dev`, then open `/api/auth/login`. `GET /api/session/realtime-token` is the one place the BFF mints a JWT: a 10-minute HS256 token (`REALTIME_JWT_SECRET`, `tokenKind: 'orgiq-hs256'`, `lib/realtime-token.ts`) for the websocket-gateway/platform-api — it is **not** the Cognito id_token, which `routes/auth.ts` still discards after verifying; see `docs/social-calls-plan.md` step 3.

- **The agents' read-only SQL guard is a security boundary, and the regex version had a hole.** `search` and `advisor` expose `query_graph(sql)`: the **model** writes the SQL and the agent runs it verbatim through the RDS Data API, against a role that can write. Both used to check `^\s*(WITH|SELECT)\b` plus "no semicolon" — which `WITH gone AS (DELETE FROM people RETURNING *) SELECT * FROM gone` satisfies, and PostgreSQL executes the DELETE. `SELECT * INTO evil FROM people` is the same story. Since these agents read ingested documents, that regex was the whole distance between a prompt injection in a document and the org graph. It is now `agents/_shared/sql_guard.py`, which blanks comments and quoted runs *before* matching (so a keyword in a comment cannot smuggle, and `WHERE title = 'Update Manager'` cannot false-positive), rejects an unterminated quote outright, requires a single statement, and scans for write verbs **anywhere** rather than only at the front. A 21-case attack table runs against the shipped tool of both agents and asserts `execute_statement` was never reached, alongside 7 legitimate queries that must still pass — a guard that breaks the read path is just a broken tool. ✅ **The braces have now shipped**: `schema/graph_readonly_role.sql` creates `orgiq_graph_reader` — `CONNECT`, `USAGE` on `public`, and `SELECT` on exactly the thirteen tables `query_graph`'s docstring describes to the model, with every escalation attribute negated, `default_transaction_read_only = on`, no `ALTER DEFAULT PRIVILEGES` (so the list cannot grow silently when a migration adds a table), and `node_embeddings` deliberately excluded. `agents/_shared/db_credentials.py` is the only chooser: `AURORA_READONLY_SECRET_ARN` is mandatory for deployed graph readers; missing credentials fail closed. Search/advisor always receive the reader secret and `APP_ENV=production`, and CDK rejects `readOnlyGraphRole=false`. Apply `schema/graph_readonly_role.sql` before deploying these readers. A deliberate local experiment may set both `APP_ENV=development` and `ALLOW_UNSAFE_SQL_ADMIN_FALLBACK=true`; errors never retry as admin. The gateway traversal and PageRank Lambdas also use an isolated read-only credential role. See `docs/readonly-graph-role.md`. The regex guard stays regardless — defence in depth, and it is what protects a local `agentcore dev` or any cluster that has not applied the grant. Do not delete it, and do not add a second copy of the check anywhere.

## Money, dispatch and write gates

- **The dispatch surface has three soft brakes, each with its own confirm flag.** `POST /api/bots/dispatch-work` runs per-run cap → allocation → envelope (`decideRunBudget`/`decideAllocation`/`decideEnvelope`, all pure in `lib/bot-runner.ts`); each 409 names `gate` + `confirmFlag` and clears only on `confirmOverRunBudget`/`confirmOverAllocation`/`confirmOverEnvelope`. The deprecated `confirmOverBudget` opens the first two but **not** the envelope. `bot_runs.dispatched_by` (from the session sub, never the body — `schema/agent_run_attribution_schema.sql`) is the envelope's attribution; unknown burn is treated as unknown, not zero. Ahead of those three soft brakes sits a **hard** gate: `decideGrantScopedDispatch` (also in `lib/bot-runner.ts`, reached from `routes/bots.ts` and `routes/work.ts` via the `grantScopedDispatchVerdict` wrapper) 403s an `sme` who holds no active sprint grant on the target initiative before any money gate runs (org-leader/hr-admin/admin bypass), and its deny text distinguishes "no grant here" from "your grant's sprint isn't active yet." Sprint writes carry the same shape — Cedar grants `ManageSprints` role-wide to `sme`+`org-leader`, but `requireInitiativeSteward` (`routes/sprints.ts`) scopes an SME's create/move to initiatives they own or contribute to. Sprint surface: `/iq/sprints` + `GET /api/sprints?scope=mine|all` (`scope=all` is budgets-read-tier and 403s without `ManageBudgets`). See `docs/program-operating-model.md`.
- **Direct-invoke of a write agent requires `ManageIngest`.** `POST /api/agents/:id/invoke` gates the pipeline agents that mutate durable state — graph-builder (`merge_*` Aurora upserts), ingestion (`sync_knowledge_base`), scoring — on the `ManageIngest` capability, matched by `WRITE_AGENT_RE` (`routes/agents.ts`) so every id spelling gates (`graph-builder` / `orgiq-graph-builder` / `orgiq_graph_builder`). Read agents (supervisor/search/advisor) are ungated; reading *through* the fleet is fine, only direct invocation of a writer is gated. Member sessions 403.

## Local dev traps

- **Local Docker services bind to loopback; Jupyter requires its generated token.** The notebooks mount cloud credentials, so disabling notebook authentication or publishing the dev stack on all host interfaces exposes more than a demo UI. Read the login URL with `docker compose logs jupyter` or `jupyter-gcp`. npm certificate verification is enabled; install the appropriate CA for a corporate proxy instead of disabling TLS verification.
- **Browser origins are restricted before session processing.** `middleware/src/lib/browser-origin.ts` allows the API's own origin, `PORTAL_ORIGIN`, `PUBLIC_BASE_URL`, and comma-separated `CORS_ALLOWED_ORIGINS`. Development additionally allows loopback origins. Set a frontend origin explicitly for a separate production portal. Requests without an Origin header still pass through the normal authentication and authorization gates.

- **`useFetch` polls pause in hidden tabs, back off on failure, and can share a request.** `portal/src/hooks/useFetch.ts` (helpers in `hooks/pollSchedule.ts`): `pollIntervalMs` timers stop while `document.visibilityState === 'hidden'` and refetch once on return; consecutive failures double the delay (cap ×5); `{ share: true }` in the options dedupes concurrent in-flight requests for one URL (opt-in — the ~217 call sites keep independent `isLoading`/`refresh`). Two consequences: a Chrome tab driven by automation often reports `hidden`, so request-cadence measurements need visibility forced on (`docs/request-budget-audit-2026-09-16.md`); and anything handed to the library `ComputeProvider` as `clientOptions` MUST be a stable reference — an inline literal re-mints its client every render and re-fires the fleet poll, which is how devbox was polling every ~2s on every page. The mock agent stream is paced (`MOCK_STREAM_PACE_MS`, `docs/mock-floor.md`) and brackets each seeded tool call with STEP_STARTED/STEP_FINISHED the way the supervisor now does around each sub-agent call (`agents/supervisor/main.py`, `docs/research-agui-steps-2026-09-16.md`).

- **The middleware serves the realtime gateway on `/ws` when `REALTIME_GATEWAY=on`** (default outside production, off in production unless set). `lib/realtime-gateway.ts` attaches realtime-modules' chat/presence/calls to the BFF's own server, authenticates only `Sec-WebSocket-Protocol: bearer-token-v1, <realtime token>` (the HS256 token `GET /api/session/realtime-token` mints), and refuses call lobbies AND chat/presence channels outside the caller's `<tenant>:` prefix (`channelGuard` via `authorize` — do NOT also wire `presence({ authorizeChannel })`: it answers silently and hides the router's `AUTHZ_CHANNEL_DENIED` frame; the library's presence/reactions/cursor services subscribe as `presence:<ch>`/`reactions:<ch>`/`cursor:<ch>`/`chat:<ch>`, so the guard strips that prefix first — forgetting it refused the tenant's own presence). (0.98.5 left an outsider's presence `set` fanning into another tenant's roster — the library ran no publish check on presence broadcasts; 0.98.6 closed it and the assessment isolation logs record the re-probe.) That is why the portal's `VITE_GATEWAY_URL=http://localhost:3001` now connects (the portal appends `/ws`) instead of 404ing, and why `social-gateway` is optional locally. Every other upgrade path still 404s (`lib/unsupported-upgrades.ts`). Call state is Redis only when `REDIS_URL` is set; the default router is single-process; `REALTIME_GATEWAY_ROUTER=redis` opts both `/ws` and cookie `/realtime` into separately leased peer routing with fresh directory authority. The single-task safeguard stays in place pending complete capacity/cloud/media acceptance — since 2026-10-01 the CDK enforces it: `realtimeGateway=true` turns off the middleware's autoscaling and deploys stop-before-start (each deploy is a short signalling blackout). Capacity work for 100 calls: `docs/realtime-capacity-100-calls-2026-10-01.md` and the deploy plan §11. See `docs/social-calls-plan.md` step 7. Chat state (social lane S1): `chat({ chatStore })` takes realtime-modules' `DynamoChatStore` when `SOCIAL_CHAT_STORE=dynamo` or `SOCIAL_CHAT_DYNAMODB_ENDPOINT`/`SOCIAL_CHAT_TABLE_PREFIX` is set (`dev:mock:social` points it at DynamoDB Local :8000 and seeds the mock channels into empty tables once), the library's memory stores otherwise — with `social:` messages, members and read cursors as the registered `mock/social-channels.ts` fixtures under `MOCK_AURORA`, so `POST /api/__mock/reset` restores them (under Dynamo, reset only drops the ChatService caches). A `social:ch:<slug>` channel is admitted to its active MEMBERS only, checked with fresh, strongly consistent durable membership and current directory grants (`lib/social-chat.ts` and `lib/live-principal.ts`); a non-member's chat `join` is refused first by the library's own membership gate (`not-a-member`), while publish/presence/cross-tenant subscribes answer `AUTHZ_CHANNEL_DENIED`. The channel directory (name, description, privacy) is Aurora `social_channels` (`schema/social_schema.sql`), not chat state.
- **Another server on :3001 silently takes every portal `/api` call.** `localhost` resolves to `::1` first under Node, so a dual-stack listener from a different project (platform-api's `ts-node-dev` did this) answers the Vite proxy with 404s while `127.0.0.1:3001` is fine — `/select` then shows "Session unavailable" for every user. `portal/vite.config.ts` probes `127.0.0.1:3001` then `:3011` for the `orgiq-middleware` health signature and proxies to the first that is ours (`API_PROXY_TARGET` still wins); run `PORT=3011 npm run dev:mock` when 3001 is taken. `tsx watch` also fails to REBIND 3001 after a file change if something grabbed it meanwhile — the middleware looks alive but holds no socket.
- **The middleware test suite is jest + supertest with one shared server per file.** `npm test` runs `jest --config jest.config.cjs`; `jest.setup.cjs` disables HTTP keep-alive and `src/test-support/jest-shared-server.ts` binds a single `http.Server` per test file rather than letting supertest listen/close per request. Both halves fix one flake: supertest's per-request `listen(0)`/close churn recycles OS ephemeral ports fast, and Node ≥19's `http.globalAgent` pools keep-alive sockets by `host:port` — so a pooled socket from an old, closed server gets handed to a request against a *new* server on the same recycled port, surfacing either as `ECONNRESET` or, worse, as the **previous test's response body**. The signature is a suite that passes alone and an innocent different suite that fails under parallel workers. ⚠️ `middleware/src/mock/harness.ts` is **not** part of that: it is the mock fixture for the regression-test *harness feature* (`routes/harness.ts`) under `MOCK_AURORA`.
- **A pin bump can report success and install nothing, and a version check can read true against a package you do not import.** Three traps in one family, all hit on 2026-09-16. (1) A SHORT sha in `package.json` (`#1e6c0bde`) leaves npm believing the dep is satisfied: `npm install` prints "changed 1 package" and the installed version never moves. Write the full 40-char sha. (2) For a `github:` dependency npm creates the folder from the **dependency key**, not from the library's own `name` field — this repo's key is `@connorhoehnslalom/ui-components` while the sibling realtime-examples repo keys the SAME library as `@connorhoehn/ui-components`, and each repo can only import under its own scope. The installed manifest keeps the slalom name inside either folder, so a *version* check reads true under both while only the local scope is *importable*: version and identity are separate questions needing separate checks. (3) Vite serves the old dist until `portal/node_modules/.vite` is cleared AND the server restarts. The settling commands, run from `portal/`: `node -e "console.log(require.resolve('@connorhoehnslalom/ui-components/package.json'))"` for identity and `node -e "console.log(require('@connorhoehnslalom/ui-components/package.json').version)"` for version. And verify a newly adopted API against the installed `dist`, never against the library's source or CHANGELOG — 2.275.0 documented and unit-tested two `SubNavLayout` exports that its barrel never re-exported, so they never shipped; the library's own test passed by importing the component file rather than the barrel.
- **"does not provide an export named …" from the Vite dev server usually means a STALE CACHE, not a removed export — check before you reimplement.** This one has already cost the repo once. On 2026-09-17 a package bump surfaced module-export errors for `T`, `activeNavItemClassName` and `inactiveNavItemClassName`; the errors were read as "ui-components removed these", and all three were replaced with local copies. They had not been removed — every one still resolved from `/shared` at the installed pin — and the replacements were not equivalent: the substituted nav classes dropped the active item's accent bar, its highlight and all of its padding, so the primary rail rendered flush to the window edge with no active state on every page, while the seven layouts that had not been touched kept the real look. The cause was the cache trap in the entry above: Vite serves the old dist until `portal/node_modules/.vite` is cleared AND the server restarts.

  **The diagnostic is two commands, and it takes ten seconds.** Ask the installed package, not the dev server:

  ```bash
  cd portal
  # Is it really gone? (prints the export's type, or undefined)
  node --input-type=module -e "import('@connorhoehnslalom/ui-components/shared').then(m=>console.log(typeof m.T, typeof m.activeNavItemClassName))"
  # If it is NOT gone, this is the fix — not a reimplementation:
  rm -rf node_modules/.vite && npm run dev
  ```

  If the export resolves there, the library is fine and the dev server is stale. Only if it prints `undefined` is the export genuinely gone — and then the fix is a queue row in `docs/ui-components-queue.md`, not a local copy of the class strings, because a hand-copied constant silently stops matching the library the next time the library changes.

- The `@connorhoehnslalom` packages resolve over SSH from `github:` URLs, so `npm install` needs no `GITHUB_TOKEN` and no registry `.npmrc`. (This entry used to say a `GITHUB_TOKEN` was required; that was true when ui-components resolved from GitHub Packages.) A sha bump can still fail mid-install with "early EOF" — never cache-clean mid-install, and after a bump `rm -rf portal/node_modules/.vite` and restart the dev server or exports go missing.

## Facts that bite

- **Scanning JSX open tags with `<Tag[^>]*>` undercounts, because `=>` contains a `>`.** Any element carrying an inline arrow handler — `onClick={(e) => ...}` — is truncated at that arrow, so anything spelled later in the tag (a `className`, a `border-0`, a raw element) is invisible to the scan. This has bitten twice: `b47bdff` fixed it in the raw-element gate ("the raw-element counter could not see past an arrow function"), and on 2026-09-17 the same shape produced a wrong ghost-Button audit (88/12 reported, 78/22 true) that reached a commit message before being caught. Walk the tag brace-aware — count `{`/`}` and stop at the first `>` seen at depth 0 — rather than reaching for a character class. `scripts/validate-component-discipline.sh` is the worked example.
- Aurora does NOT support Apache AGE — the graph is modeled as relational tables, not Cypher. Schema in `schema/orgiq_schema.sql`.
- AG-UI uses POST for SSE (not GET EventSource). Frontend must use fetch + ReadableStream.
- Titan Embeddings V2 dimension must be specified at embedding time AND match the `vector(1024)` column type.
- `decisions` is **one** table (`schema/orgiq_schema.sql`, extended in place by `ALTER TABLE` in `orgiq_work_items_schema.sql`) after a split-worlds bug where two decision surfaces disagreed. `observability.approval_decisions` and `observability.canary_decisions` are unrelated, namespaced, and not the old split — don't "re-unify" them.

- **Forwarding headers require an enforced proxy hop.** Direct/local middleware ignores them. ECS sets `TRUST_PROXY_HOPS=1` for its ALB, or `2` with CloudFront in front (`deployPortal=true`); only set this when callers cannot bypass the reverse proxy. This controls both secure-cookie detection and client-IP rate limits. At two hops the ALB's `X-Forwarded-Proto` names CloudFront's plain-HTTP hop, not the viewer, so the viewer's scheme is read from `CloudFront-Forwarded-Proto` (`lib/trusted-proxy.ts` `viewerScheme`) — and only at two hops, so a direct caller cannot type it.
