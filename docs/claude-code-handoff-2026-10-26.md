# Claude Code handoff — October 26, 2026

This is the current handoff. Start in `/Users/connorhoehn/Projects/aws-agentcore`.
The user asked Codex to hand this work to Claude Code. Codex stopped new
implementation; no test, install or owned broker process is intentionally left
running. Do not run Codex and Claude against the same worktree concurrently.
Older handoffs and dated verification records are historical evidence, not a
substitute for the state below. Recheck Git and running artifacts before edits.

## Update — the AWS deploy (2026-10-27, evening)

The platform now runs in AWS (account 647757222309): 22 stacks, the
middleware, platform-api and document workspace on ECS, 8 runtimes, the portal
on CloudFront, and the three additive schemas applied to Aurora. That deploy's
open items are in `docs/aws-deploy-open-items-2026-10-27.md` and its backlog
in `docs/deployment-enhancements-2026-10-27.md`; the "credentials" and
"cloud" caveats below predate it. The work that can be finished without AWS
is tracked in `docs/local-followups-goal-2026-10-27.md`.

## Update — queue migration and projection consumer (Claude Code, 2026-10-27, later)

Pushed: message-queue 0.6.0 (`3cc40aa`, tag `v0.6.0`) with the legacy `ddb` →
`ddb-v2` migration and reverse-transfer tool (README "Moving legacy `ddb` data"),
and realtime-examples `be3c604d`, whose gateway now drains
`work-graph.projection.changed.v1` and re-broadcasts it on Redis; the C9 run
passed with it. Still open: AgentCore durable profile on live Aurora
(credentials), running the migration on a real table, managed-nosql-store
transactions, browser rendering, cloud/capacity and the journey backlog below.

## Update — WebSocket leg and replicated brokers (Claude Code, 2026-10-27)

