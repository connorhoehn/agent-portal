# Goal: the `social` tenant and the header activity indicator

**Judge:** `scripts/validate-social-tenant.sh`. It is the only judge — nothing
here is done until the script says so. It exits 0 only when every check
passes and prints every failing line, so one run shows the whole backlog.

```
scripts/validate-social-tenant.sh                 # everything, slow suites included
scripts/validate-social-tenant.sh --quick         # skip jest, vite build, Playwright; siblings run --quick
scripts/validate-social-tenant.sh --phase S0      # gates + one phase (S0 | N | S1 | S2 | E)
scripts/validate-social-tenant.sh --seal          # record the journey logs' source digests (after a walk)
scripts/validate-social-tenant.sh --no-time       # accepted for the /goal hook; skips SOCIAL_TIME_GATE
```

`--phase` exists so a lane can be judged on its own checks while the later
phases are still honestly red; the goal is met only by a run with no
`--phase`. The e2e specs run (non-quick) against `PARITY_BASE_URL`
(default `http://localhost:5183`), the way
`validate-assessment-documents-parity.sh` runs its journey.

Paste this as the `/goal`:

> Bring the `social` tenant and the header activity indicator to their
> definition of done: `scripts/validate-social-tenant.sh` exits 0 with no
> flags. Work the lanes in `docs/social-tenant-design.md` §7 in order
> (S0 ∥ L → N → S1 → S2 → E), judging each lane with
> `--phase <lane>` and the whole with no flag. Every failing line is the next
> task. Nothing under `portal/src` or `middleware/src` is edited while a
> journey walker is running against the shared stack. No `npm install` during
> autonomous runs; a missing library primitive is a queue row in
> `docs/ui-components-queue.md` and a library release, never a hand-rolled
> copy. Subagents: headless Playwright and curl jars only, no browser MCP.

## What this judges

