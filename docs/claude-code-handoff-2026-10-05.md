# Claude Code handoff — 2026-10-05

Continue in `/Users/connorhoehn/Projects/aws-agentcore`. Read this file, the
current checkpoint in `CLAUDE.md`, and
`docs/realtime-validation/2026-10-05/capacity-progress.md` before changing code.
The user requested this handoff so Claude Code can take over the existing work.

## Codex session and instructions

- Session/thread ID: `01a104a7-7e4c-7fd2-86ef-685229fde003`.
- Verified from both `CODEX_THREAD_ID` and `CODEX_SESSION_ID`, and from the
  transcript's first `session_meta` record.
- Local transcript:
  `/Users/connorhoehn/.codex/sessions/2026/10/03/rollout-2026-10-03T22-04-08-01a104a7-7e4c-7fd2-86ef-685229fde003.jsonl`.
- The transcript is large and can contain private runtime material. Read only
  the relevant portions locally; keep credentials out of summaries and commits.
- Repository instructions and context: `CLAUDE.md`; check for any applicable
  `AGENTS.md` when entering another checkout. No ancestor `AGENTS.md` was found
  during this handoff inspection.
- Latest working record: `docs/realtime-validation/2026-10-05/capacity-progress.md`.
- This handoff is the starting context for Claude Code. To reopen the original
  conversation in Codex on this machine, use:

```sh
cd /Users/connorhoehn/Projects/aws-agentcore
codex resume 01a104a7-7e4c-7fd2-86ef-685229fde003
```

The resume syntax is documented in the
[official OpenAI CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-resume).
The command was verified against documentation; it was not executed during
handoff preparation.

## Objective and current state

Finish the full integration: persistent Work/People initiative huddles, shared
pages/chat, canonical document associations, permissions and role journeys,
and cloud video/chat/realtime supporting 100 simultaneous calls without
collisions or unacceptable pressure.

The user explicitly selected the **OrgIQ ingested document corpus** for
work-item document links. Preserve that choice. The shared page changes only
through explicit sharing; navigation must preserve the active call/huddle.

The recorded engineering estimate is approximately **85–87% overall**. It is
not a measured acceptance ratio or an estimate of remaining time. Important
performance, cloud, role and media requirements remain open. The Codex goal is
currently **blocked**, and the work is **not complete**.

The latest queue source is ready for native evaluation. Further performance
changes need real measurements rather than speculative tuning.

## Immediate blocker

The current Codex workspace policy is restricted filesystem/network access,
with no escalation approvals available. The task Docker socket returns
permission denied and an ephemeral `127.0.0.1` listener returns `listen EPERM`.
These failures persisted across three consecutive goal turns and were
rechecked when the user returned.

Current AWS STS verification cannot reach its endpoint. The last reachable
identity check returned `InvalidClientTokenId`. Cloud identity has therefore
not been established. The permitted lab account is **647757222309**; the
personal account **264161986065** is forbidden for this work.

Claude Code should inspect its actual permissions and recheck access. Restore
authorized runtime/network access if available; respect the environment's
policy if it remains restricted. The existing Codex access question was still
pending at handoff. See
`docs/realtime-validation/2026-10-05/capacity-environment-blocked/manifest.json`.

## Repository and dependency state

- Root HEAD: `86925d4d41b3957c747228d28eda5fba3c8f40f2`.
- The root working tree has many accumulated changes and untracked artifacts.
  Preserve them. Do not broadly reset, clean, stash, stage or commit the tree.
- Both middleware and portal use the established package alias
  `@connorhoehnslalom/realtime-modules`, pinned in package/lock files to
  `github:connorhoehn/realtime-modules#c5c967ee18fb2fa6dabe126e2dcdd023a4a64dac`.
  This is **0.106.0** on `feat/redis-realtime-router`, already committed and
  pushed before access restrictions. The package's internal name differs;
  preserve the explicit consumer alias. Do not edit installed `node_modules`.
- Library candidate checkout: `/tmp/orgiq-realtime-cluster-candidate`.
  Last verified clean at that commit. The directory still exists.
- Portal UI pin: **2.409.0**,
  `f873b424899057a4344664dd9bc1a5b2abb940c0`, `fix/work-item-title-wrap`.
- Last inspected owner mains were clean and unchanged:
  `../realtime-modules` at `94bf705e9a4be312d1b54aac83b374b227a2ca4e`,
  `../ui-components` at `39b56ee6e4d5bced1639ea6040067d91a2226270`.
  Reinspect before touching either checkout.
