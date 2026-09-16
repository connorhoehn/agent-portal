# Research: what breaks first, on the AWS side, as OrgIQ scales

Read-only research, no code changes. Sibling doc covers the browser/portal side.
Baseline: `CLAUDE.md`, `docs/agentcore-preview-surface.md`,
`docs/research-agentcore-2026-09-15.md`, `docs/research-versions-spike-2026-09-16.md`.
AWS quota pages fetched live 2026-09-16; no AWS credentials used, so nothing
here reflects this account's *actual* quota state — only documented defaults.

## 1. AgentCore Runtime

Source: [Quotas for AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html) (fetched 2026-09-16).

| Limit | Value | Adjustable |
|---|---|---|
| Active session workloads/account (us-east-1) | 5,000 | Yes |
| Data-plane API rate (`InvokeAgentRuntime` + 6 others, shared) | 1,000 TPS/account | Yes |
| New session creation rate | 25 TPS/account | Yes |
| Max request/response payload | 100 MB | No |
| Streaming max duration | 60 min | No |
| Idle session timeout (default) | 15 min | Yes (`lifecycleConfiguration`) |
| Max session duration (default) | 8 hrs | Yes (`lifecycleConfiguration`) |
| Session storage | 1 GB/session | No |

The 1,000 TPS data-plane cap is shared account-wide across all 9 runtimes. A
supervisor turn fans into 2-4 A2A sub-agent hops
(`agents/supervisor/main.py::_invoke_sub_agent`), burning 3-5 TPS/turn —
~200-300 concurrent turns before `ThrottlingException`. The **25 TPS
new-session cap is tighter** and hits first on a burst of brand-new users
(fresh `runtimeSessionId`), well before the 1,000 TPS ceiling.

## 2. RDS Data API on Aurora Serverless v2

Sources: [Data API limitations](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.limitations.md), [Data API timeouts](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api-timeouts.md) (fetched 2026-09-16).

- **Response size cap: 1 MiB** — "the call is terminated" if exceeded. A
  large `query_graph` result (a model-written `SELECT` across
  `people`/`documents`/`mentions`) gets `execute_statement` **terminated
  outright**, not truncated. `agents/_shared/sql_guard.py` bounds write-safety
  only, not result width — this is a real unguarded failure mode.
