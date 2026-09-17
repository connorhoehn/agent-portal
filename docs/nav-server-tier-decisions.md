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

## Deliberately clean

`/admin/knowledge`, `/admin/budgets`, `/admin/bots` and `/admin/devbox` all
match their server tier exactly and are not flagged — which is what makes the
six above signal rather than noise.