- Preserve `infra/lib/middleware-service-stack.ts`'s single-gateway safeguard:
  desired count 1, stop-before-start deployment, realtime minimum healthy 0 /
  maximum 100, and no autoscaling. Complete capacity/cloud/media acceptance is
  required before removing it.

## Completed work and limits of the evidence

Work/document associations support save, reload, open and remove with current
reader permissions. The exact SQL and three canonical schemas passed native
PostgreSQL contracts, including 12 concurrent identical links. The additive
schema is registered in both loaders but has **not** been applied or verified
on Aurora. Focused Work layout and desktop navigation passed all five OrgIQ
roles; broader role journeys remain open.

Two browsers passed actual local SFU audio/video with synthetic capture,
participant credentials, WHIP/WHEP, navigation continuity, controls, Leave and
invalid credential denial. This does not establish 100 simultaneous media
calls, WAN/TURN, physical devices, recording or restart coverage.

The sealed 0.106 inbox/producer stage passed:

- 2,034 library tests, 9 skipped; build, 31 exports and packed consumer checks.
- 292 application tests, 1 skipped, including optional native Social checks.
- 12 full native BFF contracts: actual cookie/JWT admission, two-node delivery,
  competing-tab seats, current authority, peer readers, 200-item inbox replay,
  durable filtering, presence and natural-lease crash/rejoin.
- Three Redis faults and one DynamoDB stall/recovery case. These ran before
  the final cold-peer guard reorder; the sealed record states that limit.
- 1,318 portal tests, both consumer typechecks/builds, and nine fresh local
  browser cases. Those nine use local routing and stub media receipts.

The newer SDK dispatch/deadline prototype passed **62 offline authority checks
across five suites**, middleware typecheck/build, and compiled controlled-client
checks. It has **not** passed native services, a rebuilt image, or capacity
tests. Existing native processes/images/browsers remain at the earlier inbox
stage. Do not attribute their results to the queue prototype.

Relevant records:

- `docs/realtime-validation/2026-10-04/focused-work-acceptance.md`
- `docs/realtime-validation/2026-10-04/work-document-association-acceptance.md`
- `docs/realtime-validation/2026-10-05/cluster-inbox-acceptance.md`
- `docs/realtime-validation/2026-10-05/cluster-inbox-manifest.json`
- `docs/realtime-validation/2026-10-05/capacity-sdk-dispatch/manifest.json`
- `docs/realtime-validation/2026-10-05/capacity-sdk-deadline/manifest.json`

## Latest source change to evaluate

Current files, confirmed to match the sealed deadline prototype during handoff:

- `middleware/src/lib/dynamo-dispatch.ts` — new dispatch queue.
- `middleware/src/lib/__tests__/dynamo-dispatch.test.ts` — new regressions.
- `middleware/src/lib/social-chat.ts` — queued membership-read coalescing.
- `middleware/src/lib/realtime-gateway.ts` — wraps the real SDK client and wires
  membership dispatch into the store.

The queue retains the existing default **50 transport slots**, bounds waiting
work to **4,096 jobs** with a **five-second queue deadline**, and holds work
before invoking the SDK. Membership reads can combine only while waiting.
Their shared entry is removed immediately before actual dispatch, so a later
read takes a fresh snapshot even while an earlier read is in flight. There is
no settled positive authority cache. Membership pagination runs sequentially
under one permit; detached callbacks cannot reuse a released permit.

Two genuine deadline regressions were reproduced: promise completion could
free a slot before an overdue timer callback, allowing expired work to start
or expired jobs to occupy admission space. The fix checks a monotonic deadline
at admission and actual start and drains iteratively. The compiled check
discarded 1,000 expired jobs without SDK calls and admitted fresh work.

Use the normal Jest configuration for network verification once listeners are
allowed. The offline config removes only the unrelated global HTTP fixture
and was used exclusively for pure authority tests. A reproducible offline
subset, from `middleware/`, is:

```sh
node node_modules/.bin/jest --config ../docs/realtime-validation/2026-10-05/capacity-sdk-deadline/orgiq-offline-authority-jest.config.cjs --runInBand --runTestsByPath src/lib/__tests__/dynamo-dispatch.test.ts src/lib/__tests__/social-membership-fence.test.ts src/lib/__tests__/direct-recipient.test.ts src/lib/__tests__/live-principal.test.ts src/lib/__tests__/live-subscribers.test.ts
npm run typecheck
npm run build
```

