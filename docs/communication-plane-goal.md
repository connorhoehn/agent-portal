# Goal: Communication is the Social tenant, seen from where you work

`scripts/validate-communication-plane.sh` is the only judge. It exits 0 only
when every mechanical check passes and prints every failing line. Work the
lanes below; run the judge after every slice.

## The user's statement (2026-10-07)

> Communication should be `http://localhost:5183/iq/communication`, a
> representation of the social tenant for enabled users. Like you should be
> able to see your team and initiative groups, the realtime-modules
> "Active now" style thing of people, and see the work they have shared
> (graphs) etc.

Plus, same day: clicking the footer's **Social** takes you to the current
tenant's Communication page when you are enabled there (to the Social tenant
itself when you are in it); huddles render as the confirmed mockup (call bar +
participant tiles above the one conversation composer); detail opens in the
far-right pane; the cascade in `docs/layout-cascade.md` applies.

## Definition of done

`/iq/communication` (and `/assessment/communication`, `/pipelines/communication`)
is the Social tenant's own workspace (`SocialChatWorkspace`, one component,
two mounts — `docs/social-tenant-design.md` §4.6) **shaped by the signed-in
user's org context**. "Enabled" means the current session holds a Social
grant; everyone else gets the existing `communication-no-social` empty state
and makes zero `/api/social` requests.

### 1. Rail (one flush list rail, library `ConversationRail`)

Order, top to bottom, every section built from the installed composites:

1. **Shelf** — Activity, Mentions, Calls (page huddles + Social log), Recordings. Unchanged.
2. **Active now** — `ActivePeopleGrid` over the shell's single presence roster
   (`EmbeddedSocialProvider.presencePeople`, `social:lobby`), each person
   enriched by `GET /api/social/plane/active`: `status`, `inCall` (a live
   huddle the viewer may see), `activity` (the person's latest work-graph
   node the viewer may read: "editing Migration plan", "in a huddle on Auth
   Migration", "ran orgiq-auth-service checks"), `workSharing`
   (`{state:'active'|'historical', fresh}` from sharing grants the viewer is
   an audience of). Tile → DM; `onSelectSharedWork(userId)` → that person's
   **shared work** (§3). Never a second presence subscription.
3. **My initiatives** (orgiq) / **My teams** (assessment) / **My pipelines**
   (pipelines) — the groups the user belongs to in the host tenant:
   one route, one shape — `GET /api/me/groups?kind=initiative|assessment-team|pipeline`
   (middleware `lib/mine.ts`, the `MineReply` contract): orgiq the initiatives
   the linked person owns or contributes to, assessment the teams the assessor
   holds a membership row on (`assessment_team_members`, never a display-name
   match), pipelines the definitions the author owns or last recorded. Each row shows the group's bound Social
   channel (`social_bindings`, `ChannelBindingView`) when one exists, its
   page-discussion unread (`GET /api/discussions/unread`), and a live-call
   dot. Row → the bound channel's conversation; unbound → the page
   discussion thread for that group rendered in the plane (same chat family,
   `orgiq:initiative:<id>` etc., under its page read gate) with a
   "Bind a Social channel" action for `ManageChannels` holders (the existing
   binding model, `ChannelBindingStrip`). An account with no linked person
   gets one honest row: "Link your account to a person to see your groups"
   (admins link it at `/admin/identity/users`).
4. **My org teams** (orgiq only) — org-graph teams of the linked person:
   `GET /api/me/groups?kind=org-team` → the same `MineReply`, each item with
   its `members:[{userId, personId, name}]` (members resolve to app users
   where linked, so presence can overlay). Row → the team's Social
   team (a `social_bindings` row with `context_kind='team'`, new
   `BINDING_CONTEXT_TENANT.team='orgiq'`) when bound, else a team view in the
   content column: members with presence, the team's shared work (§3), and
   "Create team channel" for `ManageTeams`.
5. **Teams** (Social teams tree), **Rooms**, **Direct messages**, **Channels** — unchanged.

### 2. Conversation surface

Chat | Documents | Pinned | Calls as today, plus **Shared work**
(`?view=shared`): everything shared INTO this conversation — page references
(`metadata.pageReference`), deck shares (`metadata.sourceDeck`), documents and
files (`GET /api/uploads?channel=`), and the conversation's work graph
(`/api/social/plane/work-graph/conversations/:id/graph`, the same provider as
Social's `?view=graph`, mounted on the plane) — as the library `WorkGraph`
with a `RowList size="sm"` of the shared items beneath, each resolved through
the existing reader-authority resolvers (`/api/social/dms/page-reference`,
`/api/page-references/resolve`) and opening in the far-right pane first
("Open page" on demand). Hidden/`unavailable` items stay unavailable; nothing
is resolved client-side from a stored title.

### 3. Shared work (people)

"The work they have shared": a person's shared-work graph is
`GET /api/social/plane/people/:userId/shared-work` → the person's work-graph
subject (`/api/work-graph/people/:id/graph` provider) filtered with the
library's `filterForViewer` against **sharing grants** (realtime-modules
`work-graph` `createSharingGrant`/`transitionSharingGrant`, persisted in the
registered mock fixture `social-work-sharing` under `MOCK_AURORA`, in Dynamo
when the chat store is Dynamo) plus the implicit grant "referenced in a
conversation the viewer is a member of". A person shares work from the work
graph's existing share affordance (`onRequestCollaboration`/share → a grant
with audience = a conversation or a team); revoking transitions the grant;
history grants keep what was shared before revocation visible as
`historical`. Owner always sees everything of their own. Nothing else widens:
a viewer with no grant and no shared conversation gets an empty graph, not 403.

