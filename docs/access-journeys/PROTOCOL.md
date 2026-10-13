# Journey audit protocol — the access tenant

Adapted from `docs/pipelines-journeys/PROTOCOL.md`: same log fields, same
freshness rule, same measuring traps, different surfaces and cast. One log per
(role × surface) under `docs/access-journeys/<role>/<surface>.md`, with its
screenshot beside it. `scripts/validate-access-tenant.sh` reads these: it wants
eight surface logs per role and seven isolation logs (four inbound, three
outbound). The goal is `docs/access-tenant-goal.md`; the design
`docs/access-tenant-design.md`.

Walk with headless Playwright or a curl jar — never the user's shared Chrome
tab (it holds their cookies; a persona switch there hijacks their session).
Reset shared state before and after a walk that writes
(`POST /api/__mock/reset`): a submitted, decided or withdrawn request is a
registered fixture mutation that the next walker would otherwise inherit.

## Sign in (once per role)

Open `http://localhost:5183/select` → **Sign in as** → the user's card →
**Sign in**; the cast holds a grant only in Access, so it lands on
`/access/requests` without a chooser stop. Confirm with
`fetch('/api/session/me')` that `sub`, `tenant: 'access'` and `role` are what
you expect before auditing anything. Never audit as Demo User — it holds no
`access` grant by design (`DEMO_EXCLUDED_TENANTS`).

| role | user | name |
|---|---|---|
| `requester` | `u-rhea` | Rhea Castellanos |
| `approver` | `u-omar` | Omar Haddad — Rhea's manager (`people.manager_id`) |
| `access-admin` | `u-priya` | Priya Venkataraman |
| `admin` | `u-operator` | Platform Operator (enter the Access workspace as admin) |

## Surfaces and URLs

The eight real surfaces each role walks. `/access/settings` is a registered
placeholder and has no log; `/access/requests/new` is walked as `new-request`.

