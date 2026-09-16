# Research: does the CloudWatch trace poller need a replica lease?

Triggered by the comment at `middleware/src/lib/cw-trace-ingest.ts` (near the
`_polling` re-entrancy guard) claiming multiple ECS replicas are "a real gap"
needing "a lease". This is a verification pass with evidence, plus one small
fix that was shipped as a result — not a lease.

**Headline: no Aurora corruption at any replica count — `invocation_id` is a
real PRIMARY KEY and every writer hits `ON CONFLICT DO NOTHING`. The comment
is correct that nothing coordinates replicas, but it undersells the actual
cost (CloudWatch quota + wasted Bedrock spend, not corruption) and misses a
second, more interesting bug: the poller races the always-on
`OrgIQ-SpanProjector` Lambda for the same row, and until today the code could
not tell you when it lost that race — `inserted` was hard-coded `true` on any
non-throwing insert. Fixed that (small, tested). Not building a lease.**

## 1. Replica count — verified, not assumed

`infra/lib/middleware-service-stack.ts:861-874`:

```ts
const scaling = fargateService.service.autoScaleTaskCount({
  minCapacity: 1,
  maxCapacity: 4,
});
scaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 70, ... });
scaling.scaleOnMemoryUtilization('MemoryScaling', { targetUtilizationPercent: 80, ... });
```

1-4 tasks, autoscaling on CPU (70%) and memory (80%). It varies with load —
under real traffic, the exact scenario that maximizes trace volume (more
requests → more CPU → more replicas) is also the scenario that maximizes how
many replicas race each other on the poller. `CLAUDE.md`'s own gotcha
("middleware task runs on ARM64") confirms this is the live deployed shape.

## 2. What N replicas polling actually does — evidence, not guesswork

**Primary key + conflict handling** (`schema/observability_schema.sql:22-23`):

```sql
CREATE TABLE IF NOT EXISTS observability.invocation_traces (
  invocation_id     uuid PRIMARY KEY,
  ...
```

Every INSERT — the poller's (`trace-sink.ts::insertTrace`), the middleware's
own gated write path, and `OrgIQ-SpanProjector`'s Lambda (Python,
`infra/lambda/span-projector/index.py:453`) — targets this same PK with
`ON CONFLICT (invocation_id) DO NOTHING`, keyed on the id the **agent**
minted (`agents/_shared/instrumentation.py:230`, `TraceContext.invocation_id`,
carried both in the `ORGIQ_TRACE:` stdout bundle the poller reads and the
`orgiq.invocation_id` OTel span attribute the Lambda reads). So:

- **Duplicate Aurora rows: never.** Postgres enforces the PK regardless of
  how many writers race. This part of the file's docstring
  (`cw-trace-ingest.ts:17-21`, "re-ingests the same line harmlessly") is
  correct and was already correct before this pass.
- **Wasted CloudWatch API calls: real.** Every replica independently calls
  `StartQueryCommand`/`GetQueryResultsCommand` every 30s against the SAME
  account-wide 10 TPS budget for both operations
  (`docs/research-scale-limits-2026-09-16.md` §5, verified against the
  [CloudWatch Logs quotas page](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/cloudwatch_limits_cwl.html)).
  This was already documented in that prior research pass; nothing new here.
- **Wasted Bedrock spend: real, and previously invisible (see §3).** Every
  replica that matches the same `ORGIQ_TRACE:` line independently runs the
  FULL `processTrace()` pipeline — Titan embed, Nova Pro judge — **before**
  the Aurora INSERT decides who wins the conflict. Only one write's data
  survives; the rest is paid-for and discarded.
- **Throttling: possible, secondary.** `StartQuery`/`GetQueryResults`
  failures are caught and logged (`cw-trace-ingest.ts:290-293,303-307`); the
  cursor stays put and the next poll retries the same window. A throttle
  delays ingestion by ~30s per hit — annoying, not user-visible, not a
  reliability incident.

## 3. Sampling interaction — a real amplifier, and it was undercounted