### 4. Shell

- Footer **Social** → `/<tenant>/communication` (current context opened) for
  enabled users, `/social/channels` inside Social, the panel otherwise; ↗ is
  the tenant switch.
- Huddles on every conversation composer render the confirmed mockup
  (`HuddleBar` phases + tiles above the one composer; footer compact status).
- Detail (person, initiative, team, shared item, log) opens in the far-right
  pane; "Open page" navigates. Primary rail folds at depth 3+ (pane open or
  record selected), section rail stays.

### 5. Authority (non-negotiable)

- Every plane read is a Social handler re-gated on the actor's CURRENT Social
  grants (`currentSocialActionSession`), or a host-tenant route under its own
  gate; the session never leaves its source tenant; `requireTenant('social')`
  and the gateway guards are unchanged.
- "Mine" derives from `app_users.person_id` on the server; the body is never
  trusted for identity.
- Person-scoped reads (`active`, `shared-work`) are filtered per viewer on the
  server; the client receives only what it may show. Epoch bump, revoked
  grant, forged tenant/role and cross-tenant forgery each refuse (jest).

### 6. Mock floor

Registered fixtures only (`social-work-sharing`, org teams in the org fixture,
presence activity derived from existing work-graph rows), timestamps from
`mock/core/clock.ts`, counts derived from rows; snapshots recaptured with the
repo's capture scripts; budgets never raised.

## Judge (`scripts/validate-communication-plane.sh`, `--quick` skips jest/build/browser)

1. Routes exist and are tested: `/api/social/plane/active`,
   `/api/social/plane/people/:userId/shared-work`,
   `/api/social/plane/work-graph/conversations/:id/graph`,
   `GET /api/me/groups?kind=` (the one "mine" reader, `lib/mine.ts`; the
   retired per-tenant readers must stay gone), `social_bindings` `team` kind;
   `validate-route-coverage.sh` stays green. Both Social mounts and the
   bindings routes gate on the one `socialGate` (`lib/social-authority.ts`);
   no second gate may survive in `routes/social.ts` or `social-plane.ts`.
2. Authority contracts: `communication-plane-authority.test.ts` covers each new
   read for participant / manager / no-grant / forged cookie / revoked /
   epoch-bump / cross-tenant; `shared-work` has owner / audience / outsider /
   historical cases.
3. Portal: `CommunicationPlane.tsx` + the rail model render the five sections
   from the composites named above (grep for `ActivePeopleGrid`,
   `TeamChannelTree`, `ConversationRail`, `WorkGraph`, `RowList`); no raw
   elements/inline styles; component-discipline, nav-parity, rail-parity
   (Communication section, chat-rail mode) green.
