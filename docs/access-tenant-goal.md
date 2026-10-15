# Goal: the `access` tenant to its definition of done

Design: `docs/access-tenant-design.md` (decisions A1–A10, the model, the
workflows, the lanes). This document is the definition of done the judge
reads; `scripts/validate-access-tenant.sh` is the only judge. It exits 0 only
when every mechanical check below passes and prints every failing line, so
one run shows the whole backlog. Nothing here is built as of 2026-10-12.

## Running the judge

```bash
./scripts/validate-access-tenant.sh --quick            # static registration, Cedar, policy, docs
./scripts/validate-access-tenant.sh --phase A0         # + routes, mock parity, pages, journeys for A0
./scripts/validate-access-tenant.sh --phase A3         # + escalation timers and delegation
./scripts/validate-access-tenant.sh                    # everything through E
```

`--quick` skips jest, the portal node tests and the browser. Phases nest: `A1`
includes `A0`, `A2` includes `A1`, `A3` includes `A2`, `E` includes all. The
full run also runs the access jest suites and the portal access node tests.

## Cast (decided here)

Three seed users, one per role, holding a grant **only** in `access` (the
outbound isolation walks start from an identity with nothing else), plus the
cross-tenant operator. Ids collide with none of the 21 existing `app_users`.

| id | name | email | role |
|---|---|---|---|
| `u-rhea` | Rhea Castellanos | `rhea.castellanos@orgiq.example` | `requester` |
| `u-omar` | Omar Haddad | `omar.haddad@orgiq.example` | `approver` |
| `u-priya` | Priya Venkataraman | `priya.venkataraman@orgiq.example` | `access-admin` |
| `u-operator` | Platform Operator | (existing) | `admin` — gains `('u-operator', 'access', 'admin')` |

The same rows go in `schema/identity_schema.sql`, the `providers/identity.ts`
fallback, the picker's `CURATED` list and the Cognito `seedUsers` in
`infra/lib/authentication-stack.ts`. The demo user gets no `access` grant.
`u-omar` is `u-rhea`'s manager through the new `people.manager_id` (their
linked people rows are seeded alongside), so the manager step of a request
from Rhea resolves to Omar without any fixture-specific code.

## A0 — registration, model, mock, routes, pages

### Registration: the 21 points

The judge greps the exact file each row names (the pipelines goal's table,
re-pointed; row 9 stays n/a because this tenant owns no agents).

| # | File | Required |
|---|---|---|
| 1 | `middleware/src/lib/session.ts` | `'access'` in `TENANTS`; `access: ['requester', 'approver', 'access-admin']` in `ROLES_BY_TENANT`; the three in the `Role` union; a `ROLE_RANK` entry each; `'access'` in `DEMO_EXCLUDED_TENANTS` |
| 2 | `middleware/seeds/roles/access/{requester,approver,access-admin}.cedar` | each permit conditioned `principal.role == "<role>" && principal has tenant && principal.tenant == "access"`; the forbids below; no other tenant's Cedar file names an access action |
| 3 | `middleware/seeds/schema.json` | `ViewAccess`, `RequestAccess`, `DecideAccess`, `ManageAccessCatalog`, `ManageAccessPolicy`, `ProvisionAccess` |
| 4 | `middleware/src/lib/authz.ts` `CAPABILITY_ACTIONS` | all six |
| 5 | `middleware/src/lib/role-registry.ts` `PRESENTATION` | `requester`, `approver`, `'access-admin'` |
| 6 | `schema/identity_schema.sql` | `('access', 'Access')`; the cast's three `app_users` rows and grants; `u-operator`'s admin grant |
| 7 | `middleware/src/providers/identity.ts` | `FALLBACK_TENANTS` + `FALLBACK_USERS` mirror 6 |
| 8 | `middleware/src/index.ts` | `app.use('/api/access', requireTenant('access'), …)` at the mount |
| 9 | agents | n/a — the tenant owns no agents and runs none |
| 10 | `middleware/src/mock/core/parity/entities.ts` | entities `access catalog`, `access requests`, `access policies` whose mock rows are the fixtures and whose seed rows are `schema/access_schema.sql`'s seed over the same ids |
| 11 | `portal/src/lib/auth.tsx`, `components/shell/Layout.tsx`, `components/shell/portalCommands.ts` | `'access'` in all three `Tenant` unions |
| 12 | `portal/src/lib/tenantHome.ts` | `access: '/access/requests'`; any `access.*` localStorage key is cleared by `tenantCaches.ts` |
| 13 | `portal/src/lib/features.ts`, `App.tsx` | `ACCESS_ENABLED` from `VITE_ENABLE_ACCESS`, honoured by the route tree |
| 14 | `Layout.tsx` | `NAV_ITEMS` rows `tenant: 'access'` in groups Request, Approve, Govern, System; `TENANT_LABELS.access = 'Access'` |
| 15 | `portalCommands.ts` | `GROUP_ORDER_BY_TENANT.access = ['Request', 'Approve', 'Govern', 'System']`; ≥10 palette rows covering `/access/{catalog,requests,requests/new,approvals,policies,reviews,audit,configuration,settings}` |
| 16 | `portal/src/App.tsx` | `path="access"` under `RequireTenant tenant="access"` |
| 17 | `portal/src/pages/SelectContextPage.tsx` | `TENANT_META.access`, `ROLE_META` for the three roles, the cast in `CURATED`, an `access` glyph in `TenantMark` |
| 18 | `portal/src/app.css` | `[data-tenant="access"]` light block and `html[data-theme="dark"][data-tenant="access"]` dark block, painted from `docs/branding.md` tokens |
| 19 | `infra/lib/authentication-stack.ts` | the cast's three emails in `seedUsers` |
| 20 | `scripts/validate-newsroom-removal.sh` | still asserts only that the retired tenant is absent (no exact tenant list) |
| 21 | `CLAUDE.md` | names `` `access` `` with `` `requester` `` / `` `approver` `` / `` `access-admin` ``; a docs-map row `access-tenant-goal.md` → `validate-access-tenant.sh`; "(N validators)" equals `ls scripts/validate-*.sh` |

