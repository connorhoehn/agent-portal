# Session brief — wi-auth-e2-b3

> Assembled 2026-10-14 for run job-contract-wi-auth-e2-b3 · 515 of 6,000 tokens · brief-job-contract-wi-auth-e2-b3

## Your task
**Logout leaves the legacy shim cookie alive** (bug, 2 pts, Auth Migration)
Signing out clears the OrgIQ session and not the SAML shim cookie, so the next visit silently re-authenticates.
Labels: session, decom.

## The project
**Auth Migration** — repo connorhoehnslalom/orgiq-auth-service. Parent epic: Legacy SSO decommission.

## Decisions that bind this work
- **Sunset legacy auth service** — resolved: Move every remaining service off the v1 auth gateway; the SAML shim is deleted once the last tenant has cut over to Cognito.

## Skills on this box
- **Recover a cold Aurora Data API** (skill-cold-start-aurora v2) — Use when the first Data API call after idle fails with HttpEndpointNotEnabled. Warms the endpoint and retries with backoff.
- **Triage a flaky test** (skill-flaky-test-triage v2) — Use when a test passes and fails without a code change. Reruns, diffs the outcomes, and files a bug with both logs.
- **Review a PR diff-scoped** (skill-pr-review-scoped v1) — Use when reviewing a pull request. Comments only on changed lines and posts one risk summary.

## The org's skills
The org's 10 established skills are installed in `~/.claude/skills` (library e9a6f4bbce29); Claude Code loads one when its description fits the task.

## How to report back
- When you finish, say which skills you followed: `lab applied <skill> followed` (or `lab applied <skill> failed --step 2 "why"`).
- If a skill was wrong or missing a step, write the corrected runbook markdown to a file and run `lab propose <skill> ./runbook.md` (or `lab propose new ./runbook.md`). A person reviews it.
- If you built a tool worth keeping (a script, a client, a harness), put it in `.lab/keep/<rb-name>/` as SKILL.md + scripts/ + data/ with an offline Verify step. It is proposed when the session ends, and a person reviews it before any box gets it.
- Record anything else you learned with `lab remember`.