`processTrace()` rolls its sampling die independently per call
(`trace-sink.ts:937-940`, `Math.random() >= cfg.rate`). When N replicas each
see the same CW Insights line (they will — every replica queries the same log
groups over roughly the same time window), each replica rolls its own die at
the SAME configured rate `r`. The probability that **at least one** replica
persists the trace rises to `1 - (1-r)^N` instead of `r` — mildly more
permissive sampling overall — but the concrete, continuously-recurring cost is
that **up to N replicas independently pay for embed+judge** at rate `r` each,
while at most one insert survives. `CLAUDE.md`'s own observability gotcha
notes the seeded default sampling rate is now `1.0` (`schema/observability_
schema.sql`'s seed row, "Trace sampling gates persistence"), which means in
the deployed default configuration **every replica that sees a line samples
it** — this isn't a corner case, it's the steady-state behavior any time
autoscaling is above 1 replica.

**This part had been miscounted.** `pollOnce()`'s own accounting
(`cw-trace-ingest.ts:385-389`) was designed to separate `persisted` /
`sampled-out` / `phantom-skipped` / `duplicate`:

```ts
const result = await processTrace(bundle);
if (result.inserted) ingested++;
else if (result.sampled === false) sampledOut++;
else if (result.skipped) skipped++;
else duplicates++;
```

But `TraceResult.inserted` was **hard-coded `true`** on any non-throwing
insert, in both the real and mock paths:

```ts
// trace-sink.ts, before this pass:
await insertTrace({ ... });
inserted = true;                 // ← unconditional
```

`insertTrace()` returned `Promise<void>` and never checked whether the SQL's
`ON CONFLICT (invocation_id) DO NOTHING` had actually fired (0 rows affected)
versus performed a genuine insert (1 row). The mock branch had the SAME bug
in the other direction: `insertSinkTrace()` already returned a correct
boolean (`mock/trace-sink.ts:141-146`, `false` if the id existed) — but the
caller discarded it (`insertSinkTrace({...}); return;`).

**Consequence:** `duplicates++` at `cw-trace-ingest.ts:389` was unreachable
dead code. Every raced writer — two poller replicas re-scanning an
overlapping window, or the poller losing the race against SpanProjector (§4)
— logged and counted itself as "persisted", identically to a genuine fresh
row. The exact log line this pipeline exists to produce
(`[cw-ingest] matched N line(s); persisted N, ...`) was **structurally
incapable of showing this problem**, no matter how bad it got. A second,
unrelated consumer of the same field had the identical bug:
`routes/invocations.ts:950-955`'s `/replay` endpoint has a `notPersisted:
'the trace insert did not report a row'` fallback message that was ALSO
unreachable — the route's own doc comment (`:932-938`) already anticipated
this exact case; it was simply never wired up.

There's a second-order consequence too: `insertToolCalls`/`insertMemoryEvents`/
`insertGuardrailInterventions` are gated on `if (inserted && ...)`
(`trace-sink.ts:1128,1139,1151`). Because `inserted` was always `true`, a
**retried or raced bundle's child rows (tool_calls, memory_events,
guardrail_interventions) re-inserted on every collision**, even though the
parent `invocation_traces` row correctly stayed deduped by the PK — those
child tables have no equivalent uniqueness constraint, so this was quietly
accumulating duplicate child rows proportional to how often two writers raced
for the same invocation, independent of replica count (a single-replica
poller re-scanning an overlapping CW window was enough).

**Fixed** (see §5): `insertTrace()` now returns whether it performed a
genuine insert — via `RETURNING invocation_id` on the real path (0 rows back
means the conflict fired) and by reading `insertSinkTrace()`'s already-correct
boolean on the mock path — and `processTrace()` threads that value into
`TraceResult.inserted`. `duplicates++`, the `/replay` route's message, and the
child-row gates are now all live and correct.

## 4. SpanProjector overlap — the more interesting finding

`OrgIQ-SpanProjector` (`infra/bin/app.ts:285-292`) deploys **unconditionally**
— no context flag, instantiated alongside every other stack — on a 1-minute
EventBridge schedule (`infra/lib/span-projector-stack.ts:121-124`,
`events.Schedule.rate(Duration.minutes(1))`). `OBS_USE_LEGACY_POLLER`
defaults to unset → `true` (`cw-trace-ingest.ts:122`, `legacyPollerRequested()`),
so in the default deployed configuration **both pipelines run all the time**,
not as an either/or.

Both write to the SAME `invocation_id` — confirmed by tracing the value
through both code paths:

- Agent side, ONE id for both: `agents/_shared/instrumentation.py:230`
  (`invocation_id: str = field(default_factory=lambda: str(uuid.uuid4()))`)
  is stamped into the `ORGIQ_TRACE:` stdout bundle
  (`:351`, `"invocationId": self.invocation_id`) AND the OTel span attribute
  (`:809`, `"orgiq.invocation_id": ctx.invocation_id`).
- Poller side reads the bundle's `invocationId` (`cw-trace-ingest.ts:365-367`,
  parses the JSON after `ORGIQ_TRACE:` and hands it to `processTrace()`).
- SpanProjector reads the span attribute (`span-projector/index.py:363`,
  `invocation_id = _attr(root, "orgiq.invocation_id") or _get_span_id(root)`)
  and does its OWN direct `INSERT ... ON CONFLICT (invocation_id) DO NOTHING`
  (`:439-453`) — not through `processTrace()`, a completely separate Python
  pipeline against the same table.

**These two writers are not equivalent.** SpanProjector's INSERT column list
(`span-projector/index.py:440-445`) is: `invocation_id, agent_id, agent_name,
template_id, prompt_snippet, response_snippet, model_id, prompt_version,
input_tokens, output_tokens, duration_ms, parent_invocation_id, user_id,
session_id, guardrail_action, pii_detected`. It has **no**
`judge_score`, `judge_rationale`, `schema_valid`, `output_embedding`,
`est_cost_usd`/`judge_cost_usd`/`total_cost_usd` — those columns only exist
because `trace-sink.ts::processTrace()` computed them (Titan embed + Nova Pro
judge + schema validation + cost estimation). SpanProjector reconstructs a
trace tree from raw OTel spans; it was never designed to duplicate the
enrichment pipeline.

So the race isn't "the same span counted twice" (nothing doubles — the PK
still holds) — it's **whichever writer's INSERT lands first wins the row
permanently**, and the SIMPLER pipeline (SpanProjector: one Aurora write, no
Bedrock round trips) is structurally likely to win against the RICHER one
(the poller: Titan embed + Nova Pro judge, then the write) most of the time.
When SpanProjector wins: the poller still pays for the embed and judge calls
(they run before the INSERT), then its enriched write hits `ON CONFLICT DO
NOTHING` and is silently discarded — Bedrock spend for zero persisted
benefit, and the row is permanently stuck without judge/quality/drift/cost
data for that invocation. This happens **at 1 replica just as at 4** — it is
independent of the ECS autoscaling question this research was originally
about, and it was invisible before §3's fix (a discarded enriched write used
to report `inserted: true`, same as a genuine one).

## 5. What was actually shipped

**Not a lease.** A lease is real distributed-systems code — TTL, heartbeat,
crash recovery, and (per the task's own admonition) not something to ship
half-correct. Building one for `cw-trace-ingest.ts` specifically is a bad
trade: the file's own MIGRATION NOTE (`:37-50`) already states the intended
end state — retire this poller once `OrgIQ-SpanProjector` is verified stable,
set `OBS_USE_LEGACY_POLLER=false`, delete the file. Investing in
coordination infrastructure for a component with a documented, already-planned
retirement is effort spent in the wrong place.

**Shipped instead**: closed the dead-code gap in §3 — `insertTrace()` now
tells its caller whether it performed a genuine insert, so `TraceResult.
inserted` is finally accurate.

- `middleware/src/lib/trace-sink.ts`: `insertTrace()` signature changed
  `Promise<void>` → `Promise<boolean>`. Real path adds `RETURNING
  invocation_id` to the INSERT and returns `rows.length > 0`. Mock path
  returns `insertSinkTrace()`'s already-correct boolean instead of discarding
  it. `processTrace()` sets `inserted = await insertTrace({...})` instead of
  unconditionally `true`.
- `middleware/src/lib/cw-trace-ingest.ts`: comments updated to record what was
  broken and point at this doc; no behavior change beyond what `trace-sink.ts`
  now reports honestly.
- Tests: extended `middleware/src/mock/__tests__/trace-sink-offline.test.ts`'s
  existing "honours ON CONFLICT DO NOTHING" case to assert `first.inserted ===
  true` / `second.inserted === false` (previously only checked row count/
  content, not the field this whole investigation is about). Added a case to
  `middleware/src/lib/__tests__/invocation-dedupe.test.ts` asserting the same
  for the real (non-mock) SQL path, and updated that file's + `phantom-trace-
  guard.test.ts`'s fake `exec()` INSERT branches to return a `RETURNING`-shaped
  row on a fresh insert (previously always `[]`, which happened to match the
  old, wrong "always inserted" behavior by coincidence).

Run: `cd middleware && npx jest src/lib/__tests__/invocation-dedupe.test.ts
src/mock/__tests__/trace-sink-offline.test.ts
src/mock/__tests__/trace-sink-union.test.ts
src/lib/__tests__/phantom-trace-guard.test.ts
src/routes/__tests__/invocations-replay-offline.test.ts` — all pass after the
fix (2 failures before it, in `phantom-trace-guard.test.ts`, both now green).
`npx tsc --noEmit` — exit 0.

## What was NOT done, and why

- **No lease, no leader-election env var.** Given the poller's documented
  retirement path and that the only proven cost is CloudWatch quota pressure
  (already a known, ranked #1 risk in `docs/research-scale-limits-2026-09-16.md`)
  plus wasted Bedrock spend (real money, but bounded — not a reliability or
  correctness incident), building bespoke coordination for code that's
  supposed to go away is the wrong investment.
- **No merge/upsert to fix the §4 data-loss race.** The clean fix there is
  changing `insertTrace()`'s `ON CONFLICT DO NOTHING` to a `DO UPDATE` that
  `COALESCE`s in enrichment columns only where the existing row has them NULL
  (so whichever writer runs second fills gaps instead of losing). That's a
  real, understood fix, but it's bigger than "tight and small": it touches the
  same SQL surface as §5's fix, needs the SAME COALESCE logic mirrored in
  `mock/trace-sink.ts::insertSinkTrace` for parity, and changes on-disk
  semantics for a table four routes and multiple dashboards read from — it
  deserves its own review, not a rider on this pass. Recommended as the next
  step if `OrgIQ-SpanProjector` and the legacy poller are going to keep
  running side by side for any meaningful stretch; a no-op if the poller is
  retired first per the existing migration plan.
- **No change to `OBS_USE_LEGACY_POLLER`'s default or the SpanProjector
  schedule.** Flipping the default off would silently drop judge_score/
  output_embedding/schema_valid/cost enrichment for every trace (SpanProjector
  doesn't compute them) — a real product regression, not something to change
  as a side effect of a research pass.

## Answers to the five questions, compressed

1. **1-4 ECS replicas**, autoscaled on CPU 70% / memory 80%
   (`middleware-service-stack.ts:861-874`). Varies with load.
2. **No Aurora corruption** (`invocation_id` PK + `ON CONFLICT DO NOTHING`,
   verified in schema and both writers). Real costs: wasted CloudWatch quota
   (previously documented) and wasted Bedrock spend (newly quantified here,
   §3) — proportional to replica count and, independently, to the
   SpanProjector race (§4, which fires even at 1 replica).
3. **Yes, and it was undercounted.** Effective persisted-fraction rises to
   `1-(1-r)^N`; effective wasted-compute is ~`N×r` embed+judge calls per
   trace for 1 surviving row. At the seeded default `r=1.0` this fires on
   every trace whenever more than one replica is up.
4. **Yes, real overlap, and it's a race for content, not a double-count.**
   SpanProjector's bare-span row and the poller's fully-enriched row compete
   for the same PK; whichever lands first wins permanently, and Space
   Projector's simpler pipeline is likely to win often, discarding the
   poller's paid-for judge/embedding/cost data.
5. **No lease.** Existing idempotency already prevents corruption; the
   already-documented plan (retire the poller for SpanProjector) is the right
   long-term fix and doesn't need new infrastructure. Shipped the one small,
   safe, well-tested fix that was clearly missing: `insertTrace()` now
   reports whether it actually inserted, so the poller's own "duplicate"
   accounting — and a `/replay` route that was already written to use it —
   finally works.