Also: `portal/src/components/shell/TenantSwitcher.tsx` `LABELS.access = 'Access'`;
`middleware/src/lib/tenant-channels.ts` registers the `access:req:` family with
cursors; `middleware/src/lib/social-notify.ts` `tenantLabel('access')`.

### Cedar: separation of duties (decided here)

| role | permit | forbid |
|---|---|---|
| `requester` | `ViewAccess`, `RequestAccess` | `DecideAccess`, `ManageAccessCatalog`, `ManageAccessPolicy`, `ProvisionAccess` |
| `approver` | `ViewAccess`, `RequestAccess`, `DecideAccess` | `ManageAccessCatalog`, `ManageAccessPolicy`, `ProvisionAccess` — decides, never configures or writes a grant by hand |
| `access-admin` | all six + `ManageUsers` | none |

Cedar cannot see rows, so the route layer carries two more rules with
contract tests (`middleware/src/routes/__tests__/access-*.test.ts`): **nobody
decides a request they submitted or benefit from** (403 with a reason naming
the conflict), and **a step is decided once** (409 on a second decision).

### The model: `schema/access_schema.sql` and the mock

Additive file, registered in both schema loaders, **not applied to Aurora**
until the user says so. Tables as the design §3 lists them, plus
`ALTER TABLE people ADD COLUMN IF NOT EXISTS manager_id TEXT REFERENCES people(id)`.
Seed rows: eight catalog items (one `tenant-role` per non-admin role across
the four tenants that the design marks requestable, two `initiative-membership`
items for `p-auth-migration` and `p-observability`), six requests in six
different statuses with their steps and events, four SoD policies. The mock
(`middleware/src/mock/access-{catalog,requests,policies}.ts`) exports the same
rows and selectors, registered so `POST /api/__mock/reset` undoes a write;
every timestamp from `mock/core/clock.ts`; no fixture exports a number it
could count.

### Routes: `middleware/src/routes/access.ts`

