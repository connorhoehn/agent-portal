# DE-13 Low-latency directory and graph reads

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Touches the capacity decision (1 vCPU BFF) in `CLAUDE.md`; independent of
DE-12.

**The backlog's last line is wrong.** Data API latency is not the cause of the
~9 s call join window. The parallel-call split was a gateway race (two first
page-huddle joins both passing the live-call check), fixed by an atomic
per-lobby claim in realtime-modules 0.140.0
(`docs/local-followups-goal-2026-10-27.md` "Findings", item 4;
`docs/aws-deploy-open-items-2026-10-27.md` item 1 update). Slow reads only
widen that window. This spec stands on read latency alone.

## Current state (read from the code, 2026-10-27)

**Every authoritative read is one Data API `ExecuteStatement`.** Eight modules
build their own `ExecuteStatementCommand` (`grep -rl ExecuteStatementCommand
middleware/src`); the main two are `providers/aurora.ts:120` (`exec`, used by 71
modules) and the self-contained `providers/identity.ts:238`. A Data API
transaction is three or more HTTPS calls (`aurora.ts:158`). Per-call latency
in the deployed task has never been measured: the open-items doc estimates
200–300 ms and says it is not instrumented. The one measured figure is
`GET /api/calls/:id/chat` at ~3.3 s on AWS (`CLOUD_TIMELINE=1`,
`portal/e2e/cloud-call-smoke.spec.ts`).

**The directory read is deliberately uncached.** `readCurrentUsers`
(`identity.ts:355`) reads `app_users` ⨝ `user_tenant_roles` for epoch and grants
together. `queuedAuthoritativeUser` (`identity.ts:377`) only coalesces reads
queued in the same tick (`setImmediate`, batches of 128); the comment at
`identity.ts:347` is the rule: no settled positive cache, every later action
starts a new read, so revocation is immediate. This spec keeps that rule.

**How many reads a hot path makes.**
- REST: the cookie's grants are refreshed from the directory at most every
  `GRANTS_REFRESH_S` = 120 s (`lib/session.ts:482`, `:516`). Cheap.
- Live/socket paths: `currentLiveSession` (`lib/live-principal.ts:51`) reads the
  user (and the masquerading actor, in parallel, same batch) on every call; it
  has 64 call sites.
- Call seat proof, `POST /api/realtime/lobby-access`
  (`routes/realtime-lobby-access.ts:61` → `lib/call-media-proof.ts:32`):
  three `currentLiveSession` rounds (`:43`, `:53`, `:60`) and three
  `activeCallParticipant` rounds (`:46`, `:54`, `:61`), each of which reads
  authority twice (`lib/call-access.ts:93`, `:107`). That is **nine sequential
  directory round trips** before platform-api admits a leg, plus the host check
  (AVP `isAllowed`, `live-principal.ts:176`). At the estimated 200–300 ms each
  that is 1.8–2.7 s of directory alone (estimate, not measured). The re-reads
  are intentional: "a distributed connection-directory read can outlive
  identity revocation" (`call-access.ts:106`).

**Network.** Aurora sits in its own VPC with isolated subnets and no NAT
(`infra/lib/aurora-stack.ts:47`); its security group admits 5432 only from that
VPC's CIDR (`aurora-stack.ts:89`). The BFF runs in a separate
`orgiq-middleware-vpc` (`infra/lib/middleware-service-stack.ts:204`). Agent
runtimes run in `networkMode: 'PUBLIC'` (`agentcore-runtime-stack.ts:415`). So
nothing can open a TCP connection to the cluster today; RDS Proxy has the same
problem, since it also lives in the cluster's VPC. `pg` 8.23.1 is a
devDependency only (`middleware/package.json:72`, used by the access Postgres
contract test).

**Agents.** `search` and `advisor` run model-authored SQL through the Data API
with the `orgiq_graph_reader` secret (`agents/_shared/db_credentials.py:40`,
`read_secret_arn` fails closed without `AURORA_READONLY_SECRET_ARN`; set only
for read agents, `agentcore-runtime-stack.ts:327`, `:453`). `sql_guard.py`
checks the SQL first (`agents/search/main.py:169`). The role's
`default_transaction_read_only` and 30 s `statement_timeout` are role settings
(`schema/graph_readonly_role.sql:94-95`), so they hold on any connection path.

