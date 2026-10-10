# Nav gates vs the server's read tier — open decisions

`scripts/validate-nav-parity.sh` reports every nav item gated **narrower** than
what its API actually serves. This file is where those get decided, because the
answer is a product call and not always "widen the nav".

## Why the check exists

`readForRolesElseAction(ROLES, ACTION)` is a deliberate sentence: *these roles
may read this surface even without the write capability.* The effective reader
set is `ROLES ∪ everyone Cedar grants ACTION`. When the rail, the palette and
the route admit fewer roles than that, the server is serving a page the product
hides — and nothing tells you, because the three portal gates agree with each
other perfectly while all three disagree with the server.

That is exactly how **Computer Lab** hid `org-leader`: the one role
`devbox-visibility.ts` treats as `FLEET_WIDE` and shows every computer in the
fleet could not open the page at all. `DevboxPage` had even been written for
the wider audience — `FLEET_READ_ROLES` plus a read-only mode — so the fix sat
one layer below a door that never opened. Fixed in `a257bf3`; that commit's
parent is now this rule's recall fixture.

## The rule is ratcheted, not a hard zero

Because "the server is more permissive than the nav" has two honest
resolutions, and only one of them is code:

1. **Widen the nav** — the server's read tier states the intent and the page
   already supports the audience. Computer Lab was this: the rail's own comment
   described all four roles in prose above a list naming two.
2. **Leave it** — the server is simply permissive and the product deliberately
   does not advertise the surface to that role. Nothing is broken; the nav is
   the narrower, intentional statement.

What is **not** acceptable is the third case: nobody has decided, and the drift
is invisible. The budget makes it visible and stops it growing.

## Decided: `/iq/runs` is gated exactly as the `/api/runs` façade (2026-09-30, lane E)