| route | gate | A0 behaviour |
|---|---|---|
| `GET /api/access/summary` | `ViewAccess` | counts from rows: open requests, pending decisions for the actor (resolved live), active elevations, policies |
| `GET /api/access/catalog` | `ViewAccess` | items with `heldByActor` and `sodConflicts` computed from the actor's current grants |
| `GET /api/access/requests?scope=mine|reports|all` | `ViewAccess`; `all` needs `DecideAccess` | `reports` = beneficiaries whose `manager_id` is the actor's person |
| `POST /api/access/requests` | `RequestAccess` | validates item, duration, justification (≥20 chars), beneficiary (self unless `DecideAccess`), computes the chain, runs the SoD pre-check, writes `submitted` + events |
| `GET /api/access/requests/:id` | `ViewAccess` + read rule (requester, beneficiary, live approver, `access-admin`) | the record with chain, events, SoD result |
| `POST /api/access/requests/:id/withdraw` | requester or beneficiary | → `withdrawn` |
| `GET /api/access/approvals` | `DecideAccess` | the steps the actor may decide now |
| `POST /api/access/requests/:id/steps/:step/decide` | `DecideAccess` + the two row rules | `{ decision: 'approve' | 'reject' | 'info', comment }`; last approval → `approved` (A0 stops here; A1 provisions) |
| `GET /api/access/policies`, `PUT …/policies/:id` | `ViewAccess` / `ManageAccessPolicy` | SoD rules |
| `GET /api/access/audit` | `ViewAccess` for own events, `DecideAccess` for all | `access_events` |
| `GET /api/access/reviews` | `ViewAccess` | empty until A2 |

Every write mutates a registered fixture; every route has a test
(`validate-route-coverage.sh` stays at budget 0); unknown body keys are 400.

### Pages: `portal/src/pages/access/`

Every page on the house frame from day one: `CollectionCommandPage` +
`CollectionToolbar` + `DataTable size` unset (compact density) + the shared
command composer through `collectionCommandAdapter`, 44px one-line rows, one
type scale. `accessSurfaces.ts` names each page and the lane that fills it.

| route | page | composer policy (`portal/e2e/ui-dom-audit.policies.ts`) |
|---|---|---|
| `/access/catalog` | catalog table with "Request" row action | required |
| `/access/requests` | my/reports' requests, status filter | required |
| `/access/requests/new` | the wizard (`WorkflowStepper`) | exempt: form |
| `/access/requests/:id` | record: chain, decision controls, thread pane | required |
| `/access/approvals` | the inbox | required |
| `/access/policies` | SoD matrix | required |
| `/access/reviews` | honest empty state until A2 | required |
| `/access/audit` | events | required |
| `/access/configuration` | durations, steward rules, sensitive flags | exempt: configuration |
| `/access/settings` | delegation (lane A3): the delegate picker, a window and a reason, over the delegations the viewer is part of | exempt: settings surface |

The judge runs the DOM audit on `--tenant access --all --strict-coverage` and
requires zero findings and zero unclassified.

### Journeys and isolation