## Change

**1. Measure before moving.** Wrap both `exec` functions with a timer and emit
`orgiq.db.statement_ms` (labels: module, `authoritative`, ok/error) and a
per-request count of directory rounds. Ship this first and read the deployed
numbers; the rest of the change is sized by them.

**2. A direct pool for the BFF's authoritative directory read only.** A
`DirectoryReader` interface in `providers/identity.ts` with two
implementations: the current Data API one and a `pg.Pool` one (`pg` moves to
dependencies; pool max 5, TLS `verify-full` with the RDS CA bundle, 2 s
statement timeout). `readCurrentUsers` keeps its SQL and its row mapping; the
queue, batch size and no-positive-cache rule are untouched, so each round is
still a fresh read, only cheaper. On a pool error the read falls back to the
Data API (same authority, slower), never to fixtures (`identity.ts:331-336`).
The pool logs in as a new `orgiq_directory_reader` role: `SELECT` on
`app_users` and `user_tenant_roles` only, read-only by default, created the
way `graph_readonly_role.sql` is, password from a new Secrets Manager secret.
Every other module stays on the Data API in this item; widening the pool to
`aurora.ts` is a follow-up because Data API rows return naive timestamps and
the mappers depend on that (`CLAUDE.md`, "The RDS Data API returns naive
timestamps").

**3. Network.** Either peer `orgiq-middleware-vpc` with `orgiq-aurora-vpc`
(routes both ways, Aurora SG ingress from the middleware service SG on 5432),
or move the cluster into the middleware VPC. Peering keeps the Aurora stack's
lifecycle separate. Note the account custodian closes open security groups
(`CLAUDE.md`); SG-to-SG rules are not open ingress but are unverified against
it.

**4. Agents stay on the Data API.** Their reads sit inside multi-second model
turns, runtimes are per-session microVMs (a pool would churn; that is the case
RDS Proxy exists for), and `PUBLIC` mode cannot reach the VPC. `sql_guard.py`,
`orgiq_graph_reader` and fail-closed `AURORA_READONLY_SECRET_ARN` are
unchanged. Revisit only if step 1 shows graph reads matter.

**RDS Proxy vs direct pool, for the BFF.** The BFF is one long-lived task
(single-gateway safeguard), so a small pool needs no multiplexing; Proxy adds
a hop, per-ACU cost and its own Serverless v2 constraints (cost model and
Serverless v2 support unverified here). Proposal: direct pool now, Proxy when
the BFF scales past a handful of tasks or agents move in-VPC.

## Decisions owed

- Peer the VPCs or move Aurora into the middleware VPC. Proposal: peer.
- Whether to cut the seat proof's nine rounds. Each re-read narrows a
  revocation race, so fewer rounds is a security trade, not a refactor.
  Proposal: keep all nine and make each cheap; revisit with step 1's numbers.
- Whether to widen the pool beyond the directory read. Proposal: not in DE-13.

## Done when

- `cd middleware && npx jest src/providers/__tests__/identity-direct-reader`
  passes against a native PostgreSQL 16 container (the access-postgres pattern):
  the pool and a recorded Data API reader return identical `UserInfo` for the
  seed users; bumping `session_epoch` between two reads shows the new epoch on
  the second (no positive cache); a pool failure falls back to the Data API and
  never to a fixture.
- A unit test pins the seat proof at nine directory rounds
  (`CallMediaProofRuntime.get` with a counting reader), so a change is visible.
- `cd infra && npm test`: the middleware SG reaches the Aurora SG on 5432, the
  task role can read the directory-reader secret and not the admin one for the
  pool, and read agents still carry `AURORA_READONLY_SECRET_ARN` with no direct
  endpoint.
- `cd agents/_shared && ../../.venv-synth/bin/python -m unittest
  test_gateway_sql` and `cd agents/tests && ../../.venv-synth/bin/python -m
  unittest test_readonly_role test_read_tool_guard` pass unchanged.
- In AWS (unverified until credentials return): `orgiq.db.statement_ms` shows
  pool reads and Data API reads side by side, and `cloud-call-smoke` with
  `CLOUD_TIMELINE=1` and `CLOUD_SEAT_SETTLE_MS=0` records the lobby-access and
  call-chat timings before and after.