4. Browser (`e2e/communication-plane.spec.ts` + `communication-shared-work.spec.ts`):
   u-vera sees Active now with u-mira online and "in a huddle"/activity text,
   My initiatives with Auth Migration bound to `#auth-migration`, My org teams
   with her team; opens a person's shared work (empty for an outsider, populated
   after u-mira shares a work node into #general); Shared work view lists a deck
   share and a page reference and opens it in the right pane; a user with no
   Social grant makes zero `/api/social` requests; footer Social lands on
   `/iq/communication`; u-asha and u-tomas get their tenant's groups section.
5. Journey logs: `docs/communication-journeys/{member,org-leader,no-grant,assessment,pipelines}/*.md`
   sealed only after a real walk (`scripts/journeys/seal.sh <dir>`, never a global seal; docs/journeys.md).
6. `docs/social-tenant-design.md` §4.6 and `docs/nav-server-tier-decisions.md`
   record the decisions; `e2e/communication-plane.spec.ts`'s `/api/social`
   allowlist includes only `plane/`, `embedded`, `dms`, `share-destinations`,
   `bindings`.

## Lanes

| Lane | Model | Owns | Delivers |
|---|---|---|---|
| A — authority & data | Fable | `middleware/src/routes/social-plane.ts`, `routes/social.ts` bindings, new `routes/org-teams.ts`, `lib/work-graph/**` sharing, `providers/*`, `mock/social-work-sharing.ts`, org-team fixture rows, jest, snapshots | §1.2–1.4 data, §3, §5, §6 |
| B — plane UI | Opus | `pages/communication/**`, `pages/social/SocialChatWorkspace.tsx` (rail), new `pages/social/SharedWorkView.tsx`, `components/social/**`, specs | §1, §2, §3 UI, §4 pane integration |
| C — judge & records | Sonnet | `scripts/validate-communication-plane.sh`, `docs/communication-journeys/**`, doc updates, allowlists | Judge, logs skeleton, docs |

Shell items (§4) are separate lanes already running (footer Social, huddle
bar, details pane). Lane B consumes their results; it does not edit
`components/shell/**`.

## Status

- 2026-10-07: goal written from the inventory; lanes A/B/C launched.
- 2026-10-08: audit step "server consolidation" — one Social permission path
  (`lib/social-authority.ts` `socialGate` on both mounts and the bindings
  routes; `personalTeamSession`, `embedGate` and the plane WeakSet deleted),
  one "mine" reader (`lib/mine.ts`, `GET /api/me/groups?kind=`; the three
  per-tenant readers deleted; assessment teams by `assessment_team_members`
  rows, never a name), one shared-work notion (`SharedWorkItem`,
  `sharedWorkInConversation`, `GET …/conversations/:id/shared-work`; the
  portal's client-side derivation deleted). Contracts in
  `communication-plane-authority.test.ts` and `me-groups.test.ts`.
- 2026-10-07 (close): `validate-communication-plane.sh` ALL CHECKS PASS — 93
  checks, 11 browser specs, 46 plane jest tests, 24/24 journey logs walked
  headlessly and sealed per directory (member u-theo, org-leader u-vera,
  no-grant u-hr, assessment u-asha, pipelines u-tomas). Defects D1–D4 closed
  (audience reply validated server-side and keyed on the request's subject;
  list no longer under the graph; open-row preview follows live messages;
  unknown `?person=` is a not-found state). Limits recorded in the logs: no
  live call observable on the Tilt stack; create-team-channel/Bind need
  grants the walkers lack; assessment/pipelines users cannot send an
  initiative page reference. Audit follow-ups in
  `docs/audit/2026-10-07-audit-plan.md` (one Social permission path, one
  "mine" reader shape, one shared-work notion) are the refactor program, not
  acceptance gaps.

## Wire shapes (Lane A)

Stable as of 2026-10-07. Every plane read is gated by
`currentSocialActionSession(session, 'ViewSocial')` (the actor's CURRENT Social
grants, epoch and masquerade actor, rechecked after the reads); the session
keeps its source tenant. `Cache-Control: no-store` on all of them.

### `GET /api/social/plane/active[?users=u-a,u-b]`

`users` narrows to the shell's presence roster (ids, comma-separated, ≤200);
without it, everyone holding a Social grant (≤100).

```json
{
  "observedAt": "2026-10-07T18:00:00.000Z",
  "people": [
    { "userId": "u-mira", "displayName": "Mira Okafor", "status": "busy",
      "inCall": { "callId": "mock-call-live-general", "lobby": "social:ch:general", "title": "#general", "since": "…" },
      "activity": "In a huddle on #general",
      "workSharing": null },
    { "userId": "u-vera", "displayName": "Vera Green", "status": "online", "inCall": null,
      "activity": "Working on Cognito consolidation",
      "workSharing": { "state": "active", "fresh": true } }
  ],
  "counts": { "people": 2, "inCall": 1, "sharing": 1, "withActivity": 2 },
  "limits": ["activity is the orgiq work graph; a viewer standing elsewhere reads none of it"]
}
```

- `status`: `busy` when `inCall` is set, else `online` (presence itself stays
  the client's single subscription — the tile's online/away comes from there).
- `inCall`: a live call-log row (answered, not ended) in a lobby THIS viewer
  may read now — a Social conversation the viewer belongs to, or a tenant
  page lobby under `authorizeCallLobbyRead`. Otherwise `null`, whatever the
  person is doing. `title` is the conversation's rail title or the
  initiative's name; `null` when the lobby has none the viewer can see.
- `activity`: the latest node of the person's orgiq work-graph day, built with
  the VIEWER's own gates (`/api/work-graph/people/:id/graph`'s builder), so a
  title the viewer could not open never appears; `"In a huddle on …"` when in
  a visible call. `null` for a viewer not standing in orgiq, for an unlinked
  person, or when nothing is readable. Text forms: `Editing <doc>`,
  `Running <run>` / `Ran <run>`, `Working on <task>`, `Deciding <decision>`,
  `On <initiative>`.
