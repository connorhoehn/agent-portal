# Social tenant, pipelines tenant, and the activity indicator — design

Status: design, 2026-09-29. Built on
[the research](social-tenant-and-pipelines-research-2026-09-29.md) (what
exists, verified against the code and the two upstream repos) and on three
things the user said that day, quoted where they decide something. The
research's section E listed five decisions "only the user can make"; this
document takes each one, says which of the user's words decided it, and
what flips if the reading is wrong. It ends with the work, cut into lanes
with a judge each.

The judge for this document is not a validator — it is that every lane
below names a goal doc + validator pair that will judge it, and that no lane
starts before its judge exists.

---

## 1. What the user asked for

1. *"I don't have a design to integrate the social chat, channels, dms,
   teams, etc into each tenant so what I am thinking is to create another
   tenant for the social and then slowly contextually embed the interactions
   into the other tenants."* → a **`social` tenant**, a product in the picker,
   and a deliberate order: the tenant first, embedding second.
2. *"the other thing is the pipelines which is basically the same. the idea
   being that any runbook or agent is backed by a pipeline."* → **the same
   shape for pipelines**: a place of their own first, embedded into orgiq and
   assessment second, and a rule — a runbook or an agent is executable only
   through a pipeline definition.
3. *"there really will need to be something in the toolbar showing social
   activity"* (with a screenshot of the shell header: ⌘K Search · 2 running ·
   demo-macbook · gateway dots · Demo User · Admin) → an **activity
   indicator in the shell header**, beside the controls that are already
   shared by every tenant.
4. *"you need to design it first and then get all the work to get the social
   tenant and other stuff"* → this document, then the lanes in §7.

## 2. Decisions taken

| # | Research question | Taken | Decided by | If wrong |
|---|---|---|---|---|
| E1 | Pipelines: a section per tenant, or a tenant of their own | **A tenant, `pipelines`**, with a Runs section embedded into each other tenant in the last phase | the user's "basically the same" — the social pattern, tile first, embed later | the research's recommendation (a section per tenant over one shared model) is §6 phase 3 with the tile removed; nothing in the model changes, only the mounts |
| E2 | Social store | **platform-api + DynamoDB** for rooms, teams, recordings, call sessions; the library's **`DynamoChatStore`** (0.99.0) over the existing `chat-*` tables for channels, DMs, membership, reads; **Aurora** for identity and context bindings | research (the tables and routes exist; Aurora's Data API is the wrong tool for message fan-out) | Aurora for chat means rewriting `ChatStore` against `chat_messages` tables — the seam (`chat({ chatStore })`) is the same |
| E3 | Identity source of truth | **`app_users`**, the realtime token the only bridge | research; picker logins have no Cognito subject | Cognito subjects would make SSO a prerequisite for chat; not revisited |
| E4 | A product in the picker, or a data-only tenant | **A product with a tile** | the user's "create another tenant" | a data-only tenant has no home for channel admin, teams, recordings and no isolation walks to prove itself |
| E5 | The guard rule: `org` only, or any tenant in `tenants` | **`tenants`** — a channel or room whose partition is any tenant the caller holds a grant in | required by "slowly contextually embed": an orgiq page cannot show a `social:` channel under `org`-only | keep `org`-only and embedding is impossible; the isolation walks are re-run either way |
| new | Where the activity indicator lives and what it is fed by | **The shell header, per user, fed by the gateway's `notifications()` feature** | the user's screenshot and sentence | see §3 for the alternatives rejected |

## 3. The activity indicator

### 3.1 What it is

One control in the shell header (`portal/src/components/shell/Layout.tsx`,
the `Inline` that holds `CommandPaletteHint`, `ActiveRunsBadge`,
`LocalComputeBadge`, `GatewayStatusBadge`, `MasqueradeMenu`), placed between
the fleet badges and the gateway dots: a bell with an unread count. Pressing
it opens a popover listing the items newest first, each with a category
label (the tenant and the kind), a title, a body and an age; clicking an
item marks it read and navigates to where it points; "Mark all read" and
"Clear" at the foot. Keyboard: the bell is a button, the popover is the
library's `InlinePopover` (Esc closes, focus returns), the list is
`NotificationCenter`.

