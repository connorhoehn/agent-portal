# Session brief — wi-obs-e2-b4

> Assembled 2026-10-14 for run job-contract-wi-obs-e2-b4 · 523 of 6,000 tokens · brief-job-contract-wi-obs-e2-b4

## Your task
**Stop duplicate alerts during a dependency outage** (bug, 2 pts, Observability Platform)
When one shared dependency fails, it can trigger forty separate pages. Fixing this should help the on-call engineer identify the root problem without sorting through duplicate alerts.
Labels: alerting, blocked.

## The project
**Observability Platform** — repo connorhoehnslalom/orgiq-observability. Parent epic: SLOs and error budgets.

## Decisions that bind this work
- **Adopt OpenTelemetry** — resolved: Replace ad-hoc tracing with OTLP + AWS X-Ray for unified observability.

## Skills on this box
- **Recover a cold Aurora Data API** (skill-cold-start-aurora v2) — Use when the first Data API call after idle fails with HttpEndpointNotEnabled. Warms the endpoint and retries with backoff.
- **Triage a flaky test** (skill-flaky-test-triage v2) — Use when a test passes and fails without a code change. Reruns, diffs the outcomes, and files a bug with both logs.
- **Review a PR diff-scoped** (skill-pr-review-scoped v1) — Use when reviewing a pull request. Comments only on changed lines and posts one risk summary.

## The org's skills
The org's 12 established skills are installed in `~/.claude/skills` (library 5f7be950a7f9); Claude Code loads one when its description fits the task.

## How to report back
- When you finish, say which skills you followed: `lab applied <skill> followed` (or `lab applied <skill> failed --step 2 "why"`).
- If a skill was wrong or missing a step, write the corrected runbook markdown to a file and run `lab propose <skill> ./runbook.md` (or `lab propose new ./runbook.md`). A person reviews it.
- If you built a tool worth keeping (a script, a client, a harness), put it in `.lab/keep/<rb-name>/` as SKILL.md + scripts/ + data/ with an offline Verify step. It is proposed when the session ends, and a person reviews it before any box gets it.
- Record anything else you learned with `lab remember`.