The gateway WebSocket leg and `durable-replicated` brokers passed locally; see
the ledger's last section. Pushed: message-queue 0.5.3 (`8736e3c`), platform-api
`e0be5e0` (a day's first activity no longer revokes an open stream),
realtime-examples `ea69aad8` (reader container and `MQ_REPLICAS=2`). Still open:
AgentCore durable profile on live Aurora (credentials), legacy-to-`ddb-v2`
migration, managed-nosql-store transactions, a durable consumer for
`work-graph.projection.changed.v1`, cloud/capacity and the UI/backend journey
backlog below.

## Update — C9 local acceptance passed (Claude Code, same day)

The catalog pin checkpoint, subscription selection, host readiness and the
durable result/realtime proof are done and pushed. Read the last section of the
[ledger](chassis-extensibility-goal.md) and
[c9-durable-result-verification.json](chassis/c9-durable-result-verification.json)
before the older sections below, which describe the state this session started
from. Still open: replicated brokers, AgentCore's durable profile on live Aurora
(credentials), the gateway WebSocket leg, cloud/capacity, and the UI/backend
journey backlog further down.

## Objective and user decisions

Finish the **three chassis improvements** in their owning repositories and adopt
them in AgentCore and realtime-modules:

1. Durable queue delivery and worker ownership, including restart, delay, FIFO,
   dead-lettering, subscription backlog and stale-worker fencing.
2. Shared owner contracts/clients and reusable realtime composition/room contracts.
3. Declarative runtime capabilities and truthful startup/readiness for enabled
   features and required dependencies.

The executable plan is [C0–C9](chassis/implementation-plan.md), especially
**C9 execution path — source inspection, 2026-10-26**. The
[completion ledger](chassis-extensibility-goal.md) remains unfinished. C0–C8 owner
work has local evidence; **C9 host adoption, readiness and the end-to-end durable
result/realtime path remain**. Do not report the overall goal complete from
package tests or a green UI alone.

The user has already authorized implementation and pushing changes in every
related repository. Work autonomously within that scope; no further push
confirmation is needed. Repositories use direct main integration, not a PR
workflow. The catalog preparation branch below is an explicitly unfinished
handoff checkpoint, not an accepted main release.

Other standing decisions:

- The product target is actual backend readiness and UI that is understandable at
  first glance, across tenants. A guided-demo percentage does not describe that.
- Hangouts remember saved rooms and assignments and allow temporary breakouts.
  Assignments, access grants, active attendance and IVS/native media sessions are
  distinct facts. Activity/summaries must come from authorized real data.
- Use the existing UI component library and tenant shell. The user rejected a
  detached concept webpage and squeezed call/chat layouts. For further redesign,
  use image-generation concepts as references, then implement and audit the real app.
- ESM is the target, but **TD-ESM-01 is opportunistic only**: convert code already
  being changed when its package boundary permits. No standalone module migration.
- Ignore the terrain/Blender/environment/storyboard requests in the conversation;
  the user explicitly identified them as wrong-chat messages.

## Read these first

1. This file and root `CLAUDE.md`; read each owner repo's instructions before edits.
2. [Implementation plan](chassis/implementation-plan.md) and
   [ledger](chassis-extensibility-goal.md).
3. [C5 subscription release evidence](chassis/subscription-verification.json).
4. [C6 catalog lifecycle](chassis/catalog-consumer-verification.json),
   [C7 job attempts](chassis/job-attempt-verification.json), and
   [C8 realtime contracts/composition](chassis/realtime-composition-verification.json).
5. [Product readiness and tenant journey backlog](design/product-readiness/README.md)
   for UI and broader backend work after/alongside the agreed chassis priority.

The October 12 handoff is an append-only history with many outdated checkpoints.
This file supersedes its introductory status. The October 23 clone cleanup and
old Social defect work are already completed; do not restart them unnecessarily.

## Repository state at transfer

All paths below are under `/Users/connorhoehn/Projects`. All 11 main checkouts
were clean, fetched and equal to `origin/main` before this handoff-only commit.
AgentCore's handoff commit advances its main beyond the checkpoint listed here.
Other owner main heads do not change during handoff preparation.

| Repo | Main checkpoint | Version / purpose |
| --- | --- | --- |
| aws-agentcore | `a367c391ca1cc2fa70f0427a3ca41a6825572abf` | C5 evidence and concrete C9 path; this handoff follows it |
| message-queue | `316c35f3694f8110ae7bd0fbb3097881cddc849b` | **0.5.0**, pushed and tagged `v0.5.0` |
| event-catalog | `4e8910f70486d335014d6d6eb93fa842ae8bed32` | 0.9.0; C6 released, C9 not on main |
| service-runtime | `c01db0e6dfe0e6b91081ae92ee5cc3c1e77d2ad6` | 0.5.1; capability evaluator and bounded lifecycle |
| distributed-core | `f0931a9b5c8fbd41d02c2a02d570c6d064a0da7c` | 0.49.0; consumers may intentionally retain compatible older pins |
| realtime-modules | `c002e5e86f61bad8c6534826561f55d6471f0a8d` | 0.139.0; C8 composition and shared room plan |
| platform-api | `9df95617fe096646923ec537b9ef8cfbaec3d3b5` | Shared room-plan adoption and CAS checks |
| pipeline-runtime | `9c308b0b15b62f7f0644cca1c5e8ba8f928b7668` | 1.2.1; reuse existing bridge ready/shutdown |
| live-video-streaming | `631d0c02016394410f92663bb02cb48a63f58a34` | 1.0.0; existing native media compatibility consumer |
| realtime-examples | `b727380402ae76fe9fbbb8000b8eadf7bb141e7c` | 0.1.0; owned integration harness and gateway |
| ui-components | `f23d75cffb74978fe60a50d1bdd8a0daf9945e15` | 2.481.2; shared hangout UI release |

Useful worktrees:

- `aws-agentcore-chassis-attempts`, branch `codex/chassis-attempts`: main-aligned;
  contains this handoff commit after integration.
- `message-queue-chassis-subscriptions`, branch `codex/chassis-subscriptions`:
  clean and main-aligned at `316c35f`; branch is pushed. Ignored `.scratch/` has
  detailed C5 logs and packed artifacts. Its node_modules symlink points at the
  owner's main installation; do not delete that shared dependency tree.
- **`event-catalog-chassis-adoption`**, branch **`codex/chassis-adoption`**, pushed
  at **`e239a54520965122a4d1da677a660a3f741820ca`**: the only unfinished checkpoint.
  Its tracked tree is clean. See the next section before using it.
- Existing `platform-api-chassis-rooms` and `ui-components-hangouts` were earlier
  isolated worktrees. Inspect their Git status before reuse.
- `aws-agentcore/.claude/worktrees/e3b` on `e3-prejoin` is unrelated work. Leave it
  alone; do not reset or merge it as part of chassis cleanup.

## Exact interruption point: catalog adoption preparation

No C9 catalog source implementation has been written yet. The preparation branch
changes **only `package.json` and `package-lock.json`**, pinning MQ from 0.4.0 to
0.5.0 at full SHA `316c35f3694f8110ae7bd0fbb3097881cddc849b`.
The installation is independent of catalog main: its node_modules was copied with
APFS clone semantics, then updated in the isolated worktree.

Command completed:

```sh
npm install --ignore-scripts --no-audit --no-fund \
  '@connorhoehnslalom/message-queue@github:connorhoehnslalom/message-queue#316c35f3694f8110ae7bd0fbb3097881cddc849b'
```

**Known failure:** this script-disabled Git install has package version 0.5.0 but
no `dist/client/index.cjs` or declarations. `npm run build` then failed with
TS2307 for `@connorhoehnslalom/message-queue/client`, followed by derivative type
errors. The packed catalog check failed for the same missing artifact. These are
not accepted checks and not evidence of a source regression. The failed compiler
emitted two changed tracked declaration files; only those generated changes were
restored. No catalog source change was discarded.

First resolve this installation boundary: use the package's supported Git prepare
path or a verified built artifact, then check actual exported files and the lock
resolution. Do not patch around missing types, hand-copy a client implementation,
or claim a matching version proves the install. MQ's clean-build and packed-client
checks already pass. A locally packed MQ artifact has integrity:

`sha512-El8r16UFdHA3fspD73edRSKO93IZdhyMk84a6I3Ebt/dBwNS8223bk0S+ko2zdNN/PGjJxmEtmii3/njBx/SVA==`

The `--ignore-scripts` Git install's lock integrity differs, and its installed
package lacks build output; do not treat it as equivalent to that verified package. The
branch is intentionally **not merged into catalog main**, tagged or deployed.
Full catalog tests and actual-broker tests have not run on this pin.

## C9: continue in this order

### 1. Explicit catalog subscription selection

Owner files:

- event-catalog `src/client/durable.ts`: `DurableSubscribeOptions`, `subscribe`,
  `pollLoop`; the receive call currently always uses the default scope.
- `src/types/index.ts`: public `SubscribeOptions`.
- `src/client/index.ts`: forwards catalog options into durable subscriptions.
- `tests/catalog-durable-policy.test.ts`, `tests/durable-broker.test.ts`, and
  `scripts/verify-durable-package.mjs` are the existing fixtures to extend.

Add an optional **queue-owned subscription handle** (ID plus generation) and
forward it through the owner HTTP client. Preserve default consumers. Hosts or
operators provision subscription lifetime explicitly; catalog disconnect/unsubscribe
only stops intake/drains handlers and must never delete the queue subscription.
Reject using a durable handle for signal delivery. A stale handle must not trigger
fallback to the default scope or automatic re-creation. Keep all receive, renewal,
ACK and bounded cancellation/drain semantics from C6.

Test two groups receiving independent copies, same-group competition, offline
backlog/rejoin, stale-generation refusal, and no subscription deletion on catalog
shutdown. The actual-broker fixture resolves the **installed** MQ package, not
sibling source. Once the pin/artifacts and source pass, release the owner, integrate
main and push before downstream pinning.

### 2. Host artifact adoption and capability declarations

Adopt required MQ/catalog/service-runtime revisions in platform-api, AgentCore
and the executable realtime example. Realtime-modules already owns C8 contracts;
keep its browser entries pure and its core transport-agnostic. Do not introduce
an MQ SDK into browser hooks. Resolve actual artifacts and compatibility rather
than blindly upgrading every distributed-core pin to the newest version.

Concrete gaps from source inspection:

- Platform `src/routes/health.ts` checks DDB, Redis, build and optional model.
  `src/index.ts` treats catalog connection failure as non-fatal, and a null
  `pipelineWiring.ready` result does not make health fail. Declare which enabled
  capabilities are mandatory, validate them before opening resources, and expose
  required MQ/catalog/pipeline loss or bootstrap failure in readiness.
- AgentCore `middleware/src/lib/health-handler.ts` already returns 503 on router
  lease loss, but unhealthy/stale AWS or datastore snapshots still return 200.
  Apply the selected host profile to required stores, queue and job schema.
  Preserve intentionally local/mock operation; do not make optional services
  block every feature. Keep liveness separate from dependency readiness.
- C7 requires `schema/local_compute_worker_schema.sql` before new push claims.
  Old push executors contain unconditional SQL: drain/stop them before enabling
  new claimants. A mixed old/new rolling deploy is not accepted. Verify this schema
  requirement in readiness rather than claiming a local SQL test applied Aurora.

Retain existing domain authorization, transactional outbox ownership, scheduler
claims and job-attempt fences. The pipeline executor stays in platform-api.

### 3. Durable result and realtime proof

Extend realtime-examples `examples/middleware-foundation/acceptance.py` and
`compose.yml`; reuse their UUID-owned Compose setup. They currently assume legacy
`ddb`, managed-nosql-store and successful WS upgrades. Adapt the supported
transactional polling path first against actual DynamoDB Local. Alternative
DynamoDB-wire stores need the same conditional/transaction contract before being
accepted; the database URL alone does not establish those capabilities.

Exercise existing application code through:

`transactional domain/outbox write → MQ → consumer → idempotent durable result → realtime projection`

Relevant owners include platform `services/outbox-publisher.ts`,
`services/outbox-drainer.ts`, `services/work-graph-consumer.ts`, and the existing
pipeline/gateway relay. A best-effort signal alone is not a durable result.
Kill/recreate broker and consumer, lose ACK after committing the business result,
fail/restore a required store, and reject stale completion. Verify authoritative
result counts and the projection after each recovery. No duplicate business result.

Only enable a runtime profile after that profile's full matrix passes. Rebuild and
restart changed local consumers, verify installed/running fingerprints, run relevant
call/meeting regressions for RT changes, and push every changed repo. Preserve
explicit unsupported combinations. C9 is not done until this path and mandatory
readiness pass together.

## C5 release: what is already proven

MQ 0.5.0 implements subscription generations, atomic earliest/latest boundaries,
bounded transactional materialization, independent delivery/FIFO/DLQ scopes,
member sessions and fenced offsets. Last-member exit does not delete backlog;
offset commits cannot ACK or skip a message. Every mutation respects queue and
subscription generations. ACK and visibility renewal enforce receive permission.

History inventory is read-only, bounded, body-free and queue-generation pinned.
Older append rows without original `eligibleAt` fail replay with `LegacyHistory`.
The shipped CLI returns exit 2 for incomplete or incompatible scans. It performs
no import, repair or reset. Operator choices for old data require an explicit
migration/start boundary; never invent the original delay from current config.

Latest evidence, not a cloud claim:

- Full MQ default inventory: **131 suites / 1,557 tests pass**; 10 suites / 119
  tests skipped or opt-in. A stale route unit fixture was corrected after adding
  permission middleware, then the full inventory was rerun successfully.
- Separately: **34 default store + 28 subscription store + 14 actual HTTP/process
  cases = 76**, passing on Node **20.0.0 and 25.9.0** against owned DynamoDB Local.
- 13 API permission/boundary and 28 owner-client cases pass. Build and changed-source
  lint pass; existing route-test `any` warnings remain, no lint errors.
- Packed ESM/CommonJS identity and browser types pass on Node20/25. Main/worktree
  and Node20/25 artifact hashes match. Earlier packed checks resolved the pinned
  signing dependency from an explicit installed-tree symlink; they did not claim
  a fresh network Git installation. The catalog preparation failure above is the
  newly discovered adoption boundary.
- Owned UUID tables, child processes and container were removed. Local logs and
  tarballs are ignored under `message-queue-chassis-subscriptions/.scratch/`.

Useful commands after preparing the intended artifacts:

```sh
# message-queue owner
npm run build
npm test -- --runInBand
node scripts/verify-client-package.mjs
MQ_DDB_INTEGRATION=1 DYNAMODB_ENDPOINT=<owned-loopback-endpoint> \
  npm test -- --runInBand test/integration/ddb-delivery-store.test.ts \
  test/integration/ddb-subscriptions.test.ts test/integration/ddb-delivery-http.test.ts

# event-catalog adoption worktree
npm run build
npm test
node scripts/verify-durable-package.mjs
EC_DDB_INTEGRATION=1 DYNAMODB_ENDPOINT=<owned-loopback-endpoint> \
  npm test -- tests/durable-broker.test.ts
```

The tested DynamoDB Local image is
`amazon/dynamodb-local@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab`.
The suites create/delete only UUID-owned tables and must fail if their opted-in
endpoint is unavailable. Do not run a clean build while tests consume that same
dist directory. Run full middleware checks sequentially; concurrent full runs
have previously hung.

## UI and broader backend continuation

The user wants all-tenant journeys and polish, not only the chassis. Preserve this
backlog while finishing C9:

- [33 detailed journeys](design/product-readiness/journeys.md) and
  [structured catalog](design/product-readiness/journey-catalog.json).
- [Readiness gaps by tenant](design/product-readiness/README.md): real Access
  provider wiring, real database/runtime workflows, identity/client isolation,
  live search boundaries, operational restore/deploy/capacity proofs.
- [Generated hangout concepts](design/product-readiness/concepts/README.md) and
  [targeted hangout evidence](design/product-readiness/hangouts-verification.json).
  The accepted local implementation uses Overview/Call/Conversation/Rooms/Activity,
  one call stage and control set, contextual conversation, saved and temporary
  rooms, and actual attendance/authorized recording summaries.
- The October 25 evidence includes a real local two-person native-media walk,
  28 measured hangout states and 27 directory deep cases. Those results do not
  prove AWS IVS, cloud deployments or production capacity. Current RT is 0.139.0;
  consult the later C8 evidence rather than assuming the earlier capture's version.
- Broader Social/Communication judges were **not green** after the layout release:
  32 Social logs and Assessment `stretch/realtime` needed a fresh walk and rendered
  measurement refresh. Do not reuse the October 24 all-green claim or reseal stale
  logs merely to clear a digest mismatch. Recheck current judges before reporting.
- Use the UI DOM audit skill and app/library components for reported layout drift.
  Re-walk padding, search controls, empty browse affordances, contextual call chat,
  light/dark and narrow widths. Preserve Product review and Design studio.

## Local stack and boundaries

At this handoff, portal `http://127.0.0.1:5183/` returned HTTP 200 and middleware
`http://127.0.0.1:3001/health` returned HTTP 200 with `status: ok`, realtime gateway
on and **store: memory**. This is a limited reachability check, not acceptance of
platform forwarding, native media, all dependencies or cloud services. Previously
failed `social-sim`, `platform-api-forward` and `social-docs-forward` resources
were not repaired or re-verified by C5. Use Tilt's current state before walks.

- No cloud apply/deployment, shared mock reset, business-data cleanup or blanket
  process kill. Stop only processes/resources the current verification owns.
- Keep the existing single-gateway safeguard until capacity is accepted.
- Default AWS credentials are invalid on this machine; the 2026-10-27 deploy
  ran from another. The page-thread data migration has not run on Aurora.
- Root `CLAUDE.md` retains open product decisions: burn-down dates, old knowledge
  comment retirement, Alt-click Social panel, Communication landing depth and
  deck save-permission unification. Do not silently decide them as cleanup.
- Physical retired-generation cleanup, sequence contention/throughput, cross-region
  operation and managed-nosql-store compatibility remain separate limits.
- The Codex goal's earlier usage limit is not a completion signal. Use the C0–C9
  ledger/evidence, not token usage or an old "all done" message, to close the work.

## Suggested continuation instruction

> Read `CLAUDE.md` and `docs/claude-code-handoff-2026-10-26.md`. Resume the three
> chassis improvements at C9, starting with the explicitly unfinished catalog
> artifact/pin checkpoint, then implement subscription selection, host readiness
> and the real outbox-to-result/realtime restart proof. Preserve existing data and
> the UI/backend journey backlog. Commit and push verified work in every changed
> owner and consumer repository; do not declare the overall goal complete before
> the C9 acceptance matrix passes.