The design is [`docs/social-tenant-design.md`](social-tenant-design.md) —
§3 (the activity indicator), §4 (the tenant), §6 (isolation) and §7 (the
lanes). The registration checklist is the research's §A.4
([`social-tenant-and-pipelines-research-2026-09-29.md`](social-tenant-and-pipelines-research-2026-09-29.md)),
21 rows, each a file and a line; the S0 phase checks those files by name.
The pipelines tenant has its own goal (`docs/pipelines-tenant-goal.md`,
lane D's second pair) and is not judged here.

## Cast

| user | role in `social` | also holds | walks |
|---|---|---|---|
| `u-mira` | community-admin (Mira Okafor) | — | journey logs, outbound isolation |
| `u-lena` | moderator (Lena Brandt) | — | journey logs, outbound isolation |
| `u-sana` | participant (Sana Iqbal) | — | journey logs, outbound isolation |
| `u-operator` | admin | admin everywhere | journey logs |
| `u-release`, `u-vera`, `u-mia`, `u-nora`, `u-rachel`, `u-theo`, `u-jonas`, `u-farah` | participant (design §4.1: curated casts, for embedding) | their home grants | inbound isolation |
| `u-hr` | none | orgiq `hr-admin` | inbound isolation (a no-grant orgiq walk) |
| `demo-user` (cookie-less) | **none** | permissive in orgiq + assessment | inbound isolation (the no-grant session §3.6 and E need) |

The moderator is `u-lena` (design 16b0850a; `u-theo` is already Theo Chang,
the orgiq member, and is a curated participant here). `u-asha`'s social
grant is not judged either way — see "Unjudgeable" below.

## Phase S0 — registered, pickable, empty

Every check greps the file the research's A.4 row names.

1. **Session** (`middleware/src/lib/session.ts`): `TENANTS` lists `'social'`;
   `ROLES_BY_TENANT.social` is exactly `['participant', 'moderator',
   'community-admin']`; the hand-written `Role` union names all three;
   `ROLE_RANK` ranks all three; `permissiveGrants()` leaves `social` out
   (the demo user holds no social grant — design §4.1).
2. **Cedar** (`middleware/seeds/roles/social/`): `participant.cedar`,
   `moderator.cedar`, `community-admin.cedar`; every `permit` in them is
   conditioned on `principal.tenant == "social"`; participant permits
   `ViewSocial`, `PostMessage`, `StartCall` and **forbids** `ManageChannels`,
   `ManageTeams`, `ManageRecordings`; moderator permits those three and
   **forbids** `ManageSocialConfig`; community-admin permits
   `ManageSocialConfig`.
3. **Actions** (`middleware/seeds/schema.json`): the seven — `ViewSocial`,
   `PostMessage`, `StartCall`, `ManageChannels`, `ManageTeams`,
   `ManageRecordings`, `ManageSocialConfig` — under `OrgIQ.actions`.
4. **`CAPABILITY_ACTIONS`** (`middleware/src/lib/authz.ts`): the same seven,
   inside the array (an unlisted action hides every control behind it).
5. **Role labels** (`middleware/src/lib/role-registry.ts`): `PRESENTATION`
   entries for the three roles.
6. **Identity seed** (`schema/identity_schema.sql`): tenant row
   `('social', 'Social')`; `app_users` rows for `u-mira`, `u-lena` and
   `u-sana`; grants `u-mira`→community-admin, `u-lena`→moderator,
   `u-sana`→participant, `u-operator`→admin, and participant for the eight
   curated users above; no
   `demo-user` row.
7. **Identity fallback** (`middleware/src/providers/identity.ts`): the same
   tenant row and the same grants in `FALLBACK_TENANTS` / `FALLBACK_USERS`.
8. **Mount** (`middleware/src/index.ts`): `/api/social` behind
   `requireTenant('social')`; a middleware test under
   `middleware/src/routes/__tests__/social*.test.ts` asserts an orgiq or
   assessment role gets 403 there.
9. Agent↔tenant map: n/a — the tenant has no agents (reported, not failed).
10. **Mock parity**: the `tenants` entity in
    `middleware/src/mock/core/parity/entities.ts` describes three tenants.
11. **Portal tenant type**, three copies: `portal/src/lib/auth.tsx`
    (`Tenant`), `portal/src/components/shell/Layout.tsx` (`Tenant`),
    `portal/src/components/shell/portalCommands.ts` (`PageTenant`).
12. **Front door**: `TENANT_HOME.social = '/social/channels'`
    (`portal/src/lib/tenantHome.ts`).
13. **Flag**: `VITE_ENABLE_SOCIAL` in `portal/src/lib/features.ts`.
14. **Rail**: `NAV_ITEMS` rows for the eight paths with their groups —
    Talk (`/social/channels`, `/social/dms`), Meet (`/social/calls`,
    `/social/rooms`), People (`/social/contacts`, `/social/teams`), Library
    (`/social/recordings`), System (`/social/configuration`); `TENANT_LABELS`
    carries `social`.
15. **Palette**: `GROUP_ORDER_BY_TENANT.social` is exactly
    `['Talk', 'Meet', 'People', 'Library', 'System']`; ≥10 `tenant: 'social'`
    rows.
16. **Route tree** (`portal/src/App.tsx`): `RequireTenant tenant="social"`
    around a `/social` tree that routes all eight surfaces.
17. **Picker** (`portal/src/pages/SelectContextPage.tsx`): `TENANT_META.social`,
    `ROLE_META` for the three roles, `u-mira`, `u-lena` and `u-sana` in the
    curated cast.
18. **Brand tokens** (`portal/src/app.css`): `[data-tenant="social"]` light
    and `html[data-theme="dark"][data-tenant="social"]` dark.
19. **Cognito seed** (`infra/lib/authentication-stack.ts`): every email the
    identity seed gives `u-mira`, `u-lena` and `u-sana`.
20. **Validators**: `scripts/validate-newsroom-removal.sh` no longer pins
    the two-tenant `TENANTS` literal or the two-tenant portal `Tenant` type,
    and still passes (see Siblings).
21. **Docs**: `CLAUDE.md` names the tenant (`social`, `participant`,
    `community-admin`, `requireTenant('social')`) and lists this goal/judge
    pair in the docs map.

Plus, for the pages that exist from S0 on (`portal/src/pages/social`):
component discipline (the assessment judge's raw-element gate: 0 raw
`<div className>`, 0 raw `<button>`, 0 `style={{}}`, raw styled elements
within budget 0, exemptions only by a "Composed locally in
`portal/src/pages/social/…`" queue row, ≤8 each); no `/iq`, `/admin` or
`/assessment` path inside a social page; no import of the
build-breaking `integrations/realtime-modules` entry (`integrations/realtime`
is the sanctioned one); and the isolation logs below.

## Phase N — the activity indicator (design §3)

1. The installed ui-components exports `NotificationBell` and
   `WrappedNotificationBell` (lane L landed and was pinned).
2. `middleware/src/lib/realtime-gateway.ts` imports and wires
   `notifications(` into its feature list.
3. `middleware/src/lib/redis-lite.ts` speaks `ZADD`, `ZRANGE`, `ZCARD`,
   `ZREMRANGEBYRANK`.
4. `middleware/src/lib/social-notify.ts` exists, exports `notify`, and reads
   grants (the tenant rule: deliver only to holders of a grant in
   `payload.tenant`); `middleware/src/lib/__tests__/social-notify.test.ts`
   covers the refusal of a user without the grant.
5. Producers: `routes/assessment.ts` (rows 1–3, the comment route) and
   `routes/approvals.ts` (row 8) import `social-notify`; the DM producer
   (row 4) lives in a middleware file that imports `social-notify` and reads
   the server-stamped `metadata.userId`.
6. The header renders the library bell: `Layout.tsx` mounts `<ActivityBell`
   (or the library bell directly), and the shell file that draws it imports
   `NotificationBell`/`WrappedNotificationBell` from
   `@connorhoehnslalom/ui-components` with no `<svg` and no raw `<button` of
   its own.
7. `portal/src/lib/tenantCaches.ts` clears `rmn:notifications:read`.
8. `middleware/src/mock/notifications.ts` defines a fixture with an `empty`
   scenario and is imported (registered) from the middleware.
9. `portal/e2e/social-activity.spec.ts` exists with these three test titles,
   verbatim, and (non-quick) passes against `PARITY_BASE_URL`:
   - `a reply reaches the author's bell without a reload`
   - `a user with no social grant receives no social item`
   - `a reload replays the unread set`
10. Journey logs for the `activity` surface (below), and (non-quick)
    `validate-mock-floor.sh` and `validate-route-coverage.sh` green — the
    design names both as N's judges.

## Phase S1 — channels and DMs, durable

1. The middleware's realtime-modules pin is ≥ 0.99.0 (the library's
   `DynamoChatStore`).
2. `realtime-gateway.ts` imports `DynamoChatStore` from the library and
   passes `chat({ chatStore` … `})`; no `class DynamoChatStore` anywhere in
   `middleware/src` (the design: "the middleware does not write its own");
   a middleware test names `DynamoChatStore` (the wiring is exercised).
3. The guard knows `social:` channels and membership: a test under
   `middleware/src/lib/__tests__/realtime-gateway*.test.ts` names
   `social:ch:`.
4. `middleware/src/routes/social.ts` exists and mounts `POST /channels` and
   `POST /dms`; route↔test parity — every route it mounts has a test under
   `middleware/src/routes/__tests__` that calls `/api/social<path>`.
5. Pages: a file under `portal/src/pages/social` imports `ConversationRail`,
   one imports `WrappedChatPanel`, one imports `ContextComposer`.
6. A registered mock fixture `middleware/src/mock/social-channels.ts` with
   an `empty` scenario (a tenant with no fixtures is blank under `dev:mock`).
7. Producer row 5: a middleware file importing `social-notify` names
   `social:ch:`.
8. `portal/e2e/social-channels.spec.ts` with these titles, green non-quick:
   - `a channel message posted in one context arrives in the other`
   - `a direct message round trip`
   - `a forged cross-tenant subscribe is refused with AUTHZ_CHANNEL_DENIED`
9. Journey logs for `channels` and `dms`.

## Phase S2 — rooms, teams, recordings

1. `infra/lib/social-stack.ts` declares `teams`, `team-members`,
   `social-relationships`, `video-recording-share-links`.
2. The platform-api `tenants`-claim change is recorded in this file as a
   line starting `platform-api tenants commit:` followed by a backticked
   7–40-hex sha (see the ledger below) — mirrors design §4.2.
3. Pages: `createWrappedHangoutRoomsList` or `createHangoutRoomsSection`,
   `TeamChannelTree`, `RecordingList`, `RecordingPlayer`, `PresenceAvatars`
   each imported by a file under `portal/src/pages/social`.
4. Producer row 6 (missed call): `realtime-gateway.ts` passes
   `onCallMissed` to `calls(` and the handler reaches `social-notify`.
5. `portal/e2e/social-rooms.spec.ts` with these titles, green non-quick:
   - `a room created via REST is visible to a browser user in the tenant`
   - `the recordings list renders for the tenant`
6. Journey logs for `calls`, `rooms`, `contacts`, `teams`, `recordings`,
   `configuration`.

## Phase E — embedding

1. The E5 guard: `realtime-gateway.ts` admits a prefix by `tenants`
   (`tenants.includes`); a test under
   `middleware/src/lib/__tests__/realtime-gateway*.test.ts` sets `tenants:`
   and names `social:` (the `tenants` guard test — both the admit and the
   refusal).
2. Aurora: a `CREATE TABLE … social_bindings` in `schema/*.sql` with
   `tenant`, `context_kind`, `context_id`, `channel`, `created_by`,
   `created_at`.
3. `routes/social.ts` mounts `GET /bindings` (and parity covers it).
4. `docs/ui-components-queue.md` has a `ChannelBinding` row; the initiative
   overview (`portal/src/pages/projects`) renders `ChannelBinding`; the
   Search connections tab (`portal/src/pages/search`) opens a DM
   (`dmLobbyName`).
5. Isolation logs for a session **without** a social grant carry
   `forged-subscribe: AUTHZ_CHANNEL_DENIED`.
6. (non-quick) `validate-rail-parity.sh` and
   `validate-search-workspace.sh` green.

## Siblings (every phase, every run)

`validate-assessment-tenant.sh --no-time`, `validate-nav-parity.sh` and
`validate-newsroom-removal.sh` exit 0 — non-quick runs them non-quick, a
`--quick` run passes `--quick` through. Plus the gates: middleware and
portal `tsc`; non-quick, middleware jest and `vite build`.

## Journey-log contract

Protocol: [`docs/social-journeys/PROTOCOL.md`](social-journeys/PROTOCOL.md).
One log + one screenshot per (role × surface) under
`docs/social-journeys/<role>/<surface>.md`, roles `participant` (u-sana),
`moderator` (u-lena), `community-admin` (u-mira), `admin` (u-operator).

| surface | url | phase |
|---|---|---|
| activity | the header bell's popover, from `/social/channels` | N |
| channels | `/social/channels` | S1 |
| dms | `/social/dms` | S1 |
| calls | `/social/calls` | S2 |
| rooms | `/social/rooms` | S2 |
| contacts | `/social/contacts` | S2 |
| teams | `/social/teams` | S2 |
| recordings | `/social/recordings` | S2 |
| configuration | `/social/configuration` | S2 |

Required fields (grepped): `verdict: pass`, `console errors: 0`,
`layout: pass`, `keyboard: pass`, `empty-state: pass|n/a`,
`realtime: pass|n/a`, `screenshot: <file>` (the file exists beside the log),
`pages: <files>`; the words TODO, unverified, placeholder anywhere make the
log not count. Freshness is by **content digest** of the `pages:` entries,
recorded in `docs/social-journeys/.pages-sha` by `--seal` — exactly the
assessment rule; normal runs never write it.

**Isolation** (`docs/social-journeys/isolation/`, phase S0):

- inbound, one per outside role walking `/social/*` from its own tenant —
  `member sme program-owner org-leader hr-admin assessor lead-assessor
  program-lead demo-user`: `social-grant: yes|no`, `social-tile-visible:`
  equal to the grant, `social-nav-visible: no`, `direct-route-result:
  not-found|redirect`, `api-status: 403`, `activity-leak: none`,
  `verdict: pass`, `screenshot:`, `pages:`. `demo-user` must say
  `social-grant: no`. From phase E, every `social-grant: no` log also says
  `forged-subscribe: AUTHZ_CHANNEL_DENIED`.
- outbound, one per social role walking `/iq/*` and `/assessment/*` from a
  social session — `participant-outbound`, `moderator-outbound`,
  `community-admin-outbound`: `orgiq-nav-visible: no`, `orgiq-route-result:
  not-found|redirect`, `orgiq-api-status: 403`, `assessment-nav-visible: no`,
  `assessment-route-result: not-found|redirect`, `assessment-api-status: 403`,
  `verdict: pass`, `screenshot:`, `pages:`.

## Unjudgeable, or judged by a decision this file took

- **`u-asha`'s grant.** §4.1 gives the assessment cast a participant grant;
  §3.6 uses u-asha as the user with no social grant. They cannot both hold.
  This judge asserts neither for u-asha, requires the §3.6 no-grant case by
  test title (any no-grant session — `demo-user` or `u-hr` works), and asks
  the design to pick.
- **Display names** (Mira Okafor, Lena Brandt, Sana Iqbal) and emails are
  not judged; the Cognito check reads whatever emails the identity seed
  gives the three.
- **`permissiveGrants()`.** The cookie-less demo identity gets every role in
  every `TENANTS` entry, so adding `social` to `TENANTS` hands it a social
  grant unless `permissiveGrants` excludes it — the design's "the demo user
  gets none" is judged as that exclusion.
- **§6 "its isolation logs gain the two new outside roles"** — the social
  tenant has three roles, and the assessment judge's isolation matrix is
  pinned by `validate-newsroom-removal.sh` to exactly the five orgiq roles.
  Not judged here beyond "the assessment judge stays green".
- **§3.6 "added to `validate-assessment-tenant.sh`'s e2e list"** — that
  script has no e2e list. This judge runs the spec instead.
- **Picker glyph, brand hue, `ActivityBell` placement "between the fleet
  badges and the gateway dots", popover keyboard behaviour** — visual; judged
  only through the journey logs' `layout:`/`keyboard:` fields.
- **Producer rows 7 and 9** (proposed edit server-side; pipeline runs)
  depend on P2 and the pipelines tenant; not judged here.
- **The platform-api half of E5** is another repo's code; judged only by
  the recorded commit line (S2.2).

## Ledger

Upstream commits this goal depends on, recorded as they land (design §4.2).

platform-api tenants commit: `849a890` — the partition read from the target
and checked against `tenants` (`src/lib/partition.ts`); followed by `62f9913`
(private-room membership on the lobby check).

## Status

Lane D (2026-09-29): this file, the protocol and the judge exist; the judge
fails on today's tree with the full backlog. No lane has started.
