# Session brief — wi-inf-e1-b3

> Assembled 2026-10-14 for run job-contract-wi-inf-e1-b3 · 350 of 6,000 tokens · brief-job-contract-wi-inf-e1-b3

## Your task
**Cold-start p99 breaches SLA after scale-to-zero** (bug, 3 pts, Inference Platform)
Labels: latency.

## The project
**Inference Platform** — repo connorhoehnslalom/orgiq-inference-platform. Parent epic: Serving reliability.

## Skills on this box
- **Recover a cold Aurora Data API** (skill-cold-start-aurora v2) — Use when the first Data API call after idle fails with HttpEndpointNotEnabled. Warms the endpoint and retries with backoff.
- **Triage a flaky test** (skill-flaky-test-triage v2) — Use when a test passes and fails without a code change. Reruns, diffs the outcomes, and files a bug with both logs.
- **Review a PR diff-scoped** (skill-pr-review-scoped v1) — Use when reviewing a pull request. Comments only on changed lines and posts one risk summary.

## Runbooks for this work

No runbooks matched this work.

## How to report back
- When you finish, say which runbooks you followed: `lab applied <runbook-id> followed` (or `lab applied <runbook-id> failed --step 2 "why"`).
- If a runbook was wrong or missing a step, write the corrected markdown to a file and run `lab propose <runbook-id> ./runbook.md` (or `lab propose new ./runbook.md`). A person reviews it.
- Record anything else you learned with `lab remember`.
