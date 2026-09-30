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

## Deliberately clean

`/admin/knowledge`, `/admin/budgets`, `/admin/bots` and `/admin/devbox` all
match their server tier exactly and are not flagged — which is what makes the
six above signal rather than noise.