The header is the one piece of chrome the tenants already share (the
palette, the masquerade menu, the gateway dots), and the indicator is
addressed to a **user**, not a tenant — so it does not break the "tenants
are separate products" rule (`docs/assessment-tenant.md` §"Tenants are
separate products on a shared BFF"). What keeps the rule honest is §3.4:
an item is delivered only to a user who holds a grant in the tenant it
belongs to, and it never links across a tenant boundary the session cannot
cross.

Rejected: a per-tenant activity page instead of a header control (the user
asked for the toolbar, and an assessor answering a comment on a document
should not have to leave the document to notice a reply); polling a BFF
inbox route (the gateway already holds a per-user delivery path with unread
replay on connect, and a poll would be the only header control on a timer
besides the 30s health check); deriving "activity" client-side from the
chat frames already on the socket (those arrive only for channels the tab is
subscribed to, which is exactly the set the user is already looking at).

### 3.2 Library component: `NotificationBell` (ships to ui-components first)

Not in the installed library (2.407.36 exports `NotificationCenter`,
`InlinePopover`, `Badge`, `IconButton`, `BellMutedIcon`;
`NotificationBell`, `InboxButton` are `undefined`). Per the component
discipline it ships to ui-components before the portal uses it:

```
NotificationBell {
  items: NotificationItem[];            // NotificationCenter's shape
  unreadCount?: number;                 // default: items.filter(!read).length
  onItemClick?(item);  onMarkAllRead?(); onClearAll?();
  label?: string;                       // aria-label, default "Activity"
  placement?: InlinePopoverPlacement;   // default 'bottom-end'
  size?: 'sm' | 'md';                   // header rows use 'sm' (28px, the HEADER_CONTROL family)
}
```

Composition inside the library: `IconButton` (a `BellIcon` glyph added
beside `BellMutedIcon`) with a `Badge` count overlaid at the top-right,
`InlinePopover` anchored to it, `NotificationCenter` inside, an empty state
("Nothing new") when `items` is empty. In `integrations/realtime`, a
`WrappedNotificationBell({ notifications, onItemClick })` mirrors
`WrappedNotificationCenter` — it takes the return value of realtime-modules'
`useNotifications()` and hands the click both the item and the original
entry, because `NotificationItem` has no `channel`/`action`/`payload` and the
entry is what carries where a notification points.

### 3.3 Transport: the gateway's own notification feature

realtime-modules 0.98.7 ships `notifications()` as an `attachRealtime`
feature (`dist/server/attach.d.ts:73`): a `NotificationService` with
`notifyUser(userId, input)` (persists, then delivers a `notification:new`
frame to every live connection of that user), `notification:read` /
`notification:bulk-update` for read state, and `replayUnreadForUser` on
connect so a fresh tab gets its unread set. Persistence is Redis
(`NotificationRedisClient`: `zAdd/zRange/zCard/zRemRangeByRank/hSet/hGetAll/expire/del`)
or nothing — with no client it delivers to live tabs only.

The middleware's gateway (`middleware/src/lib/realtime-gateway.ts`) adds
`notifications({ redisClient })` to its feature list. `lib/redis-lite.ts`
grows the four sorted-set commands so the same `REDIS_URL` that backs call
state backs notifications (the interface's `hSet`/`hGetAll`/`expire`/`del`
already exist there under lower-case names; an adapter object maps the
casing). Memory when `REDIS_URL` is unset — the honest local default, and
the reason the mock fixture in §3.5 exists.

The client side is the library's `useNotifications()` inside the existing
`OptionalGatewayProvider` (read state persisted under
`rmn:notifications:read`; add that key to `tenantCaches.ts` so a
tenant/user switch clears it — the server keeps the truth).

### 3.4 What produces an item, and to whom

A single seam, `middleware/src/lib/social-notify.ts`:
`notify(userIds, input)` → `handle.services.notification.notifyUser` for
each id, no-op when the gateway is off. Every item carries `tenant` in
`payload` and the tenant's label as the `category`, and an `action.href`
that is a portal path **inside that tenant**. The rule: an item is sent to a
user only if that user holds a grant in `payload.tenant`
(`providers/identity.ts` grants lookup — the same rows `mintSession` reads).
That is what keeps the header honest across products: an assessor with no
`social` grant never receives a social item, and a `social` item's href
never points into orgiq.