`docs/access-journeys/<role>/<surface>.md` for the three roles × the eight
real surfaces, plus `isolation/<other-tenant-role>.md` for one role from each
of the four other tenants (they must be refused `/access/*` and see no Access
nav), and `isolation/<access-role>-outbound.md` for each cast member (they
must be refused the other tenants' routes). Sealed with
`scripts/journeys/seal.sh docs/access-journeys` after a walk; stale on
rendered-contract change per `docs/journeys.md`.

### Neighbour judges (non-quick)

`validate-route-coverage.sh`, `validate-mock-floor.sh --quick`,
`validate-nav-parity.sh`, `validate-component-discipline.sh`,
`validate-honest-numbers.sh` all green with the tenant present.

## A1 — provisioning, expiry, notifications, thread

- The last approval calls `provisionAccess(request)` in
  `middleware/src/lib/access-provision.ts`: a single-role `grantRole` or a
  `project_contributions` insert, an `access_events` row, status
  `provisioned` then `active`. It does **not** bump the session epoch: the
  grant reaches the beneficiary's open cookie through the ≤120 s grants
  refresh, without a sign-out (design A3).
- `revokeAccess(request, reason, actor)` is the inverse: remove the role or
  contribution, `bumpSessionEpoch(beneficiary)` (every cookie they hold is
  retired at its next read), a `revoked`/`expired` event.
- `access-expiry.ts`: a sweeper over `expires_at` that revokes through
  `revokeAccess`, single-flight across replicas (`lib/replica-fleet.ts`), with
  a contract that two replicas revoke once.
- Bell items via `notify()`: approvers on submit, requester + beneficiary on
  each decision, expiry warning 24 h before; every `href` inside `/access`.
- Thread `access:req:<id>` admitted by the request's read rule; the record
  page shows it in the right pane with one composer.
- Contracts: 2 route tests for the two row rules, provisioning on the memory
  identity provider, the grant observed on the beneficiary's existing cookie
  after the grants refresh (`GET /api/session/me`, no epoch bump), the epoch
  bump observed on revocation,
  the sweeper's single-flight, and a browser journey "Rhea requests `sme` in
  orgiq, Omar approves, Priya sees the audit row, Rhea's next request shows
  `sme` as held".

## A2 — policies and reviews

- SoD evaluation at submit (warn/block) and at provision (block), override by
  `access-admin` with a reason recorded as an event.
- Review campaigns: `access_reviews` over standing grants of one tenant; each
  item decided keep/revoke; revoke → a pre-approved revocation request through
  A1's path.

## A3 — escalation timers, delegation, the admin's person picker (2026-10-14)

- **Escalation timers** (`middleware/src/lib/access-escalation.ts`): a step
  left `current` longer than `ACCESS_ESCALATION_SLA_MS` (default 48 h, shown
  read-only on `/access/configuration`) escalates: level 1 adds the access
  admins, level 2 the `admin` holders in `access` (an access-admin step goes
  straight to the admins); a level that adds nobody new is skipped. The step's
  own deciders keep their right. Each escalation is one claim on the step
  (`casStep` / `ESCALATE_STEP_SQL`), an `escalated` event and a bell item to
  the people it newly reaches. Single-flight across replicas under the fleet
  lock `access-escalation-sweep`, exactly like the expiry sweeper. Steps carry
  `current_since`, `escalation_level`, `escalated_at` (additive columns).
- **Delegation** (`lib/access/delegation.ts`, `/api/access/delegations`,
  `/access/settings`): an approver hands their decisions to another approver
  for a window of at most 30 days. Refused: oneself (403), a delegate with no
  deciding role, an overlapping window of one's own, a delegate who is
  delegating during the window (no chains), a delegate who is a party to a
  request waiting on the delegator (409). Resolved live (A4): a delegate in force
  decides exactly the steps their delegator may decide now, never a request
  they are a party to, an access-admin step only if they hold access-admin,
  never through a second delegation; the step records `delegated_from` and the
  event says "decided on behalf of". Ending is the delegator's or an access
  admin's, once. Events `delegated` / `delegation-ended` name the delegation.
- **The admin's person picker**: the request form's "Who" is the library's
  `PersonPicker` (ui-components 2.452.0); an access admin may pick any person in
  the directory (`GET /beneficiaries`), an approver their direct reports. The
  delegation form picks the delegate with the same composite. No native select.
- Contracts: `routes/__tests__/access-escalation-delegation.test.ts` (both
  replicas escalate once; escalated and delegated deciders decide; every
  refusal), `lib/__tests__/access-escalation.test.ts`,
  `lib/access/__tests__/delegation.test.ts`, the mock lost-update contract in
  `lib/__tests__/access-provision.test.ts`; portal
  `pages/access/__tests__/accessDelegation.test.ts`.

## E — evidence

- The additive schema applied to Aurora (user decision).
- Native PostgreSQL 16 contracts (`middleware/src/lib/access/__tests__/access-postgres.test.ts`,
  dedicated container `orgiq-access-postgres-acceptance`, label
  `orgiq.validation=access-postgres`, network none) over the unmodified
  `access_schema.sql` and the cluster statements in `lib/access/sql.ts`:
  reapplication and the upgrade of a pre-A3 cluster's event checks; racing
  submits file once; twelve concurrent approvers decide a step once; no
  self-approval through the statement or any other writer (trigger);
  provisioning idempotent under eight racing provisioners and resumable after a
  crash; single-role grant writes keep a concurrent grant where the old
  delete-and-reinsert loses it (grant + grant, grant + revoke, and an admin
  edit's per-row diff transaction racing a provisioning); the expiry sweep single-flight under six racing
  sweepers and a person's revoke; escalation once per level; delegations.
  Record: `docs/realtime-validation/<date>/access-postgres.md`. The judge
  runs the suite when the container is up and otherwise judges the record,
  which must be newer than the statements it proves.
- Cognito `seedUsers` carry the cast.
- `docs/realtime-validation/<date>/access-tenant.md` records the gate.

## What the judge cannot see

Whether an approver's decision is sensible, whether the SoD seed is complete
for this organisation, whether managers in the org graph are right, and
whether the user wants `admin` grants requestable. Those are decisions, not
checks; the design's "Not decided here" list holds them.
