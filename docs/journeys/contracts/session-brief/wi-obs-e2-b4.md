# Session brief — wi-obs-e2-b4

> Assembled 2026-10-14 for run job-contract-wi-obs-e2-b4 · 628 of 6,000 tokens · brief-job-contract-wi-obs-e2-b4

## Your task
**Stop duplicate alerts during a dependency outage** (bug, 2 pts, Observability Platform)
When the shared Postgres connection proxy failed last month, 41 services paged separately within 6 minutes and the on-call engineer spent the first 20 minutes acknowledging duplicates. Alerts should group by the failing dependency, with the affected services listed inside one page.
Labels: alerting, blocked.

## The project
**Observability Platform** — repo connorhoehnslalom/orgiq-observability. Parent epic: SLOs and error budgets.

## Decisions that bind this work
- **Adopt OpenTelemetry** — resolved: Services traced with three different libraries, and no trace crossed a service boundary intact. We adopted OpenTelemetry SDKs with W3C trace context everywhere, using the AWS distribution where the runtime expects it, and export OTLP to X-Ray and the metrics backend. The cost is a migration per service and a collector fleet to run. The payoff is one trace from the browser to the database.

## Skills on this box
- **Recover a cold Aurora Data API** (skill-cold-start-aurora v2) — Use when the first Data API call after idle fails with HttpEndpointNotEnabled. Warms the endpoint and retries with backoff.
- **Triage a flaky test** (skill-flaky-test-triage v2) — Use when a test passes and fails without a code change. Reruns, diffs the outcomes, and files a bug with both logs.
- **Review a PR diff-scoped** (skill-pr-review-scoped v1) — Use when reviewing a pull request. Comments only on changed lines and posts one risk summary.

## The org's skills
The org's 18 established skills are installed in `~/.claude/skills` (library 5252658e78be); Claude Code loads one when its description fits the task.

## How to report back
- When you finish, say which skills you followed: `lab applied <skill> followed` (or `lab applied <skill> failed --step 2 "why"`).
- If a skill was wrong or missing a step, write the corrected runbook markdown to a file and run `lab propose <skill> ./runbook.md` (or `lab propose new ./runbook.md`). A person reviews it.
- If you built a tool worth keeping (a script, a client, a harness), put it in `.lab/keep/<rb-name>/` as SKILL.md + scripts/ + data/ with an offline Verify step. It is proposed when the session ends, and a person reviews it before any box gets it.
- Record anything else you learned with `lab remember`.