OrgIQ's Runs section (Operate) reads `GET /api/runs` — the orgiq façade over
the pipelines run projection (`middleware/src/routes/runs.ts`), whose read
gate is the bots router's: `readForRolesElseAction(['org-leader', 'hr-admin',
'program-owner'], 'ManageBots')`. `ManageBots` adds `sme`, so the effective
reader set is `sme`, `program-owner`, `org-leader`, `hr-admin` (+ `admin`).
The rail row (`Layout.tsx`, with `admin` listed because the tenant-nav filter
has no bypass), the palette row (`roles: BOTS`, "Workspace runs") and both
routes (`App.tsx` `runs`, `runs/:id` under `RequireRole`) name exactly those
four — not narrower than the API, and not wider: a `member` would get a page
of 403s, the same reason `/admin/bots` does not show to them. Resolution 1
("widen the nav to the server's tier") taken at birth rather than after the
fact. If the façade's gate ever moves, the three portal gates move with it.

## Open: should `org-leader` see the Ingest surfaces read-only? (5 candidates)

`/api/ingest` mounts `readForRolesElseAction(['org-leader', 'hr-admin'],
'ManageIngest')`. `org-leader` does **not** hold `ManageIngest`, so naming them
in that list is only meaningful as a grant of read — somebody wrote it on
purpose. All five ingest pages already gate every write control behind
`canManage = can('ManageIngest')`, so a read-only org-leader gets a coherent
page today.

Against that: unlike Computer Lab, no comment, prop or page constant states the
intent, so widening would be inventing a product decision rather than restoring
one.

Affects `/admin/ingest/{crawl,history,storage,sources,schedules}`.

## Open: should SMEs and program-owners see Codebases? (1 candidate)

`agent-projects.ts`'s read gate is `readForRolesElseAction(['org-leader',
'hr-admin'], 'DispatchAgentRun')`, and `sme`, `program-owner`, `org-leader` and
`hr-admin` all hold `DispatchAgentRun` — so all four can read the API. The nav
shows Codebases to `hr-admin` alone.

This one has the stronger argument for widening. The operating model has the
SME as the persona who *spends an envelope by assigning agents to work*, and
Codebases is the list of repositories that work runs against — the rail's own
Computer Lab comment already reasons this way: "If you can dispatch work onto
the fleet you can see the fleet." `AgentProjectsPage` gates its writes on
`ManageDevbox` / `ManageIngest` capabilities, so the read-only view exists.

Still a product call, so it is recorded here rather than taken.

Affects `/admin/projects`.

## Open: `program-lead` has a user-admin API and no surface to reach it from

Not the usual shape. The other two entries are "the portal is gated narrower
than the API"; this one is "the API was deliberately widened for a role the
portal structurally cannot show it to", which needs a different answer.

`middleware/src/routes/identity.ts` reads with
`requireAnyAction(['ViewIdentityAdmin', 'ManageUsers'])` and its user/grant
writes take `requireAction('ManageUsers')`. `program-lead` holds `ManageUsers`
(`middleware/seeds/roles/assessment/program-lead.cedar`), and that grant is not
incidental — `routes/__tests__/identity-program-lead-gate.test.ts` exists
precisely to pin it, its header recording that "a router-wide
`requireAction('ViewIdentityAdmin')` locked program-lead (ManageUsers,
tenant-scoped) out of the user-admin routes built for it."

The portal offers that role nothing. Identity is an orgiq surface twice over:
`Layout.tsx` computes `platformItems` as `onOrgiq ? … : []`, so a session in the
assessment tenant sees no `/admin/*` rail item at all, and `App.tsx`'s route
gate is `RequireRole roles={['hr-admin']}`, which `program-lead` also fails.
There is no `/assessment/*` users or identity route to fall back to.

So the API path is reachable only by curl. Three honest answers, and the choice
is a product one:

1. **Give the assessment tenant its own user-admin surface.** Consistent with
   how these tenants are kept apart — they share the BFF and nothing else, no
   shared nav or chrome — and it is what the Cedar grant implies was intended.
   It is also a new surface, i.e. a feature.
2. **Widen `/admin/identity` to program-lead.** Smallest diff, and wrong: it
   would put an assessment role inside orgiq's admin rail and break the tenant
   separation the rest of the product holds to.
3. **Withdraw `ManageUsers` from program-lead** if nobody intends them to
   administer users, and delete the test that pins it.

Recorded rather than taken. Note this one is invisible to
`validate-nav-parity.sh` by construction: the scanner compares a nav item's
gate against the API it reads, and here there is no nav item to compare.

Affects `/admin/identity/*` and the assessment tenant's rail.

## Decided: the day's graph pages are "Work graph", the ledgers keep "Activity" (2026-10-06)

`/iq/activity`, `/pipelines/activity` and `/assessment/activity` are labelled "Work graph" (rail, palette, page title; the palette hint says "not the run ledger"); only assessment's System row `/assessment/runs` stays "Activity".

## Decided: one deck write rule across tenants (2026-10-06)

A deck is writable (build, save, revise, share) by exactly the actor who may run that tenant's agent on the deck's subject: assessment `RunAssessmentAgent` + team read, pipelines `RunPipeline` + run read, orgiq `DispatchAgentRun` + initiative read (budget-tier redaction stays a read rule), social `PostMessage` + current conversation membership (delete: owner only). One function, `deckWriteAuthority` (`middleware/src/lib/deck-shared/authority.ts`), asked fresh per request by every deck route; the portal's `can()` controls read the same action through `makeDeckApi({ tenant }).writeAction`. Full record in `docs/agentic-flows-migration.md` "Open decisions".

## Decided: "Calls" becomes "Communication", the Social plane, in orgiq, assessment and pipelines (2026-10-07)

The user: "Org calls should be renamed Communication and be the social app plane like the tenant features." Rail, palette and trail say **Communication** at `/iq/communication` (Org), `/assessment/communication` (Assess) and `/pipelines/communication` (Runs); `/<tenant>/calls` redirects to `…/communication/calls`. Social's own Meet › Calls (`/social/calls`) stays. The rows carry no `roles`, matching the page: every role of the tenant opens it, because its Calls destination still lists the tenant's page huddles (`GET /api/calls/tenant`, the tenant's own read action) exactly as the former Calls page did. Everything Social on the page reads and writes through `/api/social/plane` — the Social tenant router's own handlers, each gated on the caller's CURRENT Social grants (`lib/live-principal.ts`) for the same action the tenant router asks — so a control the plane offers is never wider than its API; `requireTenant('social')` still fronts `/api/social/*`. A tenant role without a Social grant gets the page's denied state ("Ask an admin for Social access") plus its call log, and no Social request. Record: `docs/social-tenant-design.md` §4.6 "Communication".

## Decided: the Communication plane is shaped by the user's org context (2026-10-07)

The user: "Communication should be a representation of the social tenant for enabled users — your team and initiative groups, the 'Active now' people, and the work they have shared." `/iq/communication`, `/assessment/communication` and `/pipelines/communication` keep their rail rows and gating (no `roles`; a session without a Social grant still gets the denied state and zero `/api/social` requests), but the workspace gains three things, all read through `/api/social/plane` (each re-gated on the actor's CURRENT Social grants) or a host-tenant route under its own gate, so no control is wider than its API: **Active now** (`GET /api/social/plane/active`), the user's groups (**My initiatives** / **My teams** / **My pipelines**, plus orgiq-only **My org teams** — all from the one `GET /api/me/groups?kind=` reader, `lib/mine.ts`), and **Shared work** (`?view=shared`, and a person's `…/people/:userId/shared-work`, filtered per viewer by sharing grants). "Mine" derives from `app_users.person_id` on the server, never the body. The footer's Social entry goes to `/<tenant>/communication` for an enabled user, `/social/channels` inside Social. Record: `docs/social-tenant-design.md` §4.6; judge: `scripts/validate-communication-plane.sh`.

## Deliberately clean

`/admin/knowledge`, `/admin/budgets`, `/admin/bots` and `/admin/devbox` all
match their server tier exactly and are not flagged — which is what makes the
six above signal rather than noise.