- `workSharing`: `{ state: 'active' | 'historical', fresh }` from the person's
  sharing grants whose audience includes the viewer (own grants for the viewer's
  own row); `fresh` = a grant touched in the last 24 h. `null` when none reach
  the viewer. Maps 1:1 onto the library `ActivePerson` (`activity`, `inCall`
  as boolean `!!inCall`, `status`, `workSharing`).
- `limits`: why a field could not be decided (platform-api's per-person call
  log; a viewer outside orgiq). Never a reason to guess.

### `GET /api/social/plane/people/:userId/shared-work[?day&timezone[&schemaVersion=2&windowStart&windowEnd&mode]]`

The person-graph query (`routes/work-graph.ts`); with no query, today in UTC.

```json
{
  "snapshot": { "schemaVersion": 1, "scope": { "personId": "person:p-002", "day": "…", "timezone": "UTC", "policyRevision": "orgiq.…" },
                "revision": 0, "watermark": 0, "cursor": "owg1.…", "nodes": [ /* ViewerWorkNode */ ], "edges": [ /* ViewerWorkEdge */ ], "sources": [], "partial": false },
  "sharing": {
    "viewer": "audience",
    "state": "active",
    "fresh": true,
    "provenance": { "work:wi-auth-e1": "active", "work:wi-auth-e2": "historical", "initiative:p-auth-migration": "referenced" },
    "grants": [ { "id": "wsg-vera-auth-current", "state": "active", "kind": "current", "audience": { "kind": "conversation", "id": "social:ch:auth-migration" },
                  "nodeIds": ["initiative:p-auth-migration", "work:wi-auth-e1", "work:wi-auth-e1-b4"], "disclosure": "summary", "revision": 1,
                  "updatedAt": "…", "expiresAt": "…" } ],
    "referencedIn": ["social:ch:auth-migration"]
  }
}
```

- `snapshot` is the person graph's own shape (v1, or v2 with `schemaVersion=2`
  — `efforts`, `details`, `operations` narrowed to the surviving nodes), so the
  library `WorkGraph` renders it unchanged. It holds ONLY what this viewer may
  see: the owner's own graph (built under the OWNER's directory authority)
  filtered by realtime-modules `filterForViewer` against each effective grant.
- `sharing.viewer`: `owner` (everything, `grants` lists all their grants with
  revisions for the transition call), `audience` (something reached the
  viewer), `none` (empty graph — also for an unknown or unlinked user; never a
  403 that reveals existence).
- `provenance[nodeId]`: `active` (a current grant), `historical` (a history
  grant — a stopped share's days), `referenced` (the implicit grant: the owner
  posted a page reference to this initiative/work item in a conversation the
  viewer is a member of). Active wins over the others.
