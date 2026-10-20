# Access tenant — native PostgreSQL contracts, 2026-10-19

Refresh of the 2026-10-14 record for the Redis migration branch
(`fix/handoff-redis-20261018`), judged by `scripts/validate-access-tenant.sh`
§E. The statements in `middleware/src/lib/access/sql.ts` changed on this
branch (`1e9efc24`: the grant SQL is shared and the grant edit is
transaction-based), so the earlier record was older than what it proved.
Nothing was applied to Aurora.

**What ran.** `middleware/src/lib/access/__tests__/access-postgres.test.ts`
from the branch worktree against the same dedicated disposable container as
on 2026-10-14, `orgiq-access-postgres-acceptance` (image
`pgvector/pgvector:pg16`, PostgreSQL 16.15, label
`orgiq.validation=access-postgres`, network mode `none`, no published ports;
created 2026-10-14, started again after a `colima restart`). The suite drops
and recreates its `access_acceptance` schema, loads the unmodified
`orgiq_schema.sql`, `identity_schema.sql` and `access_schema.sql`, and
executes the exact statements from `lib/access/sql.ts`, one `psql` process
per call, so the races are concurrent transactions on separate connections.

```
REAL_ACCESS_POSTGRES=1 ORGIQ_ACCESS_POSTGRES_CONTAINER=orgiq-access-postgres-acceptance \
ORGIQ_DOCKER=docker npx jest src/lib/access/__tests__/access-postgres.test.ts
```

**Result: 11/11, run alone.**

```
PASS src/lib/access/__tests__/access-postgres.test.ts
  access tenant on native PostgreSQL 16
    ✓ applies the additive schema again as a no-op, and upgrades a cluster that carries the pre-2026-10-14 event checks (426 ms)
    ✓ two racing submits for the same person and item file once; a withdrawn request frees the slot (386 ms)
    ✓ twelve concurrent approvers decide a step once: one claim, one event set, the next step current (670 ms)
    ✓ nobody decides a request they submitted or benefit from — not through the statement, not through any other writer (544 ms)
    ✓ provisioning is idempotent: eight racing provisioners write one grant, one activation, one event — and a crash resumes (912 ms)
    ✓ grant + grant: concurrent single-role grants for one person never lose a role, and bump nothing (4137 ms)
    ✓ grant + revoke: a provisioning racing a revocation keeps one, removes the other; only the revoke bumps (2725 ms)
    ✓ admin edit + provisioning: the whole-set editor applies a diff in one transaction and never erases a concurrent grant (973 ms)
    ✓ the expiry sweep is single-flight: six racing sweepers and a person's revoke end each grant once (1887 ms)
    ✓ a current step escalates once per level under six racing sweeps, and never once decided (607 ms)
    ✓ delegations: never to oneself, a window that ends after it starts, in force only inside it, ended once (480 ms)

Tests:       11 passed, 11 total
Time:        16.561 s
```

**A failure that was not one.** At 18:58 two sessions ran this suite against
the one container at the same time. Both share the `access_acceptance`
schema name, so each saw the other's `DROP SCHEMA … CASCADE` and reseeding:
4–5 tests failed on duplicate keys, missing foreign rows and a lost grant.
The suite passed 11/11 on `main` alone a minute later and 11/11 on the branch
alone here. The suite is single-tenant on its container by design; run it
alone.

Like the 2026-10-14 record this proves the statements against PostgreSQL 16
semantics only. Aurora, IAM and Data API binding remain unverified; the three
additive schema files are still not applied to Aurora.