| surface | url | what "the surface" includes |
|---|---|---|
| catalog | `/access/catalog` | the DataTable of items, the Workspace filter, "held" and policy chips, the row's Request icon opening the wizard with `?item=`; the command composer (`search catalog items for …`, `show work catalog items`, `open <id>`) |
| requests | `/access/requests` | the front door: own requests, the Status filter, the Whose filter (mine / reports' / everyone's) for approvers only, New request, a row opened, browser Back; the command composer |
| new-request | `/access/requests/new` | the wizard on `WorkflowStepper`: who (self; a report only for `DecideAccess`), what (item + the policy pre-check from `sodConflicts`), why (≥20 characters, the counter), how long (standing asks for a second reason); Submit → the new record with its computed chain |
| request | `/access/requests/req-0001` (and a request of the role's own) | the record: summary, the approval chain (stepper + steps table), Your decision (approve / reject / request information, each through `ConfirmDialog`) only when `can.decide`, Withdraw only when `can.withdraw`, the policy check, the audit events; the right pane "Discussion" and the docked composer (disabled in A0 with the lane-A1 reason) |
| approvals | `/access/approvals` | the inbox: only steps this user may decide now; a row opens the record; requester: what they see instead (rail/palette absent, route redirects) |
| policies | `/access/policies` | the SoD matrix, the Severity filter, a policy opened in the drawer; Save for `access-admin` only, absent for others |
| reviews | `/access/reviews` | the honest empty table naming lane A2, the toolbar and composer present |
| audit | `/access/audit` | the events table, the Event filter, the scope notice (own vs every event), a row opening its request |
| configuration | `/access/configuration` | `access-admin` only: durations, stewards, catalog items, Save disabled with the read-only reason; other roles: what they see instead |

Write configuration as the eighth log for `access-admin`; for `requester` and
`approver` the eighth log is `configuration.md` recording the refusal (rail,
palette and route all agree), which is the surface as that role meets it.

## Per surface

1. Navigate, wait for data. Collect console errors (not warnings) BEFORE the
   surface and after every interaction on it. A Vite HMR overlay from another
   agent's in-flight edit is not the page's — wait and reload.
2. Screenshot at ≥1440px wide and save it as
   `docs/access-journeys/<role>/<surface>.jpg`.
3. Measure the layout and write the numbers (`docs/layout-cascade.md`): no
   horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`);
   the trail is the content column's first row at the 24px gutter; the title
   is 20/600 under it; table body rows are 44px, one line each; the command
   composer is docked at the bottom of the column that owns the table.
4. Keyboard: Tab from the first control until focus has visited every
   interactive control (count against the really-visible set, trap 1 below);
   Enter/Space on a row opens it; Escape closes any drawer, dialog or popover
   (the composer's command help included).
5. Empty / error state: a list filtered to nothing; `/access/requests/req-missing`
   (the "Request not found" state); a request outside the role's read rule
   (404, never a leak of its contents). Write what rendered.
6. Role-gating — the separation of duties in the goal doc's Cedar table and
   the two row rules:
   - requester never sees Approvals, Configuration, the Whose filter, the
     decision controls or a policy Save;
   - approver decides only where `can.decide` holds — never on a request they
     submitted or benefit from (open one Omar submitted himself — submit one if the seed holds none: no decision section),
     never a step already decided (a second decision answers 409); no
     Configuration, no policy Save;
   - access-admin sees all of the above plus Configuration and policy Save.
   Hidden controls are absent from the DOM, not just disabled, unless the page
   deliberately shows them disabled with a reason (Configuration's Save, the
   A0 discussion composer).
7. Composer: on every list page type `help`, one search, one filter phrase,
   `reset filters` and `open <exact id>`; then a mutation phrase
   (`approve req-0001`) and confirm it is refused with nothing changed.
8. Write the log. If something is wrong, `verdict: fail — <what>` and keep
   going; do not fix pages mid-audit (a page edit can stale every log that
   names it). Collect defects in `docs/access-journeys/<role>/DEFECTS.md`.

## The A0 decision walk (once, approver)

As `u-rhea`: submit `SME in Work` for 7 days with a justification. As `u-omar`:
find it in Approvals, approve step 1 with a comment through the dialog, then
try the same step again by URL-driven replay (`POST …/steps/1/decide`) and
record the 409. As `u-priya`: see both events in Audit. Record the request id
in each of the three logs' `notes:` and reset the mock afterwards. Provisioning
(the grant actually appearing) is lane A1 and is not part of this walk.

## Log format

```
surface: request
role: approver
user: u-omar
url: /access/requests/req-0001
pages: portal/src/pages/access/RequestRecordPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 10:12 local, Chromium 1456px (Playwright headless), middleware dev:mock
screenshot: request.jpg
verdict: pass
console errors: 0
layout: pass — trail at 24px, title 20/600, steps table rows 44px, composer docked at the column bottom; no horizontal scroll
keyboard: pass — 11 controls reachable by Tab, Escape closes the confirm dialog and returns focus to Approve
empty-state: pass — /access/requests/req-missing renders "Request not found"
role-gating: decision section present on step 1 (Omar is Rhea's manager); absent on a request Omar submitted himself; no Configuration in rail or palette
notes: <what a person would notice: wrapping, truncation, wrong labels, dead links>
```

`verdict`, `console errors`, `layout`, `keyboard`, `empty-state`,
`role-gating`, `screenshot` and `pages` are required; the words TODO,
unverified and placeholder anywhere in the file make it not count.

## Isolation logs

Under `docs/access-journeys/isolation/`. The tenant must be invisible to every
role with no grant in it, and its own roles must see nothing of the others.

**Inbound** — `<role>.md` for one role from each other tenant: `member`
(`u-theo`, orgiq), `assessor` (`u-asha`), `participant` (`u-sana`, social) and
`author` (`u-ines`, pipelines):

```
role: member
user: u-theo
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
access-tile-visible: no           # /select: which tiles, which role rows
access-nav-visible: no            # rail + palette + tenant switcher: 0 anchors toward /access
direct-route-result: redirect     # /access/requests, /access/requests/req-0001, /access/approvals → where
api-status: 403                   # GET /api/access/summary, /catalog, /requests, /requests/req-0001
screenshot: member.jpg
verdict: pass
```

**Outbound** — `<role>-outbound.md` for `requester approver access-admin`:

```
role: requester
user: u-rhea
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx
other-nav-visible: no             # rail + palette: 0 anchors toward /iq, /admin, /assessment, /social, /pipelines
iq-route-result: redirect         # /iq/projects, /iq/runs
iq-api-status: 403                # /api/graph/teams, /api/bots
assessment-route-result: redirect
assessment-api-status: 403        # /api/assessment/teams
social-route-result: redirect
social-api-status: 403            # /api/social/channels
pipelines-route-result: redirect
pipelines-api-status: 403         # /api/pipelines/runs
verdict: pass
```

## `pages:` and freshness

Freshness and sealing follow [docs/journeys.md](../journeys.md): a log is stale
when the rendered contract of a route its `url:` names changed since its walk
was sealed (sweep measurements, gate, the assertions of the specs that cover
it), and only `scripts/journeys/seal.sh docs/access-journeys`, after a walk,
seals it. A `pages:` line is optional: it is the basis only for a log that
names no route.

## Measuring a surface from the console — two traps that invent defects

The same two traps as the pipelines protocol; read its section before
reporting a layout defect found by script rather than by eye.

**1. `offsetParent !== null` is not visibility.** An element with
`visibility: hidden` still has an `offsetParent`; walk the ancestors for
`visibility`/`display` before counting it as tabbable.

**2. `getBoundingClientRect()` inside an `overflow-x: auto` container reports
UNCLIPPED positions.** The request record's `WorkflowStepper` is such a
container at narrow widths; check for a scrolling ancestor before concluding
that a step "overflows onto its neighbour".