- Grant audiences: `{ kind: 'conversation', id: '<chat channel>' }` (its
  CURRENT members) or `{ kind: 'team', id: '<Social teamId>' }` (its CURRENT
  roster) — resolved per request from the chat and platform stores.

- `items`: the same disclosure as a flat list, one `SharedWorkItem` per node
  (below) with how and where it reached the viewer (`provenance`,
  `sharedInto`); for the owner, every node their still-active grants disclose.

### `GET /api/social/plane/conversations/:id/shared-work` (and `GET /api/social/conversations/:id/shared-work`)

The ONE shared-work notion (middleware `lib/work-graph/shared-work.ts`
`SharedWorkItem`, resolver `sharedWorkInConversation`): everything shared INTO
a conversation the viewer is a current member of — page references, deck
shares, files and sharing grants — each folded through the viewer's authority
NOW. A non-member or a malformed name is the uniform 404. `:id` is the chat
channel name, URL-encoded.

```json
{ "conversation": "social:ch:auth-migration", "title": "#auth-migration",
  "items": [
    { "kind": "work-node", "id": "work:wi-auth-e1", "title": "Rotate Cognito keys", "status": "available", "href": null,
      "sharedBy": { "userId": "u-vera", "displayName": "Vera Green" }, "sharedInto": { "kind": "conversation", "id": "social:ch:auth-migration", "title": "#auth-migration" },
      "at": "…", "authority": "grant", "provenance": "grant:active", "ref": { "grantId": "wsg-vera-auth-current", "nodeKind": "task" } },
    { "kind": "work-item", "id": "wi-auth-e2-b3", "title": null, "status": "unavailable", "href": null,
      "sharedBy": { "userId": "u-vera", "displayName": "Vera Green" }, "sharedInto": { "kind": "conversation", "id": "social:ch:auth-migration", "title": "#auth-migration" },
      "at": "…", "authority": "membership", "provenance": "reference", "ref": { "messageId": "m-1" } },
    { "kind": "deck", "id": "deck-1", "title": "Auth migration.pptx", "status": "available", "href": "/api/uploads/f-deck", "…": "…",
      "authority": "membership", "provenance": "deck", "ref": { "messageId": "m-2", "fileId": "f-deck", "fileName": "Auth migration.pptx" } }
  ],
  "limits": [] }
```

