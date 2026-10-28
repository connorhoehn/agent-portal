# DE-9 Native observability for the agent fleet

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Feeds DE-10 (token and cost rows per runtime and tenant) and DE-5 (online eval
reads the same `aws/spans`). Independent of DE-30.

## Current state (read from the code, 2026-10-27)

The backlog line is half right. There are **three** trace pipelines today, and
the "replacement" it names is not native either:

| Pipeline | Source | Writer | Enrichment |
|----------|--------|--------|------------|
| Legacy poller (`lib/cw-trace-ingest.ts`) | `ORGIQ_TRACE:<json>` stdout lines (`agents/_shared/instrumentation.py:823-840`) in `/aws/bedrock-agentcore/runtimes/*-DEFAULT`, Logs Insights every 30 s | `processTrace` (`lib/trace-sink.ts:999`) | sampling, phantom guard, Titan embed, Nova Pro judge, schema check, cost, `OrgIQ/Observability` metrics |
| Span projector (`OrgIQ-SpanProjector`) | `ORGIQ_OI_SPAN:` lines from a `ConsoleSpanExporter` on stdout (`instrumentation.py:116-141`), `FilterLogEvents` every minute (`infra/lambda/span-projector/index.py:145-195`, `infra/lib/span-projector-stack.ts:124`) | its own `INSERT` (`index.py:439-454`) | none: no judge, embedding, cost, tenant, `agui_run_id` or steps |
| ADOT OTLP | `OTEL_TRACES_EXPORTER=otlp` + `AGENT_OBSERVABILITY_ENABLED` (`infra/lib/agentcore-runtime-stack.ts:423-431`) into `aws/spans` | nothing in this repo projects it | read only by online eval (`agentcore-telemetry-stack.ts:234-270`) |

Facts that shape the change:

- **Both projectors poll logs.** The span projector is the same pattern as the
  legacy poller with a different prefix; it does not read `aws/spans` and
  `OTEL_LOG_GROUP` is never passed (`infra/bin/app.ts:306-313`).
- **They already race.** The projector stack is unconditional
  (`app.ts:306`) and `OBS_USE_LEGACY_POLLER` is not set on the service
  (`infra/lib/middleware-service-stack.ts:844` env block), so it defaults to
  `true` (`cw-trace-ingest.ts:122`). Both write the agent-minted
  `invocation_id` with `ON CONFLICT DO NOTHING`; whichever lands first wins
  (`cw-trace-ingest.ts:490-504`). When the projector wins, the row has no
  judge score, cost or tenant, and the poller's embed and judge calls are
  spent on a dropped insert. Flipping the flag to `false`, as the migration
  note says (`cw-trace-ingest.ts:37-49`), would lose that enrichment for
  every row, not retire a duplicate.
- **Sampling.** `FALLBACK_RATE = 0.1` (`trace-sink.ts:199`) applies when the
  sampling cache holds neither the template nor `default`
  (`decideSampling`, `:262-271`). That happens when the first
  `sampling_config` read fails on a cold Aurora; the failure path stamps the
  fetch time (`:253-258`), so for the next 60 s nine in ten traces are dropped
  before insert (`:1014-1018`). The projector does not sample at all, so the
  two pipelines disagree about what "sampled" means.
- **The cursor is per process.** `_lastPollTs` is in memory (`:99`); a
  restart re-reads five minutes, and each of 1-4 replicas polls on its own.
- **The per-agent dashboards exist but read nothing.** `OrgIQ-AgentCoreTelemetry`
  graphs namespace `bedrock-agentcore`, metrics `Invocations` /
  `InvocationLatency` / `Errors`, dimension `AgentRuntimeName`
  (`agentcore-telemetry-stack.ts:283-322`). The middleware found that
  spelling returns empty datapoints and queries `AWS/Bedrock-AgentCore`
  with `Invocations` / `SystemErrors` / `Latency` under `Resource`,
  `Operation`, `Name` (`middleware/src/providers/cloudwatch.ts:148-160`,
  `providers/agentcore.ts:316-344`). So the dashboard rows and the
  `supervisor-errors` alarm (`:398-413`, which also has no alarm action) are
  silent. The dashboard also lists six agents (`:9`) against eight runtimes
  (`agentcore-runtime-stack.ts:88-96`), and the token widget has no `ModelId`
  dimension. (Whether undimensioned `AWS/Bedrock` series exist is unverified.)

## Change

