# The voice navigator: what the application can do, and the catalogue that would cover it

A read-only sweep on 8 November 2026 for the owner's note that the voice system "can do limited operations": the complete list of what a person can do through the middleware and the portal, derived mechanically from the routes, the Cedar seeds and the registries, set against the tools the voice catalogue has today, and a proposed catalogue v2 with packages the loop can run. Nothing here is built; the one artefact is the generator, `scripts/voice/inventory.mjs`, which writes `docs/voice-tool-inventory.json` and is the test that keeps this document honest.

Tags: **fact** = read in this repository (file and line named); **decision** = a choice this document makes so the loop can proceed unless the owner overrides; **in flight** = uncommitted work seen in this worktree on 8 November (package G19, `queue_work`).

## 1. Method and numbers

### How the inventory is derived

`node scripts/voice/inventory.mjs` reads eight sources and writes one JSON file; `--check` regenerates it in memory, fails when the file on disk differs, and fails when a write route a person can reach has no catalogue decision; `--print` shows the summary and the undecided rows. There is no root package.json, so run it as `node scripts/voice/inventory.mjs [--check|--print]` from the repo root; CI runs `--check` as the `voice-inventory` job in `.github/workflows/ci.yml` (node only, no install). The route capture lists a router once per mount: a module that hosts two routers (`agent-loop.ts`, `conversation-artifact.ts`) mounts each at its own prefix, so the snapshot has no duplicate rows (it had 26). The sources:

- The wire snapshot `middleware/src/mock/core/wire/snapshots/routes.json` (`routes[]`, each `{ method, path, source }`, 853 rows, retaken on 8 November 2026) and the write-capture policy's verdict per write in `snapshots/writes.json` (`routes` keyed `METHOD /path`, each `allowed`, `skipped` or `refused: { rule }`; the rules are `write-policy.ts:735` REFUSAL_RULES and `:899` WRITE_SPECS). **fact**
- The mounts in `middleware/src/index.ts` (`app.use(prefix, …gates, router)`, lines 174 to 569): `requireTenant`, `requireAction`, `requireSession`, `socialGate`, `readForRolesElseAction` and `serviceAuthOr`, with the `viewObs` pair at `:192` and the imports that map a router variable to its file. **fact**
- Every declaration in `middleware/src/routes/*.ts`, found by method and path when the snapshot's line no longer points at it (13 of the 827 unique snapshot rows at the time of writing; 26 rows are duplicates of the two-mount routers in `agent-loop.ts` and `conversation-artifact.ts`; and 10 routes are declared but absent from the snapshot: the four tenant search mounts, the plane's, and their `/answer` twins, because the `tenantSearchRouter` factory has no declaration the capture attributes). Named gate constants (`viewGate`, `readGate`, `manageGate`, `dispatchGate`…) are resolved from the file's own `const` table; nested routers (`assessmentRouter.use(assessmentDecksRouter)`, `observabilityRouter.use('/drift', driftRouter)`) inherit the parent's mount. An `isAllowed(session, 'X')` inside a handler is recorded as the route's action when nothing sits in front of it (`approvals.ts:470` is the one write that gates this way). **fact**
- The role seeds `middleware/seeds/roles/*/*.cedar` (permits minus forbids, comments stripped first), `middleware/seeds/schema.json` (61 actions), and `CAPABILITY_ACTIONS` in `middleware/src/lib/authz.ts:35-108` (the list the portal's `can()` mirrors, `portal/src/lib/capabilities.tsx:16-85`). Two schema actions are in no portal list: `ViewSalary` and `ViewPerformance`. The cross-tenant `admin.cedar` permits every action unconditionally, so it holds no named list. **fact**
- `tenants/manifest.json` (five tenants, their api prefixes and which have a presence lobby: orgiq, assessment and pipelines do, social and access do not) and `portal/src/components/shell/portalCommands.ts` `PAGES` (`:108`, 109 rows; `pageId` at `:48`; `isPageVisible` at `:356` treats `tenant: 'admin'` pages as orgiq surfaces). **fact**
- `middleware/src/lib/voice/catalogue.ts` `VOICE_TOOLS` (`:269`): each tool's tenants, `confirm`, `action` and the routes its `mapsTo` names, plus `NAVIGATE_PAGES` (`:99`). A route is "covered today" when a tool's `mapsTo` names it. The worktree's catalogue carries G19's `queue_work` uncommitted (**in flight**), so the JSON counts 16 tools; a clean checkout of HEAD counts 15 and the check reports the JSON stale until G19 lands, which is the intended behaviour of the check, not a defect. **fact**

Each route row carries `method, path, tenants, kind, family, cedarAction, actions, readRoles, floor, holders, writePolicy, coveredBy, v2`; each page row carries `label, tenant, roles, pageId, coveredBy`. Kinds: `read` (GET), `write` (anything else), `internal` (`/internal/*`, node-token and service-secret routes, the realtime admission, the public drop, the uploads bearer, the health probes), `dev` (`/api/__mock/*`, test fixtures), `navigate` (a page). Families are assigned by source file with a few path overrides (`familyFor` in the script).

### The numbers

837 unique routes and 109 pages. Of the routes, 794 are reachable by a signed-in person: 437 reads and 357 writes; 30 are internal and 13 dev-only. By tenant: orgiq 417, assessment 112, the Social plane in orgiq, assessment and pipelines 33, social 32, pipelines 30, access 27, and 143 that take any tenant (the session floor: `/api/people`, `/api/me/*`, `/api/chat/*`, `/api/conversations/*`, the embed router's `/api/social/*`, `/api/access-requests`). **fact**

Covered by the catalogue today: 28 routes (22 reads, 6 writes) out of 794, and 24 of 109 pages. The 16 tools reach: `search_people`, `search_records` and `activity` the six search routes (`GET /api/search`, the four tenant searches, the plane's); `list_active_initiatives` `GET /api/graph/projects`; `bot_sweep_status` the sweep runs, findings, active and bot runs; `start_computer` `POST /api/devbox/boxes`; `run_command` `POST /api/devbox/:sessionId/command`; `send_chat_message` and `start_call` the resolver and `POST /api/social/dms`; `access_request_status` three access reads; `queue_work` (in flight) ten routes across sweeps, bots and pipeline dry-runs. `navigate`, `open_result`, `open_computer_lab`, `open_shell` and `set_status` reach no route of their own. **fact**

Catalogue v2 (§3) decides every one of the 794: 286 go to a read tool, 114 to an action tool behind the Confirm card, 1 opens a tab, 368 are never by voice (141 reads, 227 writes) and 25 are not for people even though a session can call them (streams, the session's own reads, the voice plane, the plane's `can()`, agent callbacks). 401 routes end up reachable by voice (from 28), plus every page through `open`.

| family | rows | reads | writes | internal or dev | covered today | v2 read or open | v2 confirm | v2 never | v2 n/a |
|---|---|---|---|---|---|---|---|---|---|
| navigate (pages) | 109 | 0 | 0 | 0 | 24 | 109 | 0 | 0 | 0 |
| search | 19 | 16 | 3 | 0 | 6 | 16 | 3 | 0 | 0 |
| social.chat | 74 | 38 | 36 | 0 | 2 | 38 | 32 | 4 | 0 |
| social.calls | 30 | 18 | 10 | 2 | 0 | 18 | 2 | 8 | 2 |
| social.teams | 12 | 4 | 8 | 0 | 0 | 4 | 4 | 4 | 0 |
| work | 77 | 39 | 35 | 3 | 3 | 38 | 17 | 18 | 4 |
| bots | 24 | 11 | 13 | 0 | 8 | 10 | 5 | 9 | 0 |
| compute | 69 | 25 | 29 | 15 | 2 | 20 | 4 | 16 | 29 |
| access | 28 | 14 | 14 | 0 | 3 | 15 | 8 | 5 | 0 |
| approvals (HITL, SDLC) | 21 | 11 | 9 | 1 | 0 | 8 | 5 | 7 | 1 |
| runbooks | 28 | 18 | 9 | 1 | 0 | 13 | 6 | 8 | 1 |
| budgets | 27 | 18 | 9 | 0 | 0 | 18 | 0 | 9 | 0 |
| documents (decks, docs) | 74 | 31 | 42 | 1 | 0 | 31 | 13 | 29 | 1 |
| assessment | 72 | 34 | 37 | 1 | 0 | 33 | 12 | 25 | 2 |
| pipelines | 19 | 14 | 5 | 0 | 4 | 14 | 3 | 2 | 0 |
| knowledge (KB, ingest) | 69 | 39 | 28 | 2 | 0 | 6 | 0 | 61 | 2 |
| org (roster, scores) | 18 | 17 | 1 | 0 | 0 | 4 | 0 | 14 | 0 |
| observability | 126 | 76 | 49 | 1 | 0 | 1 | 0 | 124 | 1 |
| identity | 18 | 8 | 10 | 0 | 0 | 0 | 0 | 18 | 0 |
| session | 13 | 6 | 7 | 0 | 0 | 0 | 0 | 7 | 6 |
| voice | 3 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 3 |
| health | 3 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 3 |
| dev | 13 | 0 | 0 | 13 | 0 | 0 | 0 | 0 | 13 |

The "compute" internal count (15) is the node-token loop a paired laptop runs (`/api/local-compute/announce`, `/claim`, `/jobs/:jobId/*`, `/register`, mounted ungated at `index.ts:562` because the machine has a token and no cookie) plus `/internal/devbox` and `/internal/work-graph`. **fact**

## 2. The inventory by family

Each table lists what a person could reasonably ask for by voice, grouped by what they would say, with the route and Cedar action behind it, the tenant, whether it is a read, a navigation or a confirmed action, what it involves (money, a machine, other people), and the v2 tool or the existing tool. "floor" means the route has no Cedar action of its own, only `requireSession(label)` plus the mount's tenant (`authz.ts:342`). "read tier" means `readForRolesElseAction`: the named roles read without the action, everyone else needs it (`authz.ts:451`).

### 2.1 Navigation

The 109 palette pages (`portalCommands.ts:108-350`) are the navigation surface; 24 carry a `pageId` and are the only ones `navigate` can name (`catalogue.ts:99-129`). Thirty-eight are `tenant: 'admin'` platform pages shown only in orgiq to the roles listed (`isPageVisible`, `:356-369`); the voice must never offer one to a role the palette would not show it to, which the palette's own `roles` gives for free.

| a person says | page(s) | gate | tenant | kind | v2 |
|---|---|---|---|---|---|
| "open search", "open initiatives", "the findings", "the work queue", "the graph updates", "the runbooks", "the briefs", "local compute", "my communication" | `/iq/search` (pageId `search`), `/iq/projects` (`initiatives`), `/iq/work/findings` (`findings`), `/iq/work/queue`, `/iq/work/changes`, `/iq/runbooks`, `/iq/runbooks/briefs`, `/iq/local-compute`, `/iq/communication` | the palette row's roles | orgiq | navigate | `open { page }`; today `navigate` for the three with ids |
| "open the computer lab", "bots", "budgets", "codebases", "changes" | `/admin/devbox` (`computer-lab`), `/admin/bots` (`bots`), `/admin/budgets`, `/admin/projects`, `/admin/changes` | DEVBOX, BOTS, BUDGETS, BUILD, CHANGES role lists (`:60-66`) | orgiq (admin pages) | navigate | `open`; today `open_computer_lab`, `navigate bots` |
| "open the dashboard", "submissions", "reports", "feedback", "runs", "the workspace", "enterprise", "rules" | `/assessment/teams` (`teams`), `/submissions`, `/reports`, `/feedback`, `/runs` (ids), `/assessment/workspace?view=library`, `/enterprise`, `/rules`, `/prompts`, `/activity` | any assessment role; configuration all three | assessment | navigate | `open` |
| "open channels", "my DMs", "calls", "hangouts", "contacts", "teams", "recordings", "my profile" | `/social/channels` (`channels`), `/social/dms`, `/social/calls`, `/social/rooms`, `/social/contacts` (`contacts`), `/social/teams` (`teams`), `/social/recordings`, `/social/profile` | any social role | social | navigate | `open` |
| "open definitions", "runbooks", "queues", "runs", "approvals", "artifacts", "agents", "bots", "commands" | `/pipelines/*` (six with ids) | any pipelines role; configuration pipeline-admin | pipelines | navigate | `open` |
| "open the catalog", "my requests", "open requests", "new request", "approvals", "policies", "reviews", "audit" | `/access/*` (five with ids) | approvals: approver, access-admin | access | navigate | `open` |
| "open observability", "on-call", "cost", "the approval queue", "identity", "knowledge", "ingest" | 29 platform pages under `/admin/observability/*`, `/admin/identity*`, `/admin/knowledge`, `/admin/ingest/*`, `/iq/prompts`, `/iq/history`, `/iq/diff`, `/iq/evaluations`, `/iq/agents`, `/iq/canary`, `/iq/prompt-ops`, `/iq/scores*` | PLATFORM (org-leader, hr-admin) or BUILD (hr-admin) | orgiq (admin pages) | navigate | `open` (opening a console is harmless; acting in it is §3's never list) |
| "switch to the access workspace" | `/workspaces` | none | all | navigate; ends the session (spec §2, §6) | `open { page: 'workspaces' }` as today |
| "settings" | `/settings`, `/access/settings` | none | universal and per tenant | navigate | `open` |

### 2.2 Search and questions

| a person says | route | Cedar | tenant | kind | v2 |
|---|---|---|---|---|---|
| "find the kubernetes experts", "who knows Terraform", "find the Alpha initiative", "search for the retention decision", "find the onboarding doc" | `GET /api/search?q=&type=&scope=&sort=` (`search.ts:10`), types person, team, initiative, work, decision, knowledge, asset, recording (`providers/search.ts:21`); the question intents my-work, decisions, decider, collaborators, team, initiative-people, recent, experts (`search-index/question.ts:19-26`) | `Search` (every orgiq and assessment role) | orgiq | read | `search { scope: 'workspace' or an initiative, query, type?, sort? }`; today `search_people`, `search_records` |
| "what records match X" (the palette's record section) | `GET /api/search/records` (`search.ts:27`) | `Search` | orgiq | read | `search { type }` |
| "any live huddles", "which teams are below target", "what failed last night", "pending approvals", "find the SSO policy" | `GET /api/<tenant>/search?q=&type=&limit=` and `/answer` (`tenant-search.ts:16-31`; mounts `index.ts:323, 336, 370, 374`; types per tenant in `catalogue.ts:199-205`) | `ViewAssessment`, `ViewSocial` (socialGate), `ViewPipelines`, `ViewAccess` | assessment, social, pipelines, access | read | `search`; today `search_records` (no tool reads `/answer`, which answers a question as one fact) |
| "what's new in #platform", "did anyone mention me" | `GET /api/social/plane/search` (`social-plane.ts:127`), the plane's copy of the Social index | `ViewSocial` through the caller's current Social grant | orgiq, assessment, pipelines | read | `activity` (today) and `search { type: 'message' }` |
| "find the recording where we discussed X" | `GET /api/assessment/recordings/search` (`assessment-recording-search.ts:28`) | `ViewAssessment` | assessment | read | `search { type: 'recording' }` |
| "find the invocation that failed with X" | `GET /api/observability/invocations/search` (`invocations.ts:127`) | `ViewObservability` (orgiq mount `index.ts:512`) | orgiq | read | `search { type: 'invocation' }` for PLATFORM roles; otherwise the console |
| "save this search", "my saved searches" | `GET/POST/PATCH/DELETE /api/saved-searches` (`saved-searches.ts:49-56`) | `Search` | orgiq | read; create and update confirm | `list { kind: 'saved-search' }`, `create { kind: 'saved-search' }` |

### 2.3 Social: messages, people, presence

The Social app's tenant router is behind `requireTenant('social')` (`index.ts:369`); the embed router (`socialEmbedRouter`, `index.ts:337`) and the plane (`index.ts:340`) answer in any tenant on the caller's current Social grant (`lib/social-authority.ts:88`). Posting itself never goes through HTTP: the browser sends over the gateway with `useChat(channel).sendMessage` (spec §1). The shell's own roster is `GET /api/people/shared` (`people.ts:33`, floor), which needs no Social grant.

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "tell the platform team I'm out today", "message Ada" | `GET /api/social/resolve?kind=&name=` (`social.ts:361`), `POST /api/social/dms { userId }` at confirm (`social.ts:739`, G14), then the gateway | `ViewSocial` to resolve, `PostMessage` to open the DM and to post | social; the plane elsewhere | confirm; people | `message` (today `send_chat_message`) |
| "set me to away", "I'm busy until three" | the tenant lobby's presence (`usePresence('<tenant>:lobby')`, manifest `presenceLobby`), then Social's with a grant | the socket's admission; no grant (G10) | orgiq, social (assessment and pipelines have a lobby too) | own state; nobody else | `set_status` as today, offered in every tenant with `presenceLobby: true` (**decision**) |
| "who's online", "is Ada on a call", "any missed calls", "what did I miss since yesterday", "what did Ada work on" | the shell roster; `GET /api/social/search` or the plane's with types huddle, calllog, message, pin; `GET /api/search?type=work` | `ViewSocial`; `Search` | orgiq, social | read | `activity` as today (G6) |
| "which channels am I in", "open #platform", "what's in #platform" | `GET /api/social/channels` (`social.ts:220`), `GET /api/social/channels/:slug` (`:257`); plane twins (`social-plane.ts:100`) | `ViewSocial` | social; plane | read | `list { kind: 'channel' }`, `get`, `open` |
| "my DMs", "unread discussions", "my groups" | `GET /api/social/dms` (`:345`), `GET /api/discussions/unread` (`discussions.ts:20`, floor), `GET /api/me/groups` (`me-groups.ts:23`, floor) | `ViewSocial`; floors | social; any | read | `list { kind: 'dm' }`, `summary { kind: 'unread' }`, `list { kind: 'group' }` |
| "who is in the Social directory", "who can I DM" | `GET /api/social/people` (`:421`), `GET /api/people/shared`, `GET /api/people/conversations` (`people.ts:68`) | `ViewSocial`; floors | social; any | read | `list { kind: 'person' }` |
| "join #platform", "leave #random" | `POST /api/social/channels/:slug/join` (`:279`), `/leave` (`:299`); plane twins | `PostMessage` to join, `ViewSocial` to leave | social; plane | confirm; people see the membership | `update { ref: 'channel:slug', fields: { member: true|false } }` |
| "pin that", "what's pinned in #platform", "unpin it" | `GET /api/chat/pins` (`chat-pins.ts:246`), `POST` (`:262`), `DELETE` (`:279`); `GET /api/chat/message` | the pin store's own membership check | any | read; confirm | `list { kind: 'pin' }`, `update { ref: 'message:id', fields: { pinned } }` |
| "mark my DM with Ada read" | `POST /api/social/dms/read` (`social.ts:402`) | `ViewSocial` | any | confirm (own state; the card is cheap) | `update` |
| "summarise this channel", "make a diagram of this thread", "draft a doc from this", "plan X for this channel" | `POST /api/chat/commands/{summarize,diagram,doc,agent}/run` (`social-summarize.ts:53`, `conversation-artifact.ts:204-209`, `agent-loop.ts:316-322`) and the `/api/conversations/*` twins for tenant discussions and huddles (`:213-218`, `:326-332`) | the conversation's own chat authority, `PostMessage` to post the result | any | confirm; money (an agent run), people when posted | `queue_work { kind: 'summarize'|'diagram'|'doc'|'agent-plan', target: the conversation }`, then `update { fields: { post: true } }` |
| "approve the agent's plan", "what's waiting on me in this channel" | `POST /api/chat/commands/agent/runs/:id/approve` and `/approval/approve`, `/reject`, `/discard`; `GET /api/chat/commands/agent/waiting` (`agent-loop.ts:318-322`) | the requester's posting right or the tenant's second-approver action | any | confirm; money | `decide { ref: 'agent-run:id', decision }`, `list { kind: 'waiting' }` |
| "who's sharing work with me", "what's live right now" | `GET /api/social/plane/active` (`social-plane.ts:141`), `GET /api/social/plane/people/:userId/shared-work`, `GET /api/social/conversations/:id/shared-work` | `ViewSocial` | plane; social | read | `summary { kind: 'live' }`, `get` |
| "bind this page to #platform" | `PUT/DELETE /api/social/bindings` (`social.ts:711, 729`) | `ManageChannels` in both tenants | any | never: a configuration act | never |

### 2.4 Calls, rooms and recordings

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "start a call with the platform team", "call Ada" | the resolver, then the shell's call host (`useSocialCall().callConversation` or `callPeople`); `POST /api/social/dms` at confirm | `StartCall`; the gateway's lobby guard by membership | orgiq, social | confirm; people are rung | `call { target, action: 'start' }` (today `start_call`) |
| "join the huddle in #platform" | the live huddle the index shows (`activity live-calls`), then the host's join | `StartCall`; membership | orgiq, social | confirm; people | `call { action: 'join' }` (new) |
| "which calls happened on this page", "my call history" | `GET /api/calls`, `/api/calls/tenant` (`page-calls.ts:40, 56`, floor `ReadPageCalls`); `GET /api/social/calls` (`social.ts:543`) | floors; `ViewSocial` | any; social | read | `list { kind: 'call' }` |
| "the recordings", "play the standup recording", "its transcript" | `GET /api/social/recordings`, `/:recordingId/playback`, `/transcript` (`social.ts:519-528`); plane twins | `ViewSocial` | social; plane | read | `list { kind: 'recording' }`, `get`, `open` |
| "share the recording with X", "delete it" | `POST /api/social/recordings/:id/share` (`:533`), `DELETE` (`:537`) | `ManageRecordings` | social | never: content reaches people; destructive | never |
| "which hangout rooms are there", "what's happening in the lounge" | `GET /api/social/rooms`, `/:slug`, `/:slug/activity` (`:441-458`) | `ViewSocial` | social; plane | read | `list { kind: 'room' }`, `get` |
| "create a room for the retro" | `POST /api/social/rooms` (`:447`) | `ManageChannels` | social; plane | confirm; people | `create { kind: 'room' }` |
| "share this page into the call" | `PUT /api/calls/:callId/page` (`call-pages.ts:51`) | a live participant's socket provenance | any | never: the live call's own control | never |

### 2.5 Teams

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "which teams are there", "who is on the platform team" | `GET /api/social/teams`, `/:teamId` (`social.ts:467, 482`); plane twins (`social-plane.ts:112-114`); orgiq's team type in `GET /api/search` | `ViewSocial`; `Search` | social; plane; orgiq | read | `list { kind: 'team' }`, `get`, `search { type: 'team' }` |
| "create a team called X" | `POST /api/social/teams` (`:472`) | `ManageTeams` | social; plane | confirm | `create { kind: 'team' }` |
| "mute the platform team for me" | `PATCH /api/social/teams/:teamId/me` (`:492`) | `ViewSocial` (own preference) | social; plane | confirm (own) | `update` |
| "add Ada to the team", "remove Bob" | `POST /api/social/teams/:teamId/members` (`:503`), `DELETE …/:userId` (`:513`) | `ManageTeams`; self-removal allowed | social; plane | never: changes other people's membership | never |

### 2.6 Work: initiatives, work items, sprints, decisions, jobs, findings

Reads under `/api/graph`, `/api/work` and `/api/work-graph` are tenant-open to orgiq (`index.ts:286-294`, `:567`); writes carry `DispatchAgentRun`, `ManageDevbox` or `ViewWorkItems` per route.

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "my active initiatives", "all initiatives", "show me Alpha" | `GET /api/graph/projects?scope=mine|all&status=` (`projects.ts:43`), `GET /api/graph/projects/:id` (`:69`), its `/work`, `/decisions`, `/activity` | mount (orgiq) | orgiq | read | `list { kind: 'initiative', filter }`, `get`, `open`; today `list_active_initiatives` |
| "what's on the board", "Alpha's work", "what did Ada work on", "my work items" | `GET /api/graph/work` (`work-items.ts:247`), `/projects/:id/work`, `/people/:personId/work`, `GET /api/graph/work-items/:id/comments` | mount | orgiq | read | `list { kind: 'work-item', filter: { initiative, person, status } }`, `get` |
| "create a work item on Alpha: …", "move it to in progress", "assign it to Ada", "put it in this sprint" | `POST /api/graph/work-items` (`:370`), `PATCH /api/graph/work-items/:id` (`:457`) | `DispatchAgentRun` (sme, program-owner, org-leader, hr-admin) | orgiq | confirm | `create { kind: 'work-item' }`, `update { ref: 'work-item:id', fields }` |
| "comment on it: …", "post in Alpha's discussion: …" | `POST /api/graph/work-items/:id/comments` (`:624`), `POST /api/graph/projects/:id/discussion/comments` (`:115`) | `ViewWorkItems` + membership of the initiative | orgiq | confirm; people read it | `create { kind: 'comment' }` |
| "its acceptance criteria", "the decision on it" | `GET …/criteria`, `…/decisions`; the writes | reads mount; writes `DispatchAgentRun` | orgiq | read; writes never (edited on the item) | `get`; never |
| "the sprints", "my envelope", "start a sprint", "move X into sprint 12" | `GET /api/sprints` (`sprints.ts:95`, floor `ViewSprints`), `/envelopes` (`:195`), `POST /api/sprints` (`:259`), `PATCH /:sprintId/items` (`:319`), `DELETE …/items/:itemId` (`:345`) | `ManageSprints` on writes (sme, program-owner, org-leader) | orgiq | read; confirm | `list { kind: 'sprint' }`, `budget { scope: 'envelope' }`, `create { kind: 'sprint' }`, `update` |
| "the decisions", "who decided X" | `GET /api/graph/decisions`, `/:id` (`decisions.ts:36, 49`); the `decider` intent of `GET /api/search` | mount; `Search` | orgiq | read | `list { kind: 'decision' }`, `get`, `search` |
| "the design threads", "answer the design question with …", "sign off the Alpha design" | `GET /api/designs`, `/:id` (`designs.ts:30, 42`, floor `ViewDesigns`), `POST /:id/answer` (`:59`), `/:id/signoff` (`:83`) | `DispatchAgentRun` | orgiq | read; confirm | `list { kind: 'design' }`, `decide { ref: 'design:id' }` |
| "what's in the work queue", "the job for X", "the work summary", "suggestions" | `GET /api/work/jobs`, `/:id` (`work.ts:193, 200`), `/summary` (`:57`), `/suggestions`, `/ask-suggestions` (`:142, 153`) | floor `ViewWork` | orgiq | read | `list { kind: 'job' }`, `get`, `summary { kind: 'work' }` |
| "queue a job: …", "run that again", "mark it reviewed" | `POST /api/work/jobs { title, prompt, kind }` (`:236`), `/jobs/:id/requeue`, `/review` (`:347, 329`) | `ManageDevbox` (sme, hr-admin) | orgiq | confirm; money (an agent runs it) | `queue_work { kind: 'job' }`, `update` |
| "dispatch the queue", "delete the job" | `POST /api/work/dispatch` (`:374`), `DELETE /api/work/jobs/:id` (`:363`) | `ManageDevbox` | orgiq | never: drains the fleet; destructive | never |
| "the findings", "how many open findings", "dismiss that finding", "turn it into a job", "analyse it" | `GET /api/work/findings` (`:389`), `/findings/stats` (`:564`), `POST /findings/:id/dismiss` (`:568`), `/promote` (`:488`, `DispatchAgentRun`), `/analyze` (`:530`) | floor; `ManageDevbox`; `DispatchAgentRun` | orgiq | read; confirm; promote and analyse spend | `list { kind: 'finding' }`, `summary`, `update`, `queue_work { kind: 'finding-promote'|'finding-analyze' }`; today `bot_sweep_status` reads them |
| "what graph changes are proposed", "approve the proposal" | `GET /api/work/proposals` (`:581`), `POST /proposals/:id/decide` (`:609`) | floor; `ManageDevbox` | orgiq | read; confirm | `list { kind: 'proposal' }`, `decide` |
| "any consults waiting for me", "answer the consult: …" | `GET /api/lab/consults` (`lab.ts:166`), `POST /consults/:id/answer` (`:194`) | floor `LabConsults`; `DispatchAgentRun` | orgiq | read; confirm (a box is waiting) | `list { kind: 'consult' }`, `decide { ref: 'consult:id', note }` |
| "what's on today" | `GET /api/today` (`today.ts:89`: pending consults, the visible fleet, this month's spend for the budgets tier) | floor; budget items behind `ManageBudgets` tier | any (Work answers) | read | `summary { kind: 'today' }` |
| "the codebases", "Alpha's runs" | `GET /api/agent-projects`, `/:id/runs` (`agent-projects.ts:34, 81`), `GET /api/runs`, `/:id`, `/:id/steps` (`runs.ts:26-29`) | read tier (org-leader, hr-admin, program-owner) else `DispatchAgentRun` / `ManageBots` | orgiq | read | `list { kind: 'codebase'|'run' }`, `get` |
| "link a repo", "start a run on the repo" | `POST /api/agent-projects`, `/:id/runs` (`:50, 141`) | `ManageDevbox` | orgiq | never: linking a repo is a form; a free-text run is code execution | never |
| "the work graph for today" | `GET /api/work-graph/workspace/graph`, `/initiatives/:id/graph`, `/people/:id/graph` (`work-graph.ts`) | mount; the parts re-gated per entity | orgiq | read | `get { ref: 'graph:…' }` or `open` the page |

### 2.7 Bots and sweeps

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "any issues with the sweeps since yesterday", "what failed last night" | `GET /api/work/sweeps/runs?since=&status=` (`work.ts:447`, read tier else `ManageBots`), `GET /api/work/findings`, `GET /api/bots/active-runs` (`bots.ts:553`, floor), `GET /api/bots/runs?botIds=` (`:622`) | read tier (org-leader, hr-admin, program-owner) else `ManageBots` | orgiq | read | `summary { kind: 'sweeps', since }`; today `bot_sweep_status` |
| "which bots do we have", "the PR bot's runs", "what is the PR bot" | `GET /api/bots`, `/:id`, `/:id/runs` (`:647, 697, 893`), `/marketplace-runs`, `/initiative-runs` (`:573, 591`) | read tier else `ManageBots`; floors | orgiq | read | `list { kind: 'bot' }`, `get` |
| "run the nightly sweep now", "run the PR bot now" | `POST /api/work/sweeps/run { sweep?, background: true }` (`:405`, floor `RunSweeps`; the page button is `DispatchAgentRun`), `POST /api/bots/:id/run` (`:776`) | `ManageBots` + stewardship and the bot's money brakes | orgiq | confirm; money | `queue_work { kind: 'sweep'|'bot-run' }` (G19, in flight) |
| "pause the PR bot", "resume it" | `POST /api/bots/:id/pause`, `/resume` (`:840, 853`) | `ManageBots` | orgiq | confirm | `update { ref: 'bot:id', fields: { paused } }` |
| "dispatch work item X to a bot with model Y" | `POST /api/bots/dispatch-work { workItemId, model, estimate, confirm flags }` (`:225`) | `DispatchAgentRun`; the route's own estimate and `confirmed` flags (`decideRunBudget`, `:302`) | orgiq | confirm; money | `queue_work { kind: 'dispatch', target: work item, model }`: the card shows the route's estimate first |
| "create a bot", "edit its mission", "delete it", "make it essential" | `POST /api/bots`, `PATCH /:id`, `DELETE /:id`, `PUT /:id/essential` (`ManageBudgets`) | `ManageBots`; `ManageBudgets` | orgiq | never: authored on the page; destructive; money policy | never |

### 2.8 Compute: the Computer Lab, paired machines, environments

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "my computers", "which computers are running", "the fleet status" | `GET /api/devbox/boxes` (`devbox.ts:463`), `/status` (`:441`) | read tier (org-leader, hr-admin, program-owner) else `ManageDevbox` (`index.ts:550-556`) | orgiq | read | `list { kind: 'computer' }`, `summary { kind: 'fleet' }` |
| "start a computer for Alpha", "a VM in each of my active projects" | `POST /api/devbox/boxes { label, projectId }` (`:546`) | `ManageDevbox` + stewardship | orgiq | confirm; money (idle billing), machine | `computer { action: 'start', initiatives }` (today `start_computer`, capped at three per card, gaps Q3) |
| "stop Alpha's computer" | `DELETE /api/devbox/boxes/:boxId` (`:592`) | `ManageDevbox` | orgiq | confirm; machine (stops billing) | `computer { action: 'stop', computer }` (**decision**: the one destructive verb voice gets, because it ends spend and the box is the caller's own) |
| "open a shell on Alpha" | `POST /api/devbox/:sessionId/shell-url` (`:1097`) through the library's `openShell` | `OpenDevboxShell` (sme, hr-admin) | orgiq | opens a tab | `computer { action: 'open-shell' }` (today `open_shell`) |
| "show the latest commits since yesterday", "run the tests" | `POST /api/devbox/:sessionId/command { command, mode: 'safe' }` (`:921`), phrases from the allowlist `GET /api/devbox/allowlist` (`:448`) | `OpenDevboxShell`; safe mode only | orgiq | confirm; machine | `computer { action: 'run', phrase, since }` (today `run_command`, G9) |
| "tell the agent on Alpha to …" | `POST /api/devbox/:sessionId/task` (`:887`), `POST /api/devbox/sessions` (`:452`) | `RunDevboxTask` | orgiq | never: free-text code execution on a machine | never |
| "my paired machines", "what are they running", "the local runs" | `GET /api/local-compute/nodes` (`local-compute.ts:984`), `/runs` (`:1378`), `/nodes/:nodeId/log` | floor `ViewLocalCompute` | orgiq | read | `list { kind: 'machine' }`, `summary { kind: 'machines' }` |
| "hand that job to my laptop" | `POST /api/local-compute/nodes/:nodeId/work` (`:1237`) | `ConnectLocalCompute` (every orgiq role) | orgiq | confirm; machine | `computer { action: 'hand-work', machine, job }` |
| "pair my machine", "unpair it" | `POST /api/local-compute/pair/start`, `/pair/claim`, `DELETE /nodes/:id` | `ConnectLocalCompute`; a pairing code | orgiq | never: a code is typed on the machine | never |
| "the environments", "where does Alpha run" | `GET /api/environments`, `/:id`, `/:id/runs` (`environments.ts:80, 88, 236`) | read tier (member, sme, org-leader, hr-admin) else `ManageEnvironments` | orgiq | read | `list { kind: 'environment' }`, `get` |
| "enter the staging environment", "add an environment" | `GET /api/environments/:id/enter`, `/access` (`:256, 165`), `POST/PATCH/DELETE` | `EnterEnvironment`; `ManageEnvironments` | orgiq | never: reaches a deployed environment; configuration | never |

### 2.9 Access

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "did my SME request get approved", "my requests", "my reports' requests" | `GET /api/access/requests?scope=mine|reports&q=` (`access.ts:303`), `/requests/:id` (`:327`); outside the tenant `GET /api/access-requests/mine?itemId=` (`access-requests-quick.ts:98`) | `ViewAccess`; floor | access; any | read | `list { kind: 'request', filter }`, `get`; today `access_request_status` |
| "show me my approvals", "what's waiting on me" | `GET /api/access/approvals` (`:337`) | `DecideAccess` (approver, access-admin) | access | read | `list { kind: 'approval' }`; today `access_request_status { scope: 'approvals' }` |
| "approve Ada's request", "reject it because …" | `POST /api/access/requests/:id/steps/:step/decide` (`:785`) | `DecideAccess` | access | confirm; people (the requester), a grant | `decide { ref: 'request:id', decision, note }` |
| "request the budgets tier", "ask for Social access", "request the SME role for Bob" | `POST /api/access/requests/preview` (`:697`) for the card, `POST /api/access/requests` (`:755`); in another tenant `POST /api/access-requests/quick` and `/envelope` (`access-requests-quick.ts:59, 79`) | `RequestAccess`; floor | access; any | confirm; people (the approvers) | `create { kind: 'access-request', item, beneficiary?, justification }` |
| "withdraw my request" | `POST /api/access/requests/:id/withdraw` (`:762`) | `ViewAccess` (own request) | access | confirm | `update { ref: 'request:id', fields: { status: 'withdrawn' } }` |
| "what can I request", "who could I request for" | `GET /api/access/catalog` (`:280`), `/beneficiaries` (`:740`) | `ViewAccess`; `RequestAccess` | access | read | `list { kind: 'catalog-item' }` |
| "delegate my approvals to Ada while I'm out", "end it" | `POST /api/access/delegations` (`:932`), `/:id/end` (`:963`), `GET /delegations`, `/delegates` | `DecideAccess` | access | confirm; people | `create { kind: 'delegation' }`, `update` |
| "the open reviews", "decide the review item" | `GET /api/access/reviews`, `/:id` (`:446, 456`), `POST /reviews/:id/items/:itemId/decide` (`:519`) | `ViewAccess`; `DecideAccess` | access | read; confirm | `list { kind: 'review' }`, `decide { ref: 'review-item:id' }` |
| "the access summary", "the audit trail", "the policies" | `GET /api/access/summary`, `/audit`, `/policies`, `/configuration` | `ViewAccess` | access | read | `summary { kind: 'access' }`, `list` |
| "start a review campaign", "override the SoD conflict", "revoke Bob's grant", "edit the policy" | `POST /reviews` (`:467`), `/requests/:id/sod-override` (`:846`), `/requests/:id/revoke` (`:872`), `PUT /policies/:id`, `/configuration` | `ManageAccessPolicy`, `ProvisionAccess` | access | never: identity grants and policy | never |

### 2.10 Approvals (HITL) and the SDLC

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "approve the pending transaction", "reject it" | `POST /api/observability/approvals/:id/decision { decision, note }` (`approvals.ts:470`; `isAllowed(session, 'ApproveTransaction', { amount })` inside) | `ApproveTransaction` with the amount: org-leader holds it, member and hr-admin are forbidden by their seeds (`member.cedar:39-41`, `hr-admin.cedar:72-77`), sme and program-owner only name it in forbids | orgiq | confirm; money | `decide { ref: 'approval:id', decision, note }` |
| "what approvals are pending" | `GET /api/observability/approvals` (`:395`) | `ViewObservability` (orgiq, all hands) | orgiq | read | `list { kind: 'hitl-approval' }` (**decision**: this one observability read is a person's inbox, so it is `list`, not never) |
| "the agent changes waiting for review", "change 12" | `GET /api/sdlc/changes`, `/:id`, `/:id/evaluations` (`sdlc.ts:225-240`) | `ManageDevbox` (floor `ViewSdlc`) | orgiq | read | `list { kind: 'change' }`, `get` |
| "approve change 12", "deliver it" | `POST /api/sdlc/changes/:id/decide` (`:254`), `/deliver` (`:381`) | `DecideAgentChange` (author refused), `DeliverAgentChange` | orgiq | confirm; code reaches a branch | `decide { ref: 'change:id', decision: 'approve'|'reject'|'deliver' }` |
| "re-review it", "address the comments" | `POST /api/sdlc/changes/:id/rereview`, `/address` (`:300, 335`) | `RunDevboxTask` | orgiq | confirm; money (an agent run) | `queue_work { kind: 'change-rereview'|'change-address' }` |
| "the SDLC policies", "approve the policy proposal" | `GET /api/sdlc/policies`, `/policy-sets/:scope`, `/policy-proposals`; the writes | reads `ManageDevbox`; writes `ManageSdlcPolicies` | orgiq | read; never | `list`; never |

### 2.11 Runbooks and briefs

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "which runbooks do we have", "read the deploy runbook", "its versions", "where was it applied" | `GET /api/runbooks`, `/:id`, `/:id/versions`, `/:id/diff`, `/:id/applications` (`runbooks.ts:266-368`, floor `ViewRunbooks`) | floor | orgiq | read | `list { kind: 'runbook' }`, `get`, `open` |
| "the runbook proposals", "accept the proposal", "reject it", "merge it" | `GET /api/runbooks/proposals`, `/:pid` (`:288, 303`), `POST /proposals/:pid/accept`, `/reject`, `/merge` (`:534, 642, 704`) | `ReviewRunbook` (sme, program-owner, org-leader) + owner or initiative scope | orgiq | read; confirm (the fleet follows it) | `list { kind: 'runbook-proposal' }`, `decide` |
| "withdraw my proposal" | `POST /api/runbooks/proposals/:pid/withdraw` (`:658`) | floor `SuggestRunbook` (own) | orgiq | confirm | `update` |
| "propose a runbook", "retire it" | `POST /api/runbooks/proposals` (`:378`, a person or a box's lab envelope), `POST /:id/retire` (`:744`) | floor; `ReviewRunbook` | orgiq | never: a proposal is a diff; retiring removes a procedure from the fleet | never |
| "run the deploy runbook" (pipelines) | `GET /api/pipelines/runbooks` (`pipelines.ts:325`), `POST /api/pipelines/definitions/:id/dry-run` (`:287`) | `ViewPipelines`; `RunPipeline` | pipelines | confirm; money | `queue_work { kind: 'pipeline' }` (G19) |
| "what brief did run X get", "the skill library", "preview the brief for this work item" | `GET /api/runs/:ref/brief`, `/skills`, `/runbooks/:id` (`session-briefs.ts:106-161`, a person needs `ViewSessionBrief`, a box signs an envelope), `GET /api/briefs` (`:92`), `/skill-library` (`:177`), `/work-items/:id/brief-preview` (`:186`) | `ViewSessionBrief` (every orgiq role) | orgiq | read | `list { kind: 'brief'|'skill' }`, `get` |

### 2.12 Budgets and spend

Money reads sit behind the budgets read tier (`readForRolesElseAction(['org-leader','hr-admin','program-owner'], 'ManageBudgets')`, `budgets.ts:41`) or a session floor whose body withholds dollars below that tier (`spend-report.ts`, `index.ts:431-435`). No money write goes by voice.

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "what have I spent this month", "my spend on Alpha" | `GET /api/me/spend` (`me-spend.ts:45`, floor `MySpend`) | floor; own figures | any | read; money | `budget { scope: 'me', initiative? }` |
| "how much has Alpha spent", "the spend report by person", "the burn" | `GET /api/spend/report?initiativeId=&groupBy=` (`spend-report.ts:72`, floor `ViewSpendReport`, shaped by the tier) | floor; dollars at the tier | orgiq | read; money | `budget { scope: 'initiative'|'org', groupBy }` |
| "Alpha's allocation", "the limits", "the envelopes", "the user budgets", "is the fleet paused" | `GET /api/budgets`, `/:orgProjectId/limits`, `/grants` (`budgets.ts:44-101`), `GET /api/grants` (`grants.ts:61`), `GET /api/user-budgets`, `/:userId` (`user-budgets.ts:56, 69`), `GET /api/sprints/envelopes`, `GET /api/ops/switches` (`ops-switches.ts`), `GET /api/devbox/profiles` | read tier else `ManageBudgets` | orgiq | read; money | `budget { scope: 'allocations'|'grants'|'users'|'switches'|'envelopes' }`; below the tier the refusal offers the quick access request (G10's pattern) |
| "the cost by agent", "cost over time", "the top spenders" | `GET /api/observability/cost/*` (`cost.ts:125-660`, nine aggregates) | `ViewObservability` (orgiq) | orgiq | read; money | `budget { scope: 'cost', view }` |
| "set Alpha's budget to …", "grant Ada an envelope", "pause the fleet", "cap Bob's spend" | `PUT /api/budgets/:id`, `/limits`, `POST/PATCH/DELETE /api/grants`, `PUT /api/ops/switches/:scope`, `PUT/DELETE /api/user-budgets/:userId`, `PUT /api/devbox/profiles/:id`, `PATCH /api/graph/projects/:id/devbox-profile`, `PUT /api/bots/:id/essential` | `ManageBudgets` | orgiq | never: money administration | never |

### 2.13 Documents and decks

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "Alpha's documents", "open the design doc", "the documents on this work item" | `GET /api/graph/projects/:projectId/workspace-documents`, `GET /api/graph/documents/:documentId` (`work-documents.ts:81, 53`), `GET /api/graph/work-items/:id/documents` (`:105`) | mount (orgiq) | orgiq | read | `list { kind: 'document' }`, `get`, `open` |
| "the knowledge tree", "open the scoring guide", "its versions", "the comments on it" | `GET /api/assessment/knowledge/tree`, `/doc`, `/doc/versions`, `/doc/comments`, `/workspace` (`assessment.ts:664-788`) | `ViewAssessment` | assessment | read | `list { kind: 'document' }`, `get`, `open` |
| "the workflow state", "who is reviewing it", "the review requests" | `GET /api/assessment/knowledge/doc/workflows`, `/review-requests`, `/reviews`, `/reviewers`, `/proposals` (`assessment-document-workflows.ts:44-66`, `assessment-document-proposals.ts:19-20`) | the document service's own policy per reader | assessment | read | `list`, `get` |
| "ask Ada to review it", "propose a change to the doc" | `POST …/doc/workflows/review-requests` (`:48`), `POST …/doc/proposals` (`assessment-document-proposals.ts:21`) | the document policy; `ManageKnowledge` for sources | assessment | confirm; people | `create { kind: 'review-request'|'document-proposal' }` |
| "accept the proposal on the doc" | `POST …/doc/proposals/:proposalId/decision` (`:24`) | the document policy | assessment | confirm | `decide { ref: 'document-proposal:id' }` |
| "new whiteboard called Flow", "make a document here" | `POST /api/graph/projects/:projectId/workspace-documents { title, kind: page \| whiteboard }` (`work-documents.ts`) | `ViewWorkItems` + the initiative's own people (owner, contributor, org-wide role; the list read's `canWrite`) | orgiq | confirm; the editor opens | `create { kind: 'document' \| 'whiteboard' }` (G55, G56) |
| "edit the doc", "publish it", "move it", "restore the old version", "comment on it", "react" | `PUT /knowledge/doc`, `/doc/publish`, `/doc/move`, `/doc/rename`, `/doc/restore`, `/doc/create`, the workflow transitions, comments and reactions, `PUT /api/graph/documents/:documentId` | `ManageKnowledge`; `ViewAssessment` for comments | assessment; orgiq | never: document content stays in the editor (**decision**: dictating into a collaborative document is an editor feature, not a navigator one; creating a blank page or whiteboard with a title is `create`, G55) | never |
| "the Alpha deck", "the decks for this team", "show the latest revision" | `GET /api/initiative-decks`, `/:id`, `/:id/revisions/:rid/spec`, `/file` (`initiative-decks.ts:64-74`, floor `ViewInitiativeDeck`; budget figures only at the tier), `GET /api/assessment/decks*` (`ViewAssessment`), `GET /api/pipelines/decks*` (`ViewPipelines`), `GET /api/chat/decks*` (owner only) | floors and tenant views | orgiq, assessment, pipelines, social | read | `list { kind: 'deck' }`, `get`, `open` |
| "build a status deck for Alpha", "a deck for this team", "a deck for run 42", "revise it: shorter" | `POST /api/initiative-decks/projects/:projectId` (`:57`), `POST /api/assessment/teams/:teamId/decks` (`assessment-decks.ts:45`), `POST /api/pipelines/runs/:id/decks` (`pipeline-decks.ts:44`), `POST …/decks/:id/revise`, `POST /api/chat/commands/deck/run` (`social-deck.ts:101`) | the run gate per tenant | orgiq, assessment, pipelines, social | confirm; money (an agent builds it) | `queue_work { kind: 'deck', target }` (in Work also `scope: 'this-page'` and `focus`, the user's words as the deck's brief; `create { kind: 'deck' }` is the same path, G55) |
| "post the deck to #platform" | `POST /api/chat/decks/:id/post` (`social-deck.ts:224`) | `PostMessage` + owner | social | confirm; people | `update { ref: 'deck:id', fields: { post: channel } }` |
| "save the revision", "preview it" | `POST …/decks/:id/revisions`, `/preview` | the editor | all | never: editor saves | never |

### 2.14 Assessment

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "which teams are below target", "team Falcon's scorecard", "its evidence", "its exceptions", "the recommendations", "the program rollup" | `GET /api/assessment/teams`, `/:id`, `/:id/evidence`, `/:id/exceptions`, `/:id/recommendations`, `/:id/stories`, `/:id/provenance`, `/:id/scoring-logs` (`assessment.ts:115-230`), `/rollup` (`:341`), `/dimension-index`, `/recommendations` | `ViewAssessment` (all three roles) | assessment | read | `list { kind: 'team' }`, `get`, `summary { kind: 'rollup' }`, `search` |
| "the open follow-ups", "resolve the follow-up for Falcon", "dismiss it", "add a follow-up: …" | `GET /api/assessment/feedback`, `/:taskId` (`:348, 360`), `POST /feedback/:taskId/resolve`, `/dismiss` (`:366, 374`), `POST /feedback` (`:353`) | `ViewAssessment`; `ScoreAssessment` | assessment | read; confirm | `list { kind: 'feedback' }`, `update`, `create { kind: 'feedback' }` |
| "approve the N/A exception on Falcon's security dimension" | `PATCH /api/assessment/teams/:id/exceptions/:dimensionId` (`:185`) | `ApproveException` (lead-assessor, program-lead) | assessment | confirm | `decide { ref: 'exception:team/dimension' }` |
| "the runs", "what is the scorer doing", "the pipeline runs" | `GET /api/assessment/runs`, `/:runId` (`:388, 426`), `/pipeline-runs` (`:398`), `/agent/commands` (`:416`) | `ViewAssessment` | assessment | read | `list { kind: 'run' }`, `get`, `summary` |
| "run the scorer on Falcon", "draft the evidence summary for the security dimension", "draft follow-ups" | `POST /api/assessment/runs` (`:402`), `POST /teams/:id/dimensions/:dim/drafts/evidence-summary`, `/followups` (`assessment-drafts.ts:70-71`) | `RunAssessmentAgent` | assessment | confirm; money | `queue_work { kind: 'assessment-run'|'draft' }` |
| "stop the run", "accept the draft", "discard it", "revise it: …" | `POST /runs/:runId/stop` (`:420`), `POST /drafts/:runId/accept` (`ScoreAssessment`), `/discard`, `/revise` (`assessment-drafts.ts:87-126`) | `RunAssessmentAgent`; `ScoreAssessment` | assessment | confirm (accept writes follow-ups into the team) | `update`, `decide { ref: 'draft:id' }` |
| "publish Falcon's report" | `POST /api/assessment/reports/publish` (`:493`) | `PublishReport` (lead-assessor, program-lead) | assessment | confirm; people read it | `update { ref: 'team:id', fields: { publish: 'report' } }` |
| "the submissions", "what's in Falcon's envelope" | `GET /api/assessment/submissions`, `/:team/:envelope` (`:541, 646`) | `ViewAssessment` | assessment | read | `list { kind: 'submission' }`, `get` |
| "score Falcon", "apply the scores", "intake this text", "parse the envelope", "commit it", "reset the assessment", "delete the team", "change the target level" | `POST /teams/:id/scores/apply`, `/intake/*`, `/reset-assessment`, `/submissions/parse`, `/commit`, `/clear`, `DELETE /teams/:id`, `PUT /configuration` | `ScoreAssessment`, `ManageSubmissions`, `ManageAssessmentConfig` | assessment | never: form work with a visible result, destructive, or configuration | never |

### 2.15 Pipelines

| a person says | route(s) | Cedar | tenant | kind, involves | v2 |
|---|---|---|---|---|---|
| "what failed last night", "the queues", "the pipelines summary" | `GET /api/pipelines/runs?status=` (`pipelines.ts:191`), `/queues` (`:58`), `/summary` (`:67`); the index answers "failed" as `run` with `status: failed` (`search-index/pipelines.ts:207`) | `ViewPipelines` | pipelines | read | `summary { kind: 'pipelines', since }`, `search`, `list { kind: 'run', filter: { status } }` |
| "run 42", "its steps", "the artifacts", "the definitions", "the nightly definition" | `GET /api/pipelines/runs/:id`, `/:id/steps`, `/:id/events` (`:192-194`), `/artifacts` (`:195`), `/definitions`, `/:id` (`:247, 255`) | `ViewPipelines` | pipelines | read | `get`, `list { kind: 'artifact'|'definition' }` |
| "what's waiting on me", "approve the step on run 42", "reject it" | `GET /api/pipelines/approvals` (`:338`), `POST /approvals/:id/decide` (`:343`) | `ViewPipelines`; `ApproveStep` (operator, pipeline-admin) | pipelines | read; confirm | `list { kind: 'approval' }`, `decide { ref: 'step-approval:id' }` |
| "cancel run 42" | `POST /api/pipelines/runs/:id/cancel` (`:357`) | `CancelRun` (operator, pipeline-admin) | pipelines | confirm | `update { ref: 'run:id', fields: { status: 'cancelled' } }` |
| "dry-run the deploy runbook" | `POST /api/pipelines/definitions/:id/dry-run` (`:287`) | `RunPipeline` + the dry-run's money brakes (`decideDryRunGate`, `:233`) | pipelines | confirm; money | `queue_work { kind: 'pipeline' }` (G19) |
| "set the approvers on the definition", "change the configuration" | `PUT /definitions/:id/approvers` (`:275`), `PUT /configuration` (`:371`) | `AuthorDefinition`; `ManagePipelineConfig` | pipelines | never: authoring and configuration | never |

### 2.16 Knowledge, ingestion and connections

All reads here are the Knowledge page's operational visibility (org-leader, hr-admin read tier else `ManageKB` / `ManageIngest`, `index.ts:313, 396`) and every write reaches S3, a knowledge base, a crawler or a credential. What a person actually asks for ("find the onboarding doc") is answered by the `knowledge` type of `GET /api/search`, which is indexed from the same documents. **decision**: voice gets `summary { kind: 'ingest' }` over `GET /api/ingest/jobs`, `/stats`, `/queue` and `GET /api/admin/kb-registry/health` for "did the ingest run", and nothing else in this family; crawls, syncs, schedules, uploads, connections and the public drop are never by voice (61 of 69 rows). `GET /api/library` and `/library/:id` (the Agent library of prompts, evaluators, skills and insights, floor `ViewLibrary`) are reads a person asks for and go to `list { kind: 'library' }`; `rediscovery` is agent-facing and stays out.

### 2.17 Org: roster, org chart, scores

`GET /api/roster` and `/roster/users` (`roster.ts:51, 71`, floor `Roster`) are the pick-lists the sprint and grant forms use: `list { kind: 'person' }` in orgiq. `GET /api/graph/people/:personId` and `/evidence` (`graph.ts:46, 55`, `ViewOrgChart`, every orgiq role) are the person detail behind the search page's connections tab: `get { ref: 'person:id' }`, which is also what `open_result` lands on today. The graph renders (`/entities`, `/skills-graph`, `/projects-graph`, `/help`) and the leaderboard (`/api/scores/*`, `ViewLeaderboard`, org-leader and hr-admin, `index.ts:304`) are pages, never by voice: ranked people data is leadership data and a spoken leaderboard is the wrong surface (**decision**).

### 2.18 Observability

126 rows, all behind `ViewObservability` plus the orgiq tenant (`index.ts:192`), writes behind `ManageCanary`, `EditGuardrail` or `LabelFeedback`. Two things a person asks for by voice: "is the fleet healthy" (`GET /api/observability/summary`, `observability.ts:108`, `summary { kind: 'health' }`) and the HITL inbox (§2.10). Everything else (canary weights, prompt pointers, judge configuration, calibration, memory, harness runs, guardrail rules, browser and code-interpreter sessions, traffic, drift, invocation replay) is an operator console: `open` the page, never act in it by voice.

### 2.19 Identity and session

Never by voice, reads included: `/api/identity/*` (users, grants, Cedar policies, schema; `ViewIdentityAdmin`, `ManageUsers`, `EditPolicy`, `EditSchema`), `/api/session/login|role|tenant|masquerade|logout|revoke-others` (every one ends or changes the session the voice was minted in; spec §2), `/api/auth/*`. The session reads (`/me`, `/person`, `/capabilities`, `/users`, `/realtime-token`) and `GET /api/social/plane/capabilities` (`social-plane.ts:85`) are what the shell reads before the dock exists; they are n/a, not tools.

### 2.20 Notifications

There is no notifications route in the middleware: the bell and the toasts are the gateway's (`useNotifications` in `@connorhoehn/realtime-modules/client`, G19's toast design). "What did I miss" is `activity { scope: 'recent' }` over the social index, `GET /api/discussions/unread` and `GET /api/today`; a queued job's progress is G19's toast. **fact**

## 3. Catalogue v2

**decision**: the smallest set of typed, generic tools that reaches every row §2 marks read, confirm or open, built on the owner's rule that intents are "searches in the backend and activities in the social app" (spec §4): every read is a facade over an existing route, every action goes through the route the page's button calls and is gated by that button's Cedar action, and the dock composes nothing the model dictates (no free paths, no free commands, no free prompts to agents). Fifteen tools replace sixteen; the generic ones take a `kind` whose enum is rendered per tenant by `toolsForTenant` the way `navigate`'s pages and `search_records`' types already are (`toolsForTenant`, `catalogue.ts:516-530`).

| v2 tool | arguments | backing | confirm | tenants | replaces | routes reached |
|---|---|---|---|---|---|---|
| `search` | `{ query, scope?: 'workspace' or an initiative id, type?: the tenant's index types, sort?: relevance or recent, limit?: 1..10, answer?: boolean }` | search | no | all five | `search_people`, `search_records`; adds `/answer` and `type: person` as a type | 14 |
| `open` | `{ page?: a pageId, ref?: 'kind:id' or a kept row's ref or an ordinal, params? }` | route | no | all five | `navigate`, `open_result`, `open_computer_lab` | every page (109), every record with an href |
| `list` | `{ kind, filter?: { status, initiative, person, since, scope, q }, limit? }` | search | no | all five (kinds per tenant) | `list_active_initiatives` | 126 |
| `get` | `{ ref: 'kind:id', part?: 'steps' | 'members' | 'history' | 'evidence' | … }` | search | no | all five | nothing (new) | 99 |
| `summary` | `{ kind: 'sweeps' | 'work' | 'fleet' | 'machines' | 'pipelines' | 'rollup' | 'access' | 'ingest' | 'health' | 'today' | 'unread' | 'live', since? }` | search | no | per kind | `bot_sweep_status` | 25 |
| `activity` | `{ scope, since?, who? }` | social-activity | no | orgiq, social | itself (G6) | the social index, the roster |
| `budget` | `{ scope: 'me' | 'initiative' | 'org' | 'allocations' | 'grants' | 'users' | 'switches' | 'envelopes' | 'cost', ref?, groupBy? }` | search | no | orgiq (`me` everywhere) | nothing (new) | 21 |
| `message` | `{ target: { kind: 'team' | 'channel' | 'dm', name }, text }` | social-activity | yes | orgiq, social | `send_chat_message` | the resolver, the DM open, the gateway |
| `set_status` | `{ status, message? }` | social-activity | no | orgiq, social, assessment, pipelines (`presenceLobby`) | itself (G10) | the presence socket |
| `call` | `{ target, action: 'start' | 'join' }` | social-activity | yes | orgiq, social | `start_call`; adds join | the resolver, the call host |
| `computer` | `{ action: 'start' | 'stop' | 'open-shell' | 'run' | 'hand-work', initiatives?, computer?, phrase?, since?, machine?, job? }` | work | yes, except `open-shell` | orgiq | `start_computer`, `open_shell`, `run_command`; adds stop and hand-work | 5 |
| `queue_work` | `{ kind: 'sweep' | 'bot-run' | 'pipeline' | 'job' | 'dispatch' | 'finding-promote' | 'finding-analyze' | 'assessment-run' | 'draft' | 'deck' | 'summarize' | 'diagram' | 'doc' | 'agent-plan' | 'change-rereview' | 'change-address', target, note?, model? }` | work | yes | per kind | G19's three kinds | 28 |
| `decide` | `{ ref, decision: 'approve' | 'reject' | 'deliver' | 'accept' | 'discard' | 'promote' | 'dismiss', note? }` | work | yes | per kind | nothing (new) | 28 |
| `create` | `{ kind: 'access-request' | 'work-item' | 'comment' | 'saved-search' | 'sprint' | 'channel' | 'team' | 'room' | 'delegation' | 'feedback' | 'document-proposal' | 'review-request', fields }` | work | yes | per kind | nothing (new) | 21 |
| `update` | `{ ref, fields }` with one field set per kind (status, assignee, sprint, pinned, member, read, withdrawn, paused, cancelled, reviewed, requeued, publish, post, muted) | work | yes | per kind | nothing (new) | 33 |

`confirm` stays an internal row (the dock's card, `INTERNAL_TOOLS`, `catalogue.ts:491`). `runbook(run)` from the brief is not a tool: a runbook has no run route in orgiq (it is a procedure the fleet reads, `routes/runbooks.ts`), and in pipelines "run the runbook" is `queue_work { kind: 'pipeline' }`; reading one is `get`, judging a proposal is `decide`.

**The confirm rule** (spec §2, kept literally): anything that spends money, runs on a machine or reaches other people shows the card first and nothing happens until the user confirms by voice or click. That is every `queue_work` (an agent run bills), every `decide` (someone is waiting on it and a grant, a branch or a follow-up results), every `create` and `update` (another person sees the record change; the cheap own-state ones, mark read and mute, keep the card because the cost of a card is lower than the cost of a wrong write), `message`, `call`, and `computer` start, stop, run and hand-work. Reads, `open`, `set_status` and `computer open-shell` never ask. The card names the route's own figures where it has them: the dispatch estimate (`bots.ts:302`), the dry-run gate (`pipelines.ts:233`), the request preview (`access.ts:697`), the batch of computers (gaps Q3).

**Never by voice** (368 rows): destructive admin (every `DELETE` except stopping the caller's own computer and unpinning); identity, grants, Cedar policies and schema; tenant configuration, SoD overrides, revokes and review campaigns; money administration (allocations, caps, grants, kill switches, policy profiles, essential bots); observability administration (canary, pointers, judges, calibration, memory, harness, guardrails, browser and interpreter sessions, replay); knowledge, ingestion, connections and uploads; document and deck content (`PUT` a document, save a revision, editor comments, workflow transitions); free-text agent tasks on a machine (`/task`, `/sessions`, `/agent-projects/:id/runs`), full-mode commands, machine pairing; environments; bot and definition authoring; adding or removing other people from teams, sharing or deleting recordings; session switches; anything under `/internal`, the node-token loop, the lab envelopes and the agent callbacks; the dev planes. The reasons are the rule notes in `V2_RULES` and are printed per row in the JSON.

**Per tenant** (`toolsForTenant`): orgiq is offered all fifteen; social `search`, `open`, `list`, `get`, `summary`, `activity`, `budget { scope: 'me' }`, `message`, `set_status` (no lobby, so Social's presence), `call`, `queue_work` (conversation kinds and decks), `decide` (agent plans), `create` (channel, team, room, saved search), `update`; assessment, pipelines and access get `search`, `open`, `list`, `get`, `summary`, `budget { me }`, `queue_work`, `decide`, `create`, `update` with their own kinds, plus `set_status` where the manifest has a lobby and the plane's `activity` where the plane is embedded (orgiq, assessment, pipelines). The gaps document's Q1 ("reads and navigation only outside orgiq and social") widens here to the tenant's own confirmed actions, because every one of them is the tenant's page button behind the same Cedar action (**decision**).

## 4. Disambiguation, and how the inventory stays current

**Refs.** The model never passes a path, an href or a command; it passes what the user said (`target.name`, `initiatives: ['Alpha']`, `ref: 'the first one'`) or a ref the dock handed it. Refs are typed, `kind:id` (`person:p-12`, `initiative:alpha`, `request:r-9`, `run:42`), as `open_result` already takes them (`catalogue.ts:314-323`); ordinals name a row of the last result set the dock kept for the session; a spoken name goes through the kind's own resolver (the Social resolver `GET /api/social/resolve?kind=&name=`, `social.ts:361`; the initiatives list for computers, `actions.ts:187`; `list { kind, filter: { q } }` for everything else). One match runs; several return `ambiguous` with up to ten candidates cut to 120 characters (`tools.ts:253`, the shape `docs/voice-navigator-gaps.md` §2.5 describes) and the dock shows them as a choice card the user answers by voice or click (the library primitive §5 names); none returns `refused` with the nearest page. Every candidate list is drawn from a read the same persona could make (the G14 property), so a refusal never names a row the user could not see.

**Tenant.** Fixed at mint (`routes/voice.ts`); every kind enum is the tenant's own; a request for another workspace opens `/workspaces` and ends the session (spec §6). The plane's reads carry their own grant check (`socialGate` with the directory's current grants), so an orgiq member without Social hears the access-request offer, not a 403 (G10).

**Staying current.** `node scripts/voice/inventory.mjs --check` is the test. It fails when a route a person can reach is a write and no rule in `V2_RULES` decides it (covered by a tool, confirm, or never), and when `docs/voice-tool-inventory.json` differs from what the sources produce, so a new route, a changed gate, a new pageId or a catalogue change all show up as a red step until someone decides and regenerates. It runs in under a second with no dependencies, so it belongs beside the middleware's `npm test` step in `.github/workflows/ci.yml` and in the wire snapshot's own refresh (the snapshot is what it reads; the 26 duplicate rows are the capture attributing each two-mount router's declarations to both mounts, which the generator de-duplicates and the capture should stop doing). **Since V2-15 (8 November)** that is how it works: `coveredBy` is the catalogue's tools whose `mapsTo` names the route, and a covered route's decision is derived from it (a GET is `read`; a write is `confirm` when its tool confirms, `open` when the call reaching it skips the card, as `computer`'s open-shell does, `read` when its tool never confirms). `V2_RULES` holds no read, confirm or open rule: only `never`, `n/a` and `not-yet`, the last being §3's plan for a route no tool reaches yet, with the tool that would. The check fails on an undecided route a person can reach, on a rule table that decides read, confirm or open, and on a route a tool reaches that the never list names. Figures at that commit: 798 routes a person can reach; 229 reached by a tool's `mapsTo` (160 read, 68 confirm, 1 open), 174 not yet, 371 never, 24 not for people; 109 of 109 pages through `open`. The tool tenants are read from the catalogue's own constants (`PEOPLE_TENANTS`, `ACTIVITY_TENANTS`) and literal lists whole.

## 5. Packages

One agent per package, one repository each, provable without AWS (`npm run dev:mock`, `MOCK_VOICE=1`, the harness in `portal/src/lib/voice/__tests__/voiceHarness.ts`). Money, authorization and code execution go to Opus; the rest to Sonnet. Nothing edits `middleware/src/lib/voice/catalogue.ts`, `routes/voice.ts` or `portal/src/lib/voice/*` until G19 has landed; the library packages and V2-1 can start now.

**Tier 0, the library (ui-components, one release)**

| id | what | files | model | done when | hours |
|---|---|---|---|---|---|
| V2-L1 | `VoiceChoiceCard`: up to ten candidates with ordinals, a title per row and a secondary line, chosen by click or by the voice saying the ordinal; the `ambiguous` payload's shape | `src/components/voice/VoiceChoiceCard.tsx`, stories, `COMPONENT_INDEX.md` | Sonnet | a story with three and ten rows; a test that `onChoose(index)` fires from click and from an `ordinal` prop | 3 |
| V2-L2 | `VoiceConfirmCard` gains `fields` (a decision toggle approve or reject, a one-line note) and `detail` as a list, for `decide`, `create` and the dispatch estimate | `VoiceConfirmCard.tsx`, stories | Sonnet | a `Decide` story; the confirm callback carries `{ decision, note }`; existing stories unchanged | 2 |

**Tier 1, the inventory and the shape (aws-agentcore)**

| id | what | files | model | done when | hours |
|---|---|---|---|---|---|
| V2-1 | the check in CI: `node scripts/voice/inventory.mjs --check` beside the middleware tests; fix the capture's double attribution of two-mount routers (26 duplicate rows) and retake the snapshot after G19 | `.github/workflows/ci.yml`, `middleware/src/mock/core/wire/snapshots/*` | Sonnet | the step is green on main and red on a branch that adds `POST /api/x` with no rule | 1 |
| V2-2 | a `pageId` on all 109 palette rows and `NAVIGATE_PAGES` generated from them (spec §4's P3 debt), per tenant through `isPageVisible` | `portalCommands.ts`, `catalogue.ts` both halves | Sonnet | `open { page }` enum equals the visible pages for every tenant and role; the inventory shows 109/109 | 2 |
| V2-3 | `search`: merge `search_people` and `search_records`, add `/answer` and `type: person`, keep the per-tenant type enum | `catalogue.ts` both halves, `tools.ts` | Sonnet | the five mock sessions search through one tool; "who decided X" returns the `/answer` fact in orgiq | 3 |
| V2-4 | `open { ref }`: typed refs over a per-tenant href table (person, initiative, request, run, team, channel, computer, document, deck), kept rows and ordinals, `ambiguous` through V2-L1 | `tools.ts`, `catalogue.ts`, `VoiceFooterPane.tsx` | Sonnet | "open Alpha" opens `/iq/projects/<id>` in one step; a foreign href is refused; two Alphas show the choice card (after V2-2, V2-L1) | 3 |

**Tier 2, the reads**

| id | what | files | model | done when | hours |
|---|---|---|---|---|---|
| V2-5 | `list` and `get`: one kind table per tenant (kind, route, filter params, shaping to title, subtitle, href, ref) covering §2's read rows; the enum rendered per tenant | `portal/src/lib/voice/kinds.ts` (new), `tools.ts`, `catalogue.ts` | Sonnet | a table test that every kind's route is in the inventory JSON with decision `read`; the mock sessions list requests, runs, teams and channels | 6 |
| V2-6 | `summary`: `bot_sweep_status` generalised over the §2 aggregates with `since` parsing shared with `activity` | `tools.ts`, `catalogue.ts` | Sonnet | "what failed last night" answers in orgiq and pipelines from fixtures; "is the fleet healthy" reads `/api/observability/summary` | 4 |
| V2-7 | `budget`: the money reads, the tier's refusal turned into the quick access request offer (G10's hint shape), dollars never invented below the tier | `tools.ts`, `catalogue.ts` | Opus | a member hears their own spend and the offer; a program-owner hears Alpha's; no figure in a refusal payload | 3 |

**Tier 3, the actions (after G19 has landed)**

| id | what | files | model | done when | hours |
|---|---|---|---|---|---|
| V2-8 | `computer`: merge the three machine tools; add `stop` (the caller's own box) and `hand-work` (`POST /api/local-compute/nodes/:nodeId/work`) | `actions.ts`, `machine.ts`, `catalogue.ts` | Opus | stop asks and ends the box; hand-work asks and the job shows on the machine's log; the phrase table is unchanged | 4 |
| V2-9 | `queue_work` kinds: job, dispatch (with the route's estimate on the card), finding promote and analyse, assessment run and drafts, decks, the conversation commands, change re-review and address; the toast per kind | `work.ts`, `catalogue.ts`, `VoiceFooterPane.tsx` | Opus | each kind's mock run moves the toast queued, running, done; cancel sends nothing; every route is one the page's button calls | 6 |
| V2-10 | `decide`: access steps and review items, pipeline steps, HITL approvals with the amount, SDLC decide and deliver, runbook and work proposals, agent-loop plans and approval steps, exceptions, drafts, document proposals, designs, consults, promotions, through V2-L2's card | `actions.ts`, `catalogue.ts` | Opus | an approver's mock session approves a request; an author's decide on their own change is refused by the route and spoken as such; a reject carries the note | 6 |
| V2-11 | `create` and `update`: the kinds in §3's table with one field set per kind; the card shows the preview where the route has one | `actions.ts`, `catalogue.ts` | Sonnet | a requester files a request from the catalogue by voice; a work item moves to in progress; join and leave a channel; nothing is sent without `PostMessage` where the route asks for it | 6 |
| V2-12 | `call { action: 'join' }` and the renames (`message`, `call`); `set_status` offered where `presenceLobby` is true; `activity` unchanged | `actions.ts`, `catalogue.ts`, seeds unchanged | Sonnet | join enters the live huddle the index shows and is refused while already in a call; the four tenants with a lobby set status | 2 |
| V2-13 | per-tenant offering, instructions and `MOCK_CALLS` for v2; `voiceInstructions` lists the fifteen tools under the 20,000-character cap | `catalogue.ts` both halves, `routes/voice.ts` tests | Sonnet | `toolsForTenant` offers §3's per-tenant sets; every tenant's scripted session runs one v2 call end to end | 2 |

**Tier 4, hardening and notes**

| id | what | files | model | done when | hours |
|---|---|---|---|---|---|
| V2-14 | the two-persona property test (G14's pattern) over every v2 planner and runner: no `refused`, `ambiguous` or `failed` payload names a row the persona's own read would not return | `portal/src/lib/voice/__tests__/` | Opus | green over the mock fixtures for all five tenants and two roles each | 3 |
| V2-15 | `coveredBy` derived from v2's `mapsTo`, the rule table reduced to the never list, spec §4 replaced by a pointer to this document, spend-map and the gaps document updated | `scripts/voice/inventory.mjs`, `docs/voice-navigator-spec.md`, `docs/voice-navigator-gaps.md`, `docs/spend-map.md` | Sonnet | the check passes with no `read`/`confirm` regexes left; the spec names fifteen tools | 2 |

**Landed (8 November).** V2-13: the per-tenant sets are pinned in the middleware catalogue test (§3 less Social's `decide`, assessment and pipelines `create`, access `queue_work` and `activity`, each for the reason the catalogue states; `activity` added to assessment and pipelines through the plane), every scripted call is a v2 call, every tenant's instructions list each offered tool under the cap, and `access_request_status` stays (no list kind reaches `GET /api/access-requests/mine` outside Access). V2-14: the two-persona property runs for all five tenants, two roles each, pinned per tool and per `queue_work` kind (`portal/src/lib/voice/__tests__/visibilityTenants.test.ts`, `personaProperty.ts`). V2-15: §4 above; the spec's §4 has a row per tool and points here.

Order: V2-L1 and V2-L2 in parallel with V2-1 now; V2-2 then V2-3 and V2-4 in one agent (they share `catalogue.ts` and `tools.ts`); V2-5, V2-6, V2-7 serially in a second agent once V2-4 is in; tier 3 after G19 lands, V2-8 and V2-9 in one Opus agent (both in `actions.ts`/`work.ts`), V2-10 and V2-11 in another, V2-12 and V2-13 last; V2-14 and V2-15 close. About 58 agent-hours, five of them in the library.

## 6. Coverage (10 November)

Seven capabilities were added without a new tool name: work items, budgets and spend, agent runs, sprint questions, decisions, the review queue, and runbooks and ADRs. `docs/voice-navigator-gaps.md` ("Coverage (10 November)") says what each one answers. The regenerated JSON:

| | before | after |
|---|---|---|
| routes covered by `mapsTo` | 233 | 236 |
| pages covered | 109 of 109 | 109 of 109 |
| not yet | 174 | 171 |
| never | 369 | 369 |
| undecided | 0 | 0 |

The route count moves little because most of the new answers read routes that were already listed (`GET /api/spend/report`, `GET /api/graph/work`, `GET /api/sprints`, `GET /api/lab/consults`, `GET /api/runbooks/:id`). The work is new kinds, parts, filters and page context on those routes. The newly covered routes are the work item owner and sprint writes (`PATCH /api/sprints/:sprintId/items`, `DELETE /api/sprints/:sprintId/items/:itemId`) and the Agents tab's `GET /api/bots/initiative-runs`.

**The next nine "not yet", by value.** Each one fits an existing tool.

1. `decide` on the conversation agent's waiting plans (`GET /api/conversations/agent/waiting`, `.../runs/:id/approve`, `/discard`, `/approval/approve`, `/approval/reject`): "what is the agent in this channel waiting on me for".
2. `create` a comment on an initiative's discussion (`POST /api/graph/projects/:id/discussion/comments`): "tell the Auth Migration thread the rehearsal passed".
3. `decide` on a design question (`POST /api/designs/:id/answer`): answer a design thread's question by voice, the same way a consult is answered.
4. `budget` grants and run caps (`GET /api/grants?sprintId=`, `GET /api/budgets/:orgProjectId/limits`): who holds the envelopes on a sprint, and what the per-run cap is.
5. `list` and `update` for chat pins (`GET`, `POST` and `DELETE /api/chat/pins`): "pin that" and "what's pinned here".
6. `decide` to merge or withdraw a runbook proposal (`POST /api/runbooks/proposals/:pid/merge`, `/withdraw`).
7. `budget` cost breakdowns (`GET /api/observability/cost/by-model`, `/top`, `/per-agent`): "which model cost the most this week".
8. `list` of marketplace runs across initiatives (`GET /api/bots/marketplace-runs`): "what did the agents run today".
9. `list` and `get` for call history (`GET /api/calls`, `GET /api/calls/:callId/chat`): "who called me" and "what was said in that call's chat".