Those commands are provided for reproduction; no new test run was performed
while preparing this handoff.

## Capacity findings

The full 0.105 matrix completed and is **unaccepted**. Ring-storm, churn,
steady group four and collision profiles passed; steady group two, soak and
synchronized burst failed latency/health targets. Preserve every failure.
The collision fix eliminated duplicate accepted seats in competing-tab races.

The latest readiness-gated native run connected **1,000 sockets**, established
**100 calls**, reached all **800 paired senders**, and had zero collision,
denial or unplanned-disconnect errors. It still failed:

| Measure | Observed | Required |
| --- | --- | --- |
| Invite p95 / p99 | 1,733.9 / 1,811.0 ms | <250 / <1,000 ms |
| Accept p95 | 767.0 ms | <250 ms |
| Chat p95 | 4,163.1 ms | <300 ms |
| Health p99, each node | 151.3 / 104.5 ms | <50 ms |

Each BFF is constrained to **1 CPU / 1,024 MiB**; driver **1 CPU / 512 MiB**.
Memory target is <700 MiB per BFF. Keep the 50-connections/sec ramp, workload,
coverage and thresholds. The 100 calls above are signalling/capacity evidence,
not 100 actual media calls.

Profiling showed membership reads dominate native DynamoDB pressure, with
queued SDK requests peaking above 1,300. Inbox batching reduced query counts
but did not meet burst targets. Increasing sockets to 128 did not solve it.
Direct Docker store routing was rejected after warmed counterbalanced probes
showed no repeatable improvement; its temporary attachment was restored.

Preserved records include `capacity-current/manifest.json`,
`capacity-store-route/manifest.json`, `capacity-table-profile/manifest.json`
and `capacity-table-ready/manifest.json`, all under the 2026-10-05 directory.

## Owned fixtures and safe restart

All Docker operations for this task use:

```sh
export DOCKER_HOST=unix:///tmp/orgiq-capacity-docker.sock
export ORGIQ_BFF_RUNTIME_ENV_FILE=/tmp/orgiq-owned-bff-runtime-env.json
```

The private runtime profile exists with mode **0600**. Parse it into child
process environments; do not print its values or Docker `Config.Env`.

Reinspect these dedicated containers and require the `orgiq.validation=bff-cluster`
label, expected ports, running state and unpaused state before mutations:

| Container | Published localhost port |
| --- | --- |
| `orgiq-bff-cluster-postgres` | 15483 |
| `orgiq-bff-cluster-redis` | 16483 |
| `orgiq-bff-cluster-dynamodb` | 18063 |

Dedicated DynamoDB prefix: `orgiq-bff-cluster-`. Native BFFs use 3063/3064;
compiled capacity BFFs use 3065/3066 and the labeled
`orgiq-bff-capacity-network`. The task forwarder PID file is
`/tmp/orgiq-capacity-forwarder.pid`; inspect its current identity before use.
Keep 1,000 load WebSockets inside Docker; the SSH bridge previously failed
under that load and is for control/fixture traffic.

Latest sealed local-only image:
`sha256:9493e0964c2bc1a72f89315c4d84cf96e1fce91cc32b15d54a7b22ec0dc96ac2`,
tagged `orgiq-middleware:cluster-inbox-validation`. It **does not** contain
the latest SDK dispatch source.

Relevant launchers under `middleware/test-support/`:

- `bff-cluster-processes.py`: guarded restart of the exact owned source BFFs.
- `bff-cluster-containers.py`: guarded compiled fixture replacement with fixed budgets.
- `bff-cluster-capacity.mjs`: actual directory provisioning; use
  `ORGIQ_BFF_CAPACITY_ACCEPTANCE=1`,
  `ORGIQ_BFF_CONTAINER_CAPACITY_ACCEPTANCE=1` and
  `ORGIQ_BFF_CAPACITY_PREPARE_ONLY=1` for compiled-fixture preparation only.
- `bff-cluster-container-load.py`: internal driver with real HTTP/router
  readiness preflight. Profiles: pilot, burst, steady, ring-storm, double-accept,
  churn, soak. Soak includes three genuine credential-renewal waves.
- `native-rds-preload.mjs`: executes actual provider SQL against native PG;
  substitutes RDS transport only. Optional profiling records counts/timings.

No currently running load handle was confirmed at handoff. The latest burst
driver name may still exist. Inspect its exact identity/state, archive its
result and logs, and remove only that owned stopped container before reuse.
Do not rerun a workload merely because an old execution handle is missing.
Do not restart Docker/Colima or shared applications. Existing owner ports
3001/5183 and their processes are outside this fixture's ownership.