1. **One writer, one enrichment.** Keep `processTrace` as the only code that
   writes `invocation_traces`, because it owns the enrichment. Make the span
   projector a *source* for it instead of a second writer: it builds the
   `TraceInput` it already assembles (`build_invocation_payload`) and sends
   it to an SQS queue (`<prefix>-trace-bundles`, new, in
   `OrgIQ-SpanProjector`); a BFF consumer (`lib/trace-queue-consumer.ts`)
   long-polls it and calls `processTrace`. A queue, not a POST to
   `/api/observability/harness/trace`, because the ALB is closed to
   arbitrary sources (`openListener: false`, custodian-managed SGs) and a
   non-VPC Lambda has no fixed address to allow. Delete the projector's
   direct `INSERT` and its `rds-data` grant. One message per invocation id
   and the existing primary key keep replays harmless; the consumer deletes
   a message only after `processTrace` returns.
2. **Read native spans.** Point the projector at `aws/spans` (OTLP via ADOT,
   already exported) instead of `ORGIQ_OI_SPAN:` stdout, then drop the
   console exporter from `instrumentation.py`. The span attribute names
   AgentCore writes into `aws/spans` are unverified; the projector's
   `_attr` lookups must be re-checked against a captured record before the
   switch, and the captured record saved as a fixture
   (`infra/lambda/span-projector/fixtures/aws-spans-sample.json`).
3. **Carry what the bundle lacks.** Add `tenant` (from the payload's
   `auth.tenant`) to the agent `TraceContext` and to the span as
   `orgiq.tenant`, so deployed rows stop landing with `tenant = NULL`
   (today only the mock path sets it, `providers/agentcore.ts:1252`).
4. **Retire the legacy poller** once the projector has carried a week of
   rows with the same judge and cost coverage: set `OBS_USE_LEGACY_POLLER=false`
   in the service env, then delete `cw-trace-ingest.ts`, the `ORGIQ_TRACE:`
   print and the `logs:StartQuery` grant (`middleware-service-stack.ts:694-704`).
5. **Sampling fails open to the seeded rate.** Replace `FALLBACK_RATE = 0.1`
   with `1.0` when the cache is empty because the read failed, and keep 0.1
   only as an explicit `default` row an operator wrote. Sampling decides in
   the projector before the POST, so dropped traces cost no judge call.
6. **Fix the dashboards.** Rewrite the telemetry dashboard and alarm on the
   names the middleware already uses, for all eight runtimes from one
   exported `AGENT_NAMES` list in `agentcore-runtime-stack.ts`; add an
   `OrgIQ/Observability` row for `JudgeScore`, `TraceIngestLagSeconds` and
   `TraceRowsWritten` (new, emitted by the projector); wire the alarms to
   `<prefix>-alerts`. Per-agent tokens come from DE-10's metric.

## Decisions owed

- **Keep judge-on-ingest, or move quality scoring to AgentCore online eval?**
  Proposal: keep the Nova Pro judge in `processTrace` for this item (the
  portal reads `judge_score`); compare it to online eval scores under DE-5
  before choosing one.
- **Queue or in-BFF reader.** Proposal: the queue above. The alternative,
  the BFF reading `aws/spans` itself, needs DE-47's leader lock to stop 1-4
  replicas each paying for the judge, and puts a log reader back in the BFF.
- **Projector cadence.** Proposal: stay at one minute; a subscription filter
  on `aws/spans` is lower latency but needs an IAM handshake on a log group
  AgentCore owns (unverified that it is allowed).

## Done when

- `cd infra && npx jest test/agentcore-telemetry-stack.test.ts` asserts every
  dashboard metric uses namespace `AWS/Bedrock-AgentCore`, covers eight
  runtimes, and every alarm has an SNS action.
- A new `infra/test/span-projector-stack.test.ts` asserts the Lambda has no
  `rds-data:*` grant and does have the harness callback secret.
- `cd infra/lambda/span-projector && python -m unittest` turns the captured
  `aws-spans-sample.json` into a `TraceInput` with tokens, tenant and run id.
- `cd middleware && npx jest src/lib/__tests__/trace-queue-consumer` asserts a
  message is deleted only after `processTrace` resolves, and a redelivered
  message writes no second row.
- `cd middleware && npx jest src/lib/__tests__/trace-sink` covers: empty
  cache after a failed read samples at 1.0; an explicit `default` row of 0.1
  still samples at 0.1.
- `grep -rn "INSERT INTO observability.invocation_traces" infra/lambda` and
  `grep -rn "ORGIQ_OI_SPAN" agents` return nothing.
- `cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_instrumentation`
  asserts the bundle carries `tenant`.
- `scripts/validate-mock-floor.sh` stays green.