- `kind`: `initiative | work-item` (a page reference), `work-node` (a sharing
  grant's node), `deck`, `file`. `title` and `href` are null and `status` is
  `unavailable` whenever the viewer may not read the thing itself — a page
  with no current orgiq grant or that no longer exists, a deck whose file they
  may not download. A stored title is never echoed.
- `authority`: `grant` (a sharing grant whose audience reaches the viewer) or
  `membership` (the viewer is a current member of the conversation and may read
  the file/page now). `provenance`: `grant:active | grant:historical |
  reference | deck | attachment`.
- Messages are read after the viewer's history floor; files through the
  uploads read rule (`lib/gateway-attachments.ts` `readableUploads`); grants
  from any current member, the owner's graph built under the OWNER's authority
  and filtered by the library against the grant (at most 10 owners, then a
  `limits` line).
- The Active now `workSharing` flag and a person's `shared-work` reply read
  the same grant derivation (`ownerSharingState`): no second place sums grants.

### `POST /api/social/plane/work-sharing` → 201

Share your own work. Body: `{ audience: { kind: 'conversation' | 'team', id },
nodeIds: string[] (1–250, ids from your own person graph), edgeIds?: string[],
disclosure?: 'summary' | 'details' (default summary), durationMs?: number
(clamped to 5 min – 24 h, default 24 h), history?: { dayFrom, dayThrough,
durationMs? } (≤ 7 days; keeps a history grant so a later stop leaves those
days visible as historical) }`. Gate: `PostMessage` for a conversation,
`ManageTeams` for a team, and the owner must belong to the audience now
(else 404). Response `{ grant, history }` in the `grants[]` row shape above.

### `POST /api/social/plane/work-sharing/:id/transition`

Body `{ action: 'stop' | 'pause' | 'resume' | 'expire', expectedRevision }`.
Owner only (anyone else's grant is a 404); the same gate as creation for that
grant's audience; the library's lifecycle (`transitionSharingGrant`): 409 on a
stale revision or an impossible move, 410 when expired. Response `{ grant }`.
`stop` is "revoke"; a history grant stays active until its own expiry.

### `GET /api/social/plane/work-graph/conversations/:id/graph?day&timezone[…]`

Social's `routes/social-work-graph.ts` builder, run as the Social role the
actor's current grants allow: the same snapshot, the same membership rule and
the same uniform 404 (`WORK_GRAPH_UNAVAILABLE`) for a conversation the viewer
is not in or a malformed id. `:id` is the chat channel name, URL-encoded.

### `GET /api/me/groups?kind=initiative|sprint|org-team|assessment-team|pipeline` (the one "mine" reader)

Session floor; then the kind's tenant boundary (the session must stand in the
kind's tenant, the cross-tenant admin passes) and the host tenant's read action
where it has one (`ViewAssessment`, `ViewPipelines`). `Cache-Control: no-store`.
Middleware `lib/mine.ts` is the contract; `routes/me-groups.ts` serves it.

```json
{ "viewer": { "userId": "u-vera", "personId": "p-002" },
  "items": [ { "kind": "org-team", "id": "t-platform", "name": "Platform Engineering", "role": "Principal Engineer", "membership": "member",
               "counts": { "members": 6 },
               "members": [ { "userId": "u-theo", "personId": "p-001", "name": "Theo Chang" }, { "userId": null, "personId": "p-003", "name": "Marcus O'Brien" } ] },
             { "kind": "initiative", "id": "p-auth-migration", "name": "Auth Migration", "role": "owner", "membership": "owner" } ],
  "limits": [] }
```

- `viewer` is resolved ONCE from the session's directory row (`app_users.person_id`),
  never from a query or body (`?userId=` / `?personId=` are ignored).
- `membership`: `owner | contributor | lead | member | editor`; `role` is the
  source's own word (a title, a contribution role, a definition's status) or null.
- `members` / `counts` only where the source carries a roster (org teams,
  assessment teams).
- `limits`: the server's reason when a list is honestly empty — an account with
  no linked person (`initiative`, `sprint`, `org-team`), or a cluster where
  `assessment_team_members` is not applied. Never a reason to guess.
- Membership sources: `initiative` = `projects.owner_id` / `project_contributions`;
  `sprint` = those initiatives' sprints keyed on the person; `org-team` =
  `team_memberships`; `assessment-team` = `assessment_team_members`
  (`schema/assessment_team_members_schema.sql`, registered fixture
  `assessment-team-members`; additive, not yet applied to Aurora); `pipeline` =
  a definition's `owner` (a bot's creator) or the `updated_by` of its recorded
  version.
- An unknown `kind` → 400; another tenant → 403 `{requiredTenant}`; a
  directory or provider outage → 503.
- `GET /api/graph/projects?scope=mine` and `GET /api/sprints?scope=mine` keep
  their page shapes (the Initiatives and Sprints pages read them) but resolve
  the same viewer through `lib/mine.ts`; the former `GET /api/graph/teams?scope=mine`,
  `GET /api/assessment/teams?scope=mine` and `GET /api/pipelines/definitions?scope=mine`
  are gone.

### `social_bindings` `team` kind

`GET|PUT|DELETE /api/social/bindings?context=team:<teams.id>` — the existing
dual-grant gate (`ManageChannels` in social + a grant in orgiq); the same
`SocialBindingView` as `initiative:` contexts.

### Store

Sharing grants live in the registered fixture `social-work-sharing`
(`mock/social-work-sharing.ts`) under `MOCK_AURORA` — reset restores Vera's
seeded active + stopped/history pair — and in DynamoDB `${prefix}work-sharing`
(declared beside the chat tables in `infra/lib/social-stack.ts`) when the chat
store is Dynamo (`lib/work-graph/sharing.ts`). realtime-modules 0.115 ships
the grant lifecycle and `filterForViewer` but no sharing store, so the table is
the middleware's.

`POST/PUT/GET /api/social/bindings` now accept kinds `assessment-team` (assessment
grant) and `pipeline` (pipelines grant) under the same Social + host-tenant dual-grant gate.