- **Statement timeout: 45s default**, cancels with a timeout error past that
  (`continueAfterTimeout` exists but isn't used anywhere in this repo).
- **No published TPS quota for the Data API itself.** The practical ceiling
  is Aurora compute: at the 0.5-ACU floor (`CLAUDE.md`'s own gotcha), a burst
  of concurrent callers (§6) queues on ACU scale-up, not a hard API limit —
  consistent with the `HttpEndpointNotEnabledException` cold-start retries
  already in `schema/load_schema.py`.

## 3. Bedrock on-demand throttling (`amazon.nova-pro-v1:0`)

Source: [Quotas for bedrock-runtime](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas-runtime.html) (fetched 2026-09-16). Mechanism is documented;
account-specific numbers are **not** — unverified, check Service Quotas console.

- Quota is TPM (input+output combined, per model/region) plus RPM enforced
  for *some* models, plus a derived tokens-per-day cap (TPM × 1,440 default).
- **Provisioned Throughput and cross-region inference profiles are the
  documented scaling answer** — a separate, larger cross-region TPM quota
  exists alongside the single-region on-demand one. Neither is configured
  today (`MODEL_ID` is a bare `amazon.nova-pro-v1:0`, no inference-profile ARN
  anywhere in `infra/` or `agents/`).
- Output tokens burn TPM at a model-specific burndown rate. Third-party
  estimates for Nova Pro RPM range ~50-6,000 depending on source — too
  inconsistent to cite as fact.

## 4. OpenSearch Serverless / Bedrock Knowledge Base

Sources: [AWS General Reference quotas](https://docs.aws.amazon.com/general/latest/gr/bedrock.html), [OpenSearch Serverless capacity limits](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-scaling.html) (fetched 2026-09-16).

| Quota | Value |
|---|---|
| `Retrieve`/`RetrieveAndGenerate`/`...Stream` | 20 req/sec, per region |
| `StartIngestionJob` | **0.1/sec — one every 10s**, per region |
| Ingestion job file size (text) | 50 MB |
| OpenSearch Serverless max index data | 1 TiB/collection |
| OCU storage | 120 GiB hot data/OCU |

`StartIngestionJob` at 1/10s is the sharp number: `sync_knowledge_base`
(`schema/synth/load.py`) fires it once per pipeline run today — nowhere
close — but per-document or per-agent-run syncing would hit it fast. Titan v2
1024-dim vectors carry no quota distinct from the 1 TiB collection ceiling,
far away for a synthetic corpus. Concurrent-ingestion-job limits (commonly
cited elsewhere as 5/account, 1/KB, 1/data-source) — unverified, no primary
doc confirmed this pass.

## 5. CloudWatch — the trace poller

**Correction to the framing**: `middleware/src/lib/cw-trace-ingest.ts` does
**not** call `FilterLogEvents`/`GetLogEvents` — it calls CloudWatch **Logs
Insights** (`StartQueryCommand`+`GetQueryResultsCommand`,
`cw-trace-ingest.ts:282,302`), plus cached `DescribeLogGroupsCommand`
(5 min TTL, `:83,167`) and `ListAgentRuntimesCommand` to scope the query.
`FilterLogEvents`/`GetLogEvents` numbers below are for reference only — they
aren't what's actually throttled.

Source: [CloudWatch Logs quotas](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/cloudwatch_limits_cwl.html) (fetched 2026-09-16), us-east-1:
`StartQuery` 10/sec · `GetQueryResults` 10/sec · `FilterLogEvents` 25/sec
(unused) · `GetLogEvents` 25/sec (unused) — all account+region-wide.

**Concrete finding**: `pollOnce()` runs every `POLL_INTERVAL_MS=30_000`
(`:88`) with **no re-entrancy guard**, unlike `job-dispatcher.ts`'s `ticking`
boolean (verified: `job-dispatcher.ts:151-152` vs. nothing equivalent at
`cw-trace-ingest.ts:460-473`). Its `GetQueryResults` wait loop can itself run
up to `MAX_QUERY_POLL_ATTEMPTS(30) × QUERY_POLL_DELAY_MS(1000ms)` = **30
seconds** (`:94-95,299-302`) — a single slow query can eat the entire poll
interval, making overlapping ticks likely. Worse: `MiddlewareServiceStack`
autoscales 1-4 ECS replicas (verified: `infra/lib/middleware-service-stack.ts:861-863`),
and nothing coordinates the poller across them — each replica runs its own
independent loop against the **same account-wide** 10 TPS `StartQuery`/
`GetQueryResults` budget. **The break point isn't a trace-volume number — it's
2+ concurrently-running middleware replicas with the legacy poller on**,
which the deployed default (`minCapacity:1, maxCapacity:4`) already permits.

## 6. The local-compute fleet (our own design, not AWS)

Verified: `tools/local-compute-worker.mjs:76` (`POLL_INTERVAL_S` default 10),
`:710-711` (announce every `max(5,min(heartbeatIntervalS,25))`s),
`middleware/src/routes/local-compute.ts:147,160` (`claimLimit` 30/60s on
`/pair/claim` only; `workLoopLimit` 600/60s shared by `/claim`, `/announce`,
`/heartbeat`, `/jobs/:id/*`), `middleware/src/lib/rate-limit.ts:1-6,36-51`
(in-memory, **per-process, per client IP**).

**Rate per idle machine**: `/claim` every 10s (6/min) + `/announce` every
≤25s (~2.4/min) ≈ **8-9 req/min**, before job heartbeats. `/claim` alone does
2-3 sequential Aurora round trips per call — `countLiveJobsForBox` read, the
fenced claim `UPDATE...RETURNING`, and `touchNode`'s `UPDATE compute_nodes`
(verified: `routes/local-compute.ts:456-482`, `providers/local-compute.ts:276-278`)
— even on the common empty-queue 204.

**Where it contends**:
1. **The rate-limit bucket, not the DB.** `workLoopLimit` is keyed per-IP:
   many paired machines behind one NAT/office egress share one bucket. ~100
   idle machines behind the same IP would saturate it — plausible at
   office/lab scale, not for a handful of laptops.
2. **The limiter is weaker than it looks under autoscaling.** The `Map` in
   `rate-limit.ts` is process-local by its own comment, and the ALB
   round-robins up to 4 replicas (§5) with no session affinity — the
   effective per-IP ceiling under scale-out is closer to 600×(replica count),
   not the number in the code.
3. **No batching.** Each poll tick is 1 HTTP request → 2-3 DB round trips;
   Postgres's `FOR UPDATE SKIP LOCKED` serializes claims correctly but
   doesn't reduce call count (verified: `providers/agent-jobs.ts:673-693`).

None of this is an AWS quota — it's our own architecture, and the one section
here fully in our control.

## Ranked: what breaks first

1. **CloudWatch trace poller at 2+ ECS replicas** — no re-entrancy guard, no
   cross-replica coordination, shares a 10 TPS account-wide budget the
   deployed autoscaling range already permits colliding on. *Architecture
   fix*: `ticking`-style guard and/or single-owner the poll, or retire it for
   `OrgIQ-SpanProjector`'s Lambda, which already runs singly on a schedule.
2. **RDS Data API 1 MiB cap on `query_graph`** — no size bound on
   model-written SQL; a broad `SELECT` terminates outright. *Architecture
   fix*: enforce `LIMIT` in `sql_guard.py` — not a quota raise, none published.
3. **Local-compute rate-limit bucket, many machines behind one IP** —
   plausible only at ~100+ paired machines on shared egress. *Mixed*: raising
   `workLoopLimit` is config; making the limiter replica-aware (shared store,
   per `rate-limit.ts`'s own comment) is the real fix past 1 ECS replica.
4. **AgentCore Runtime 25 TPS new-session cap** — hit by a genuine spike of
   new users before the 1,000 TPS data-plane cap. *Raise a quota* (adjustable).
5. **Bedrock Nova Pro TPM/RPM** — real, unverified, likely a mid-scale wall.
   *Raise a quota, then provisioned throughput / cross-region inference
   profiles* (documented, neither configured today).
6. **Aurora 0.5-ACU floor** — known `CLAUDE.md` gotcha; scales automatically,
   ~10-20s cold-start lag already handled by retries in `load_schema.py`.
   Lowest urgency here.
7. **KB `StartIngestionJob` (1/10s)** — not close today, matters only if sync
   frequency changes. *Architecture fix if it matters*: batch into fewer,
   larger jobs — not adjustable per the fetched page.

## What to verify with credentials

- `aws service-quotas get-service-quota` for Nova Pro TPM/RPM, AgentCore
  Runtime session/TPS, CloudWatch `StartQuery`/`GetQueryResults` — none of
  §1/§3/§5's numbers are confirmed against *this* account.
- Whether `OBS_USE_LEGACY_POLLER` is actually `true` in the deployed task
  definition — determines whether §5's finding is live or moot.
- Live ECS replica count under load (`aws ecs describe-services --cluster
  orgiq-middleware --services orgiq-middleware`) — §5 only bites at 2+
  concurrent replicas.
- Whether any production `query_graph` call has hit the 1 MiB Data API cap
  (a terminated call, not a normal SQL error) — no evidence from code alone.
- Concurrent-ingestion-job quotas for Bedrock KB — not confirmed against a
  primary AWS doc this pass.
