# `access` tenant — gate record, 2026-10-13

Goal: `docs/access-tenant-goal.md`. Judge: `scripts/validate-access-tenant.sh`.
Design: `docs/access-tenant-design.md`; wire shapes `docs/access-tenant-api.md`.
Everything below ran on the local Tilt stack (`dev:mock` BFF :3001, Vite
:5183) with ui-components **2.441.8**; nothing was deployed and no schema was
applied to Aurora.

## What was built (A0 → A2, one day)

- Registration: the 21 points (tenant, three roles and Cedar seeds, six
  actions, cast u-rhea / u-omar / u-priya, Cognito seed users, portal rail,
  palette, routes, picker, branding, switcher), `access:req:` thread family.
- Model: `schema/access_schema.sql` (catalog, requests, steps, policies,
  events, reviews, review items, `people.manager_id`), additive, registered in
  both loaders, **not applied to Aurora**; mock fixtures mirror it row for row.
- Workflow: catalog → request wizard (policy pre-check) → live approver
  chain (manager, steward, access-admin; escalation when nobody is eligible)
  → provisioning through `providers/identity.ts::setGrants` (grants refresh
  delivers the role to the open cookie; revocation and expiry bump the epoch)
  → expiry sweeper (single-flight across replicas) → bell items → one thread
  per request. Separation of duties as policy data checked at submit and at
  provisioning with an access-admin override; manual revoke; review campaigns
  that keep or revoke standing grants through the same path; configuration
  GET/PUT; audit scoped by the read rule.
- Contracts: route and library suites under `middleware/src/routes/__tests__/access*.test.ts`,
  `lib/__tests__/access-*.test.ts`, `lib/access/__tests__/`, gateway facade
  rows for the thread family; portal node tests under `pages/access/__tests__/`.

## Gate

| check | result |
|---|---|
| `validate-access-tenant.sh` (A0 → E) | see `--quick`/full lines below |
| DOM audit `--tenant access --all --strict-coverage` light+dark 1440+900 | filled from `.scratch/ui-dom-audit-access-final-20261013/summary.txt` |
| journey logs (3 roles × 8 surfaces + 7 isolation) | 31 walked twice (first walk found 10 defects, all fixed), all `verdict: pass`, sealed by `scripts/journeys/seal.sh docs/access-journeys` |
| portal typecheck + unit | 0 errors, 1,877 tests |
| route-coverage / mock-floor / nav-parity / component-discipline | green at the A2 commit |

## Decisions taken on the way (recorded in the design doc)

Approvers must hold an access grant; a step with no eligible decider escalates
to the access-admins (then to `admin` holders); approvers file for direct
reports only; reject/info require a comment; provisioning does not bump the
session epoch, revocation and expiry do; revocation requests carry
`kind: 'revocation'` and are not catalog items.

## Not done / user decisions

Aurora application of `access_schema.sql`; native PostgreSQL contracts for the
request/step tables; the wizard cannot pick an arbitrary person for an
access-admin (the API can); `admin` cross-tenant grants are not requestable;
escalation timers and delegation; `GET /configuration` is readable by every
access role (write is admin-only).