Producers, in the order they are built (each is one function call at an
existing write path):

| Event | Where it happens today | Recipients | Type / href |
|---|---|---|---|
| Reply to your comment on a document | `POST /api/assessment/knowledge/doc/comment` with `parentId` | the parent comment's author | `reply` → `/assessment/<mode>?doc=<id>` |
| A comment on a document you commented on | same route, top level | every other commenter on that document | `reply` (category "comment") |
| `@mention` in a comment or a chat message | same route; chat `onMessage` router plugin | the mentioned users (`@<display name>` resolved against the tenant roster; unresolved mentions notify nobody) | `mention` |
| A DM message while you have no live subscription to that lobby | router plugin `onMessage` on `chat` publish to `<t>:dm:<a>:<b>` — the lobby name carries the member ids; the sender is `message.metadata.userId` (server-stamped since 0.98.5, authoritative; the hook's `clientId` is the connection, or `'server'`) | the other member(s) not currently subscribed to the channel | `message` → `/social/dms/<lobby>` |
| A channel message in a channel you are a member of but not viewing | same plugin, `social:ch:*`, membership from the `ChatStore` (§4.4) — **phase S1** | members minus current subscribers | `message` → `/social/channels/<slug>` |
| Missed call (invite cancelled, declined, or unanswered) | `calls({ onCallMissed })` — in the library since 0.97.10 (`src/call/types.ts:468`: `{ callId, lobbyName, callerId, targetUserIds, reason: 'cancelled' \| 'declined' \| 'no-answer' }`; `onCallStarted`/`onCallEnded` beside it), wired in the gateway | the callee(s) | `call-missed` → the page the invite carried (`channel: initiative:<id>` / a doc / a DM) |
| A proposed edit waiting on you (the drafter's `ProposedEditStrip`) | client-side today; server-side once P2's reply is stored | the document's editor | `approval-requested` → the doc |
| An approval request (orgiq) | `POST /api/observability/approvals/request` (agent callback) | every user whose role holds `ApproveTransaction` in orgiq | `approval-requested` → `/iq/approvals` |
| Pipeline run needs approval / finished / failed | the pipelines tenant, §5 | `triggeredBy`, and the approvers named on the step | `approval-requested` / `system` → `/pipelines/runs/<id>` |

`notifyUser` never throws and delivery is fire-and-forget, so no write path
gets slower or fails because the gateway is down.

### 3.5 Mock floor

Under `dev:mock` the gateway is real, so items arrive live — but a fresh
session sees an empty bell, and the contract says an empty state is
something you ask for, not the default. A registered fixture
`middleware/src/mock/notifications.ts` seeds the in-memory store per user
from rows (a reply, a mention, a missed call for the curated cast, all
timestamped from `mock/core/clock.ts`), a scenario `empty` for the empty
state, and `POST /api/__mock/reset` restores it. Under `MOCK_AURORA` the
grant lookup reads the identity fallback, so the tenant rule is exercised in
mock too.

### 3.6 Judge

A Playwright spec with two contexts: u-farah replies to u-jonas's comment →
u-jonas's header bell reads 1 within 2s without a reload, the popover names
the document and the author, clicking it lands on the document with the
Comments tab open and the bell reads 0; u-asha (no `social` grant) receives
nothing from a `social:` DM sent to her id (the grant rule); a reload
replays the unread set. Added to `validate-assessment-tenant.sh`'s e2e list
and to the social tenant's validator.

## 4. The social tenant

Everything in the research's §C stands; this section fixes the parts it
left open and restates the contract in one place so the goal doc can point
here.

### 4.1 Registration

Tenant id `social`. Roles `participant` / `moderator` / `community-admin`,
plus the cross-tenant `admin`. Cedar actions `ViewSocial`, `PostMessage`,
`StartCall`, `ManageChannels`, `ManageTeams`, `ManageRecordings`,
`ManageSocialConfig`, with `forbid`s the shape of `assessor.cedar`
(participant: the three `Manage*`; moderator: `ManageSocialConfig`). Every
one of them in `CAPABILITY_ACTIONS`. The 21 registration points in the
research's A.4 are the checklist, and the tenant's validator counts them.

Cast (seed + identity fallback + Cognito seed list): `u-mira` Mira Okafor
(community-admin), `u-theo` Theo Lindgren (moderator), `u-sana` Sana Iqbal
(participant). For embedding, the curated orgiq cast and the assessment cast
receive a `participant` grant in `social` — that is what E5 turns into
access, and it is why the picker will show three tiles to most users. The
demo user gets none: the isolation walks need a session with no social
grant.

Rail (`GROUP_ORDER_BY_TENANT.social`): **Talk** (Channels `/social/channels`,
Direct messages `/social/dms`), **Meet** (Calls `/social/calls`, Rooms
`/social/rooms`), **People** (Contacts `/social/contacts`, Teams
`/social/teams`), **Library** (Recordings `/social/recordings`), **System**
(Configuration `/social/configuration`, Settings). Front door
`/social/channels`. Brand tokens: a third `[data-tenant="social"]` block —
a cool violet family so it reads as neither orgiq's blue nor assessment's
teal; light and dark.

### 4.2 Identity and the guard (E3, E5)

One `app_users` id everywhere, unchanged. The realtime token already carries
`tenants`; the change is in the two verifiers:

- gateway (`realtime-gateway.ts` `channelGuard` / `lobbyGuard`): a prefix
  `p:` is admitted when `auth.tenants.includes(p)`; the DM rule (caller is
  one of the ids) is unchanged; `social:` channels additionally require
  membership once the `ChatStore` exists (S1);
- platform-api (`lobbyAccess.ts`, rooms/teams/video-session routes): the
  partition is read from the target and checked against `tenants`, `org`
  still accepted for tokens without the claim — taken by the
  realtime-modules session on 2026-09-29 (sha to be recorded here when it
  lands).

A token still says `org: <session tenant>`, so rooms and teams a user
creates while standing in Social land under `social`. No second token.

### 4.3 Channel naming

`social:ch:<slug>`, `social:dm:<sorted ids>`, `social:team:<team>:<slug>`,
`social:room:<slug>`. Other tenants embed these names through bindings; they
never mint `social:` names of their own.

### 4.4 State (E2)

| State | Store | Owner |
|---|---|---|
| channels, DMs, messages, membership, reads, pins | `chat-messages` / `chat-conversations` / `chat-members` (DynamoDB, `OrgIQ-Social`; DynamoDB Local under the `social` compose profile) through the **library's** `DynamoChatStore` (realtime-modules 0.99.0, `server/stores/dynamo`, a faithful extraction of realtime-examples' chat persistence with the SDK v3 DocumentClient injected), passed as `chat({ chatStore: new DynamoChatStore({ client, tables }) })` — the middleware does not write its own | realtime-modules (store), middleware (wiring) |
| rooms, teams, recordings, call sessions, call log | platform-api + DynamoDB; add `teams`, `team-members`, `social-relationships`, `video-recording-share-links` to `social-stack.ts` | platform-api (upstream), stack here |
| notifications | Redis via the gateway feature (§3.3) | middleware |
| context bindings | Aurora `social_bindings (tenant, context_kind, context_id, channel, created_by, created_at)` | middleware |
| roster, grants | Aurora identity tables | middleware |

### 4.5 Pages

Composed from the installed library only: `ConversationRail` +
`WrappedChatPanel` + `ContextComposer` (the document-conversation pair, in
`chat` mode) for Channels and DMs; `createWrappedHangoutRoomsList` /
`createHangoutRoomsSection` + the existing call host for Rooms and Calls;
`TeamChannelTree` for Teams; `RecordingList` + `RecordingPlayer` for
Recordings; `PresenceAvatars` on rosters; `StackedRail` where a page has a
second rail (the rail-parity judge applies). Configuration and Settings on
the same forms family the assessment configuration page uses. Anything
missing goes to `docs/ui-components-queue.md` as a row before a local
composition.

### 4.6 Embedding (phase S3)

The `ChannelBinding` strip ("Discussion · #auth-migration · Open in Social")
on the initiative overview, the Search connections tab (people → DM), and the
document pane (its conversation may become a `social:` channel, or keep
`assessment:doc:*` alongside — decided when S3 starts, on what the walks
show). The composer discipline in `docs/social-calls-plan.md` stands: one
composer, modes by context; an embedded channel is that composer in `chat`
mode pointed at a `social:` channel.

## 5. The pipelines tenant

### 5.1 Why a tenant here too

The research argued for a section per tenant; the user's framing is the
social pattern, and the objection ("a ledger has no cast") does not survive
a look at what a pipelines product is upstream: realtime-examples' pipelines
page is a **catalog** of definitions, **run drafts** with estimates,
**runs** with steps and approvals (`usePipelineCatalog`, `useRunDraft`,
`useRunEstimate`, `fetchPipelineCatalog` in the installed client). That has a
cast: the person who writes a definition, the person who runs and approves,
and the operator who configures the fleet. So: tenant id `pipelines`, roles
`author` (create and version definitions, dry-run), `operator` (run, cancel,
approve steps, see every run), `pipeline-admin` (operator + configuration
and tenant users), plus `admin`. Actions `ViewPipelines`, `AuthorDefinition`,
`RunPipeline`, `ApproveStep`, `CancelRun`, `ManagePipelineConfig`.

The data-boundary objection is answered the way social's is: the tenant
**owns** definitions, runs, steps and artifacts; a run carries
`context: { tenant, kind, id }` naming what it acted for (an orgiq bot, an
assessment command), and the embedded Runs section in another tenant shows
only runs whose context tenant is that tenant — a binding, read through
`requireTenant`, exactly like a social channel on an initiative.

### 5.2 Model

The research's D.3 verbatim: `Definition`, `Run`, `Step`, `Artifact`,
`Event`, with pipeline-runtime's statuses and event-catalog's names, and the
mechanical crosswalk from the seven run-shaped tables. Aurora tables
`pipeline_definitions`, `pipeline_runs`, `pipeline_steps`,
`pipeline_artifacts` (`schema/pipeline_schema.sql`); the projection over the
existing tables is how the tenant is populated before any producer writes to
them, and it stays as the read path for the seven sources.

"Any runbook or agent is backed by a pipeline" becomes two rules with a
judge each: (1) a RUNBOOK asset cannot be promoted to SKILL without a
`completed` run of its definition (the dry-run the ladder doc names but
nothing implements); (2) every fleet invocation is a run — the AG-UI run id
rides the trace bundle, `STEP_*` are its steps, the trace is its artifact.

### 5.3 Rail and pages

**Catalog** (Definitions `/pipelines/definitions`, Runbooks
`/pipelines/runbooks`), **Runs** (Runs `/pipelines/runs`, Approvals
`/pipelines/approvals`, Artifacts `/pipelines/artifacts`), **Sources**
(Agents `/pipelines/agents`, Bots `/pipelines/bots`, Commands
`/pipelines/commands` — the three producers, read-only views of what each
tenant registered), **System** (Configuration, Settings). Front door
`/pipelines/runs`. Pages compose the library's pipelines domain
(`RunTimeline` already in the portal, `DataTable`, the run-draft composites
from the installed client) — the catalog/draft/run shapes are the library's,
so no new domain types are minted here.

### 5.4 Execution

No new executor. The fleet dispatcher, the governed-run pipeline and the
assessment worker keep executing; the tenant records. DAG definitions
(the researcher shape) go through a `PipelineBridge` to platform-api's engine
in the last phase, as the research proposed.

## 6. Isolation, restated for three new things

- A session's `tenant` gates every `/api/social/*` and `/api/pipelines/*`
  route (`requireTenant`); the cross-tenant `admin` sees all three.
- The realtime token's `tenants` is the only cross-tenant key, and it opens
  a channel or room only to a holder of that tenant's grant (E5).
- The activity indicator delivers to grant holders only (§3.4).
- Every existing walk stays green: `validate-assessment-tenant.sh`
  (its isolation logs gain the two new outside roles),
  `validate-orgiq-audit.sh`, `validate-newsroom-removal.sh` (re-pointed:
  three tenants), `validate-nav-parity.sh`, `validate-rail-parity.sh`.

## 7. The work, in lanes

Each lane names its judge; a lane's first commit is its goal doc +
validator. Lanes marked ∥ can run in parallel on Opus subagents (headless
Playwright only; the parent keeps the browser and commits). Nothing under
`portal/src` or `middleware/src` is edited while a journey walker is
running against the shared stack.

| Lane | Work | Judge | Depends on |
|---|---|---|---|
| **D** design + goals | this doc; `docs/social-tenant-goal.md` + `scripts/validate-social-tenant.sh`; `docs/pipelines-tenant-goal.md` + `scripts/validate-pipelines-tenant.sh`; `docs/activity-indicator-goal.md` folded into the social goal | the validators exist and fail honestly on an empty tree | — |
| **L** library ∥ | ui-components: `BellIcon`, `NotificationBell`, `WrappedNotificationBell`; queue rows for `ChannelBinding` strip and anything §4.5 finds missing; release, full-sha pin, Vite restart | library suites; `snapshot:exports`; the pin's settling commands | — |
| **N** activity indicator | `notifications()` in the gateway + redis-lite sorted sets; `lib/social-notify.ts` + grant rule; producers rows 1–4 and 8 of §3.4; `notifications` mock fixture + scenarios; `ActivityBell` in the header; `tenantCaches` key; e2e spec | §3.6 spec; mock floor; route coverage; middleware suite | L, and the walker finished |
| **S0** social registration ∥ | the 21 points of A.4 for `social`; cast; Cedar; brand tokens; empty-state pages; picker tile; isolation logs for the eight outside roles and three outbound walks | `validate-social-tenant.sh` phase-0 checks; assessment + newsroom-removal + nav-parity validators green | D |
| **S1** channels + DMs | consume the library's `DynamoChatStore` (0.99.0 pin); `chat({ chatStore })`; membership in the guard; Channels and DMs pages; `POST /api/social/channels`, `/dms`; mock fixtures; two-context walk (post, read, DM, `AUTHZ_CHANNEL_DENIED` on a forged cross-tenant subscribe) | the walk + validator phase-1 checks | S0, N (the plugin reuses N's seam) |
| **S2** rooms, teams, recordings | four tables added to `social-stack.ts`; platform-api `tenants` change (handed upstream); Rooms/Calls/Teams/Recordings pages on the library composites; room calls on `social:room:<slug>` through the existing call host | rooms created via REST are visible to a browser user in the tenant; recordings list | S0, upstream |
| **P0** pipelines registration + projection ∥ | the 21 points for `pipelines`; cast; `lib/pipeline-runs.ts` projection + crosswalk; `/api/pipelines/runs` (list, `:id`, steps, events SSE); Runs and Artifacts pages; the maintenance-bot vertical slice on the bot detail page | every seed row of the five sources appears once with a valid status, mock and Aurora; `validate-pipelines-tenant.sh` | D |
| **P1** agent half | run id into the trace bundle; steps from `STEP_*`/`TOOL_CALL_*`; trace artifact; `LabelFeedback` unblocked | golden runner structural mode; the harness suite | P0 |
| **P2** definitions | `pipeline_schema.sql`; bots and assessment commands as definitions with triggers; runbook dry-run as a run; SKILL promotion requires one; Definitions/Runbooks/Approvals pages | promotion refuses without a run (test); validator phase-2 checks | P0 |
| **E** embedding | E5 guard change (gateway half); `social_bindings`; `ChannelBinding` strip on the initiative overview, people → DM on Search connections, the document pane's conversation decision; the Runs section in orgiq (Operate) and assessment (Activity) fed by context; approval and pipeline producers (§3.4 rows 7–9) | the assessment and orgiq isolation walks still pass with a forged frame refused; rail/nav parity; the search-workspace judge | S1, P0 |
| **X** deploy | `OrgIQ-Social` gains the tables; Redis for notifications on the ECS task; the deploy plan's phases | `docs/social-calls-deploy-plan.md` | S2 |

Order: D → L ∥ S0 ∥ P0 → N → S1 ∥ P1 → S2 ∥ P2 → E → X. The first thing
the user sees change is the bell (N), on the day L lands.

## 8. Not decided here

- Whether the document pane's conversation moves to a `social:` channel or
  keeps both (E, on evidence from the S1 walk).
- The social and pipelines brand hues — proposed above, easy to change in
  one token block each.
- Who approves a pipeline step by default when a definition names no role
  (proposal: `operator`; the researcher CRD's `role:editor` drift is fixed
  when P2 imports it).
