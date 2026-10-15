# Access tenant — native PostgreSQL contracts, 2026-10-14

Lane A of `docs/refinement-plan-2026-10-14.md`; judged by
`scripts/validate-access-tenant.sh` §E. Nothing was applied to Aurora.

**What ran.** `middleware/src/lib/access/__tests__/access-postgres.test.ts`
against a dedicated disposable container, `orgiq-access-postgres-acceptance`
(image `pgvector/pgvector:pg16`, `sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a`,
PostgreSQL 16.15, label `orgiq.validation=access-postgres`, network mode
`none`, no published ports). The suite loads the unmodified
`orgiq_schema.sql`, `identity_schema.sql` and `access_schema.sql` into a
fresh schema and executes the exact statements in
`middleware/src/lib/access/sql.ts`; only the RDS Data API transport is
replaced (one `psql` process per call, so concurrent calls are concurrent
transactions on separate connections).

```
REAL_ACCESS_POSTGRES=1 ORGIQ_ACCESS_POSTGRES_CONTAINER=orgiq-access-postgres-acceptance \
ORGIQ_DOCKER='colima ssh -- sudo docker' npx jest src/lib/access/__tests__/access-postgres.test.ts
```

**Result: 9/9, two consecutive runs** (the second below).

```
    ✓ applies the additive schema again as a no-op, and upgrades a cluster that carries the pre-2026-10-14 event checks (4355 ms)
    ✓ two racing submits for the same person and item file once; a withdrawn request frees the slot (6262 ms)
    ✓ twelve concurrent approvers decide a step once: one claim, one event set, the next step current (7011 ms)
    ✓ nobody decides a request they submitted or benefit from — not through the statement, not through any other writer (5387 ms)
    ✓ provisioning is idempotent: eight racing provisioners write one grant, one activation, one event — and a crash resumes (9690 ms)
    ✓ single-role grant writes never lose a concurrent grant; setGrants' delete-and-reinsert does (5923 ms)
    ✓ the expiry sweep is single-flight: six racing sweepers and a person's revoke end each grant once (24614 ms)
    ✓ a current step escalates once per level under six racing sweeps, and never once decided (9577 ms)
    ✓ delegations: never to oneself, a window that ends after it starts, in force only inside it, ended once (6853 ms)
Test Suites: 1 passed, 1 total
Tests:       9 passed, 9 total
Time:        89.938 s
```

**What it proves.**

- The additive schema re-applies as a no-op, and a cluster built before
  2026-10-14 (unnamed target check, old event kinds) is upgraded by re-applying it.
- Ten racing submits for one beneficiary and item insert one request
  (`access_requests_one_open_idx`); a withdrawn request frees the slot.
- Twelve concurrent approvers claim a step once (one `step-approved` event, the
  next step current with its escalation clock); a late approver and an
  approve/reject/approve race on the last step also decide once.
- Nobody decides a request they submitted or benefit from — the statement
  claims nothing, and a direct `UPDATE` is refused by the
  `access_step_decision_guard` trigger; a decided step never changes again; a
  delegate's decision records `delegated_from`.
- Eight racing provisioners: one claim, one grant row, one activation, one
  `provisioned` event; a crash after the claim resumes exactly once.
- `GRANT_ROLE_SQL` keeps two concurrent grants for one person; the cluster
  half of `providers/identity.ts` `setGrants` (delete every row, re-insert the
  caller's merged set) loses one when two merges interleave. **Finding:** the
  cluster provisioning must use the single-role statements, not `setGrants`;
  offline, `lib/access-provision.ts` now serializes the merge per beneficiary
  (mock contract in `lib/__tests__/access-provision.test.ts`).
- The expiry sweep is single-flight: six racing sweepers and a person's revoke
  end each of three grants once (three events, no role left, epochs bumped by
  the winner); the 24-hour warning is claimed once under six callers.
- A current step escalates once per level under six racing sweeps, never past
  level 2 (CHECK), never once decided.
- Delegations: never to oneself, never an inverted window (CHECKs), in force
  only inside the window, ended once under five racing callers.

**What it does not prove.** Aurora, IAM, the Data API's own binding and
transaction semantics, and the cluster half of `providers/access.ts`, which
still answers 503 off the mock until the user decides to apply the schema
(lane E). The statements are the ones that half will run; the mock's
compare-and-set (`casRequest`, `casStep`) mirrors them in one tick.

## Addendum — grant writes fixed at the source (2026-10-14, later)

The finding above is closed in `providers/identity.ts`: provisioning and
revocation call `grantRole` / `revokeRole` (one `GRANT_ROLE_SQL` /
`REVOKE_ROLE_SQL` row, now owned by `lib/identity-grants-sql.ts` and
re-exported from `lib/access/sql.ts`); `setGrants`, whose one remaining
writer is the admin editor (`PUT /api/identity/users/:id/grants`, and
`POST /api/identity/users` at creation), applies only the diff from the
matrix the editor loaded (`base`, sent by `UsersPage.tsx`; read inside the
transaction when absent), one row per statement, in one Data API
transaction (`writeGrantSet`, shared with the contract). No writer deletes a
user's whole set. Epochs unchanged: grants and admin edits never bump;
revocation and expiry bump in `lib/access-provision.ts`. The mock applies the
same per-row diff in one tick, so the per-beneficiary lock is gone.

The setGrants contrast case was replaced by three races; the suite is now
**11/11** on the same container:

```
    ✓ grant + grant: concurrent single-role grants for one person never lose a role, and bump nothing (32383 ms)
    ✓ grant + revoke: a provisioning racing a revocation keeps one, removes the other; only the revoke bumps (19821 ms)
    ✓ admin edit + provisioning: the whole-set editor applies a diff in one transaction and never erases a concurrent grant (7464 ms)
Tests:       11 passed, 11 total
Time:        116.886 s
```

- grant + grant: twenty rounds of four concurrent grants (two roles) keep
  both; epoch 0. The old delete-and-reinsert, interleaved, still drops one
  (kept in the test as the contrast).
- grant + revoke: ten rounds of a grant racing a revoke-then-bump keep the
  granted role, remove the revoked one, epoch +1 per round.
- admin edit + provisioning: the editor's transaction is held open on its own
  connection (one psql session) while another connection commits a grant or a
  revoke-and-bump between its base read and its writes. With no base, with a
  stale loaded base, and with a concurrent revocation of a role it does not
  change, nothing the other writer did is undone; ten editors and ten
  provisioners at once on distinct roles land all 20 rows; the only epoch
  bump is the revocation's.

Mock mirror: `lib/__tests__/access-provision.test.ts` "concurrent writers to
one person's grants" (the same three races through `provisionAccess`,
`revokeAccess` and `setGrants({ base })`). Data API wire shape:
`providers/__tests__/identity-grant-writes.test.ts`. Still not Aurora.
