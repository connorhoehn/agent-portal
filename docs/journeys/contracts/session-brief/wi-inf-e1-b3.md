# Session brief — wi-inf-e1-b3

> Assembled 2026-10-14 for run job-contract-wi-inf-e1-b3 · 499 of 6,000 tokens · brief-job-contract-wi-inf-e1-b3

## Your task
**Cold-start p99 breaches SLA after scale-to-zero** (bug, 3 pts, Inference Platform)
Models idle for 15 minutes scale to zero, and the next request pays the container start plus a 7 GB weight load. p99 on the embedding model reached 74 seconds against a 2.5-second SLO. The fix is a warm floor on tier-1 models or a faster load path.
Labels: latency.

## The project
**Inference Platform** — repo connorhoehnslalom/orgiq-inference-platform. Parent epic: Serving reliability.

## Skills on this box
- **Recover a cold Aurora Data API** (skill-cold-start-aurora v2) — Use when the first Data API call after idle fails with HttpEndpointNotEnabled. Warms the endpoint and retries with backoff.
- **Triage a flaky test** (skill-flaky-test-triage v2) — Use when a test passes and fails without a code change. Reruns, diffs the outcomes, and files a bug with both logs.
- **Review a PR diff-scoped** (skill-pr-review-scoped v1) — Use when reviewing a pull request. Comments only on changed lines and posts one risk summary.

## The org's skills
The org's 18 established skills are installed in `~/.claude/skills` (library 7354127fe868); Claude Code loads one when its description fits the task.

## How to report back
- When you finish, say which skills you followed: `lab applied <skill> followed` (or `lab applied <skill> failed --step 2 "why"`).
- If a skill was wrong or missing a step, write the corrected runbook markdown to a file and run `lab propose <skill> ./runbook.md` (or `lab propose new ./runbook.md`). A person reviews it.
- If you built a tool worth keeping (a script, a client, a harness), put it in `.lab/keep/<rb-name>/` as SKILL.md + scripts/ + data/ with an offline Verify step. It is proposed when the session ends, and a person reviews it before any box gets it.
- Record anything else you learned with `lab remember`.
