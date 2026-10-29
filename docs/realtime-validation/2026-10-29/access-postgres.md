# Access tenant — native PostgreSQL contracts, 2026-10-29

Refresh of the 2026-10-19 record, judged by `scripts/validate-access-tenant.sh`
§E. `INSERT_REQUEST_SQL` in `middleware/src/lib/access/sql.ts` changed in
`2c352c95` (the sprint-envelope request binds `requested_usd` and `forecast`),
so the earlier record was older than what it proved, and this opt-in suite
still bound the old parameter set. The suite's two submits now pass
`requested_usd: null, forecast: null` (ordinary role requests carry neither).
Nothing was applied to Aurora.

**What ran.** `middleware/src/lib/access/__tests__/access-postgres.test.ts`
against a dedicated disposable container started for this run and stopped
after it: `orgiq-access-pg-20261029` (image `pgvector/pgvector:pg16`,
PostgreSQL 16.15, database `orgiq_validation`, label
`orgiq.validation=access-postgres`, network mode `none`, no published ports).

```
REAL_ACCESS_POSTGRES=1 ORGIQ_ACCESS_POSTGRES_CONTAINER=orgiq-access-pg-20261029 \
ORGIQ_DOCKER=docker npx jest src/lib/access/__tests__/access-postgres.test.ts
```

**Result: 11/11, run alone.**

```
PASS src/lib/access/__tests__/access-postgres.test.ts (16.89 s)
    ✓ applies the additive schema again as a no-op, and upgrades a cluster that carries the pre-2026-10-14 event checks (433 ms)
    ✓ two racing submits for the same person and item file once; a withdrawn request frees the slot (409 ms)
    ✓ twelve concurrent approvers decide a step once: one claim, one event set, the next step current (718 ms)
    ✓ nobody decides a request they submitted or benefit from — not through the statement, not through any other writer (577 ms)
    ✓ provisioning is idempotent: eight racing provisioners write one grant, one activation, one event — and a crash resumes (979 ms)
    ✓ grant + grant: concurrent single-role grants for one person never lose a role, and bump nothing (3581 ms)
    ✓ grant + revoke: a provisioning racing a revocation keeps one, removes the other; only the revoke bumps (2765 ms)
    ✓ admin edit + provisioning: the whole-set editor applies a diff in one transaction and never erases a concurrent grant (1016 ms)
    ✓ the expiry sweep is single-flight: six racing sweepers and a person's revoke end each grant once (1941 ms)
    ✓ a current step escalates once per level under six racing sweeps, and never once decided (684 ms)
    ✓ delegations: never to oneself, a window that ends after it starts, in force only inside it, ended once (477 ms)
Tests:       11 passed, 11 total
```

Not covered here: an envelope request with a non-null amount and forecast
through the cluster statement (the route suite proves it on the mock store).