## Next actions, in order

1. Recheck authorized Docker/loopback/network access and inspect the dedicated
   fixture identities. If still denied, report that precise blocker.
2. Restart source BFFs against the current queue prototype using the guarded
   helper. Wait for actual health/router readiness. Run native contracts
   sequentially; faults must not overlap a load driver. From the repo root:

   ```sh
   python3 middleware/test-support/bff-cluster-processes.py
   ORGIQ_BFF_CLUSTER_ACCEPTANCE=1 ORGIQ_BFF_CLUSTER_CRASH_ACCEPTANCE=1 node --test middleware/test-support/bff-cluster-acceptance.mjs
   ORGIQ_BFF_REDIS_FAILURE_ACCEPTANCE=1 node --test middleware/test-support/bff-cluster-redis-failures.mjs
   ORGIQ_BFF_DYNAMO_FAILURE_ACCEPTANCE=1 node --test middleware/test-support/bff-cluster-dynamo-failures.mjs
   ```

3. Run the relevant actual native Social/store checks and required application
   gates with the normal setup. Redis faults can affect all owned routers, so
   reinspect readiness/unpaused stores afterward. Refresh browser processes
   before claiming browser results against new code.
4. Build a **local** Node 22 ARM64 image containing the current working source
   and exact locked libraries. Preserve the previous image/source evidence.
   Use direct `docker buildx ... --load` and inspect the compiled artifact.
   `scripts/docker/middleware-image-build.mjs` automatically pushes to ECR
   when not dry-run; it is unsuitable for a local-only validation build.
5. Rebuild the owned driver if its source changed, launch compiled BFFs with
   fixed budgets, prepare actual native directory identities, and evaluate
   unchanged burst first. Then run the complete steady/ring/churn/collision/
   five-minute soak matrix with group sizes two/four where declared. Retain
   all results and failures. A single passing profile does not accept capacity.
   After building and inspecting the current local image and resolving any
   retained stopped driver of the same name, the launcher sequence is:

   ```sh
   ORGIQ_BFF_CONTAINER_ACCEPTANCE=1 ORGIQ_BFF_CONTAINER_IMAGE=orgiq-middleware:cluster-inbox-validation python3 middleware/test-support/bff-cluster-containers.py
   ORGIQ_BFF_CAPACITY_ACCEPTANCE=1 ORGIQ_BFF_CONTAINER_CAPACITY_ACCEPTANCE=1 ORGIQ_BFF_CAPACITY_PREPARE_ONLY=1 node middleware/test-support/bff-cluster-capacity.mjs pilot
   ORGIQ_BFF_CONTAINER_ACCEPTANCE=1 python3 middleware/test-support/bff-cluster-container-load.py burst
   ```

   These opt-ins are distinct; keep the already-exported Docker host and private
   profile path. Substitute declared profile names for subsequent load runs.
6. Finish broader producer/outage, role/tenant and provisioned-directory
   journeys. Establish valid STS identity in lab account 647757222309 before
   cloud mutations, apply/verify the additive Aurora schemas, and verify IAM,
   current identity and deployment behavior.
7. Complete 100 simultaneous **actual media** calls, internet/TURN and physical
   device checks, recording and restart/recovery. Only after all required
   acceptance may the deployment safeguard be reconsidered.

Use exact source snapshots and stage-specific evidence. Historical manifests
are immutable; compare their hashes to their archived source, not to today's
edited `CLAUDE.md` or progress record. Do not rewrite a past failed result or
lower thresholds to obtain a passing report. Keep progress updates concise,
and carry authorized work forward without repeatedly asking routine permission.

## Prompt to paste into Claude Code

```text
Take over the existing OrgIQ integration work in /Users/connorhoehn/Projects/aws-agentcore.
Read docs/claude-code-handoff-2026-10-05.md, CLAUDE.md's current checkpoint, and
docs/realtime-validation/2026-10-05/capacity-progress.md. Preserve the dirty working
tree, exact dependency pins and single-gateway deployment safeguard. The latest
SDK queue passes 62 offline checks but has not been tested against native services.
First recheck Docker/localhost access, then follow the handoff's native verification,
unchanged capacity matrix, cloud/role and actual 100-call media acceptance steps.
Use the OrgIQ document corpus for Work links. Keep all failure evidence and do not
claim production completion until every required gate passes. Continue the work
autonomously within the environment's permissions and report precise blockers.
```
