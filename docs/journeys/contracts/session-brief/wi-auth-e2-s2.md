# Session brief — wi-auth-e2-s2

> Assembled 2026-10-14 for run job-contract-wi-auth-e2-s2 · 654 of 6,000 tokens · brief-job-contract-wi-auth-e2-s2

## Your task
**Tenant-by-tenant cutover runbook with rollback** (story, 5 pts, Auth Migration)
Each tenant already moves with the single-tenant cutover runbook: pre-flight the Cognito app client, flip the IdP route, watch the login error rate for 15 minutes, and roll back by restoring the shim route. This story writes the order the 12 remaining customer tenants move in and the rollback for each, which waits on the escalated decision "Cutover order for legacy SSO tenants".
Labels: decom, runbook, blocked.

## The project
**Auth Migration** — repo connorhoehnslalom/orgiq-auth-service. Parent epic: Legacy SSO decommission.

## Decisions that bind this work
- **Sunset legacy auth service** — resolved: The v1 auth gateway kept sessions in memory, could not rotate its signing key without signing everyone out, and failed its last penetration test on session fixation. We decided to move every service to Cognito with the BFF holding tokens server-side. The SAML shim is deleted once the last tenant has cut over, not kept as a fallback, because a fallback means patching two login paths indefinitely.

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
