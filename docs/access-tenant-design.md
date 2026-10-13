# The `access` tenant — requesting, approving and provisioning access

**Status:** design, taken from the user's direction on 2026-10-12. The
definition of done and the judge are `docs/access-tenant-goal.md` and
`scripts/validate-access-tenant.sh`. Nothing in this document is built yet.

## 1. What the user asked for

> New tenant for approval requests for gaining permission to projects,
> tenants, roles, etc. Think SailPoint, ServiceNow. It's mostly interface
> and workflows and such, but the idea is that users want to submit for
> elevation and have managers who need to approve, and so forth.

So: an identity-governance surface for the four existing tenants. A user
asks for something they do not hold (a role in a tenant, membership of an
initiative, a time-boxed elevation), the people accountable for that thing
approve or refuse it, an approved request is **provisioned** into the same
grants the rest of the app already reads, and everything is auditable and
reviewable later. The emphasis is on the interface and the workflows, not
on a new authorization engine: Cedar and the grants table stay the
authority; this tenant is the governed way of changing them.

## 2. Decisions taken

| # | Decision | Why |
|---|---|---|
| A1 | A fifth tenant, `access`, with its own roles, Cedar seeds, routes (`/api/access/*`), portal tree (`/access/*`) and cast, registered through the same 21 points as `pipelines` (`docs/pipelines-tenant-goal.md` §P0). | Tenants are separate products that share only the BFF; approvals about the other tenants' access must not live inside any one of them. |
| A2 | The **grant store is the existing one**: `user_tenant_roles` + `project_contributions`, written only through `providers/identity.ts::setGrants` and the initiative contribution writer. Provisioning never writes a second table of "effective access". | Two stores for one fact is the split-worlds bug class this repo has already paid for (`decisions`, work comments). |
| A3 | A provisioning write bumps the beneficiary's `session_epoch`, so a granted or revoked role reaches their open cookie within the existing ≤120 s refresh. | The mechanism exists (`bumpSessionEpoch`); reusing it is what makes an approval take effect without a sign-out. |
| A4 | Approvers are resolved **live** from the directory and the org graph at decision time, never copied onto the request: the beneficiary's manager (new additive `people.manager_id`), then the resource's steward (initiative owner from `project_contributions`; a tenant's steward role holders for a tenant role: orgiq `hr-admin`, assessment `program-lead`, social `community-admin`, pipelines `pipeline-admin`). Sensitive items add an `access-admin` step. | A request that caches "who may approve" would let a demoted approver still decide. The same live-principal rule governs the realtime gateway and Social. |
| A5 | Nobody decides a request they submitted or benefit from, and a step is decided once. Enforced in the route (Cedar cannot see request rows) with a contract test, in addition to the Cedar role gates. | Separation of duties is the whole point; a role-only gate cannot express "not your own". |
| A6 | Requests are time-bound by default (8 h, 24 h, 7 d, 30 d) with "standing" as an explicit choice that needs an extra justification; expiry revokes through the same provisioning path. | Elevation, not permanent accumulation, is the SailPoint/ServiceNow pattern the user named. |
| A7 | Separation-of-duties policies are data (seeded, editable by `access-admin`), checked at submit and again at provision; a conflict blocks unless an `access-admin` records an override with a reason. | The conflicts already exist in Cedar as forbids (an `author` never approves a step they wrote); SoD makes them visible before the grant, not after. |
| A8 | Every request carries one discussion thread on the gateway, `access:req:<id>`, admitted to the requester, the current approvers and `access-admin`; the bell carries submit/decision/expiry items through the existing `notify()` helper. | The "one conversation per record" pattern (initiative Discussion, work-item thread) and the one notification path. |
| A9 | Every list page ships with the shared collection command composer from registration day, and the DOM audit policy classifies every `/access/*` route explicitly. | The tenant is mostly interface; it must be born on the house layout, type scale and composer contract rather than retrofitted. |
| A10 | Access reviews (periodic certification of standing grants) are phase A2, built on the same request/decision/provision model (a review decision that says "revoke" is a revocation request pre-approved by the reviewer). | Reviews reuse the workflow; shipping them first would duplicate it. |

Not decided here: whether `manager_id` is seeded from team leads or typed by hand in `/admin/identity/users` (the seed generator can do either); escalation timers; delegation while out of office; whether `admin` cross-tenant grants are requestable at all (default: no, they are provisioned by hand).

## 3. Model

Additive schema, `schema/access_schema.sql`, registered in both loaders and **not applied to Aurora** until the user decides, with the mock mirroring it row for row:

| table | holds |
|---|---|
| `access_catalog_items` | what can be requested: `kind` (`tenant-role`, `initiative-membership`), `tenant`, `role` or `project_id`, `sensitive` flag, `default_duration`, `steward_rule` |
| `access_requests` | `id`, `requester_id`, `beneficiary_id`, `item_id`, `justification`, `duration`, `status`, `submitted_at`, `decided_at`, `provisioned_at`, `expires_at`, `revoked_at` |
| `access_request_steps` | the approval chain computed at submit: `step` (1..n), `kind` (`manager`, `steward`, `access-admin`), `status`, `decided_by`, `decided_at`, `comment` — the *resolver* for who may decide a step runs live (A4); the row records who did |
| `access_policies` | SoD rules: two `(tenant, role)` pairs that must not be held together, `severity`, `reason` |
| `access_events` | the audit trail: every transition with actor, before/after and reason; append-only |
| `access_reviews`, `access_review_items` | phase A2 campaigns and their per-grant decisions |
| `people.manager_id` | additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, nullable, references `people(id)` |

Status machine: `draft → submitted → pending → approved → provisioned → active → expired | revoked`, with `rejected` and `withdrawn` as terminal side exits. Only `provisioned`/`active` ever touch the grant store.

## 4. Workflows

1. **Request.** Catalog (browse what can be requested, filtered by tenant and kind, with "you already hold this" and SoD warnings shown before submit) → request wizard (`WorkflowStepper`: who (self, or on behalf when `approver`/`access-admin`), what, why, how long) → policy pre-check → submit. The requester sees the computed chain and SLA immediately.
2. **Approve.** Inbox (`/access/approvals`): the steps the signed-in user may decide *now*, resolved live; approve / reject / request information, each with a comment; bulk is deliberately absent. Request detail shows the chain, the discussion thread, the beneficiary's current grants and the SoD check.
3. **Provision.** The last approval provisions: `setGrants` merge (or a contribution insert), `bumpSessionEpoch`, an `access_events` row, a bell item to the requester and beneficiary. Expiry is a sweeper over `expires_at` that revokes the same way; it is single-flight across replicas like the dispatcher's boot recovery (`lib/replica-fleet.ts`).
4. **Govern.** Policies (SoD matrix, `access-admin`), Audit (every event, filterable, exportable), Reviews (phase A2).

## 5. Roles and actions

| role | may | may not |
|---|---|---|
| `requester` | `ViewAccess`, `RequestAccess` (for self) | decide, configure |
| `approver` | requester's two + `DecideAccess`, `RequestAccess` on behalf of a report | `ManageAccessCatalog`, `ManageAccessPolicy`, `ProvisionAccess` (the system provisions; a person never writes a grant by hand here) |
| `access-admin` | approver's + `ManageAccessCatalog`, `ManageAccessPolicy`, `ProvisionAccess` (manual revoke, SoD override), `ManageUsers` | — (top of the ladder, like `program-lead`) |

Six actions: `ViewAccess`, `RequestAccess`, `DecideAccess`, `ManageAccessCatalog`, `ManageAccessPolicy`, `ProvisionAccess`. All six go in `CAPABILITY_ACTIONS` (an unlisted action hides its control for every role).

## 6. Pages (`/access/*`)

Rail groups Request / Approve / Govern / System; front door `/access/requests`.

| route | page | composer |
|---|---|---|
| `/access/catalog` | catalog table, kind/tenant filters, "Request" row action | required |
| `/access/requests` | my requests (and, for approvers, their reports') | required |
| `/access/requests/new` | the wizard | exempt: a form |
| `/access/requests/:id` | request record: chain, decision controls, thread in the right pane | required (the thread's composer) |
| `/access/approvals` | the inbox | required |
| `/access/policies` | SoD matrix | required |
| `/access/reviews` | campaigns (A2; honest empty state until then) | required |
| `/access/audit` | events | required |
| `/access/configuration` | durations, steward rules, sensitive items | exempt: configuration form |
| `/access/settings` | registered placeholder | exempt: placeholder |

Everything is drawn from `@connorhoehnslalom/ui-components`: `CollectionCommandPage` + `CollectionToolbar` + `DataTable` for every table, `WorkflowStepper` and the forms primitives for the wizard, `ConfirmDialog` for decisions, the shared conversation composer for the thread. Nothing hand-rolled; a missing primitive goes to the library first.

## 7. Isolation and integration

- `/api/access/*` mounts behind `requireTenant('access')`; the demo identity holds no `access` grant (`DEMO_EXCLUDED_TENANTS`), so the isolation walks start from the seeded cast.
- Reads of other tenants' grants for display use `providers/identity.ts` under the actor's current `access` grant; writes only through provisioning (A2).
- The thread family `access:req:` is registered in `lib/tenant-channels.ts` with cursors, admitted by the request's read rule (requester, live approvers, `access-admin`).
- The Communication plane is not embedded here in A0; `access` users who also hold Social see the footer as everyone does.

## 8. The work, in lanes

| lane | brings | judged by |
|---|---|---|
| **A0** registration + model + mock + routes + pages | the 21 registration points, the cast, `access_schema.sql` + mock fixtures, `/api/access/{summary,catalog,requests,approvals,policies,audit}` reads and the submit/decide/withdraw writes on the mock, every page honest and on the composer contract, DOM-audit policy for `/access/*`, journey logs per role × surface | `validate-access-tenant.sh --phase A0` |
| **A1** provisioning + expiry + notifications + thread | `setGrants` merge with epoch bump, the expiry sweeper, bell items, `access:req:<id>` thread, the self-approval and once-only contracts | `--phase A1` |
| **A2** policies + reviews | SoD evaluation at submit/provision with override, review campaigns on the same model | `--phase A2` |
| **E** evidence | Aurora application of the additive schema (user decision), native PostgreSQL contracts for the request/step tables, Cognito seed users | `--phase E` |
