# Session brief — wi-obs-e2-b4

> Assembled 2026-10-14 for run job-contract-wi-obs-e2-b4 · 1,341 of 6,000 tokens · brief-job-contract-wi-obs-e2-b4

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

## Runbooks for this work

### 1. Tell a flaky test from a real regression (rb-flaky-test-rerun-diff v1)
Included because: repo orgiq-observability; triggers on repo orgiq-observability; keywords fail.

# Tell a flaky test from a real regression

Rerun a failing collector-fleet test alone and in parallel, then diff the runs, before anyone quarantines it as flaky or files a bug against the code.

## Use when

- A collector-fleet test failed in CI but passes on your machine.
- Someone wants to quarantine a test as flaky.

## Not for

- A test that fails the same way on every run, locally and in CI: treat it as a regression and debug it.
- A CI job that fails before any test runs (install or build errors).

## Before you start

- [ ] You have the failing CI run's id (`$RUN_ID`) and the test's file and name (`$TEST_FILE`, `$TEST_NAME`).
- [ ] Your checkout is at the commit CI tested.

## Steps

1. **Save the failing CI log for the test before anything reruns over it.**
   ```bash
   gh run view "$RUN_ID" --log-failed > failed-ci.log
   ```
   Expect `failed-ci.log` holds the failing assertion and its stack.
2. **Rerun the test alone three times, one after another, on the same commit.**
   ```bash
   for i in 1 2 3; do npx jest "$TEST_FILE" -t "$TEST_NAME" --runInBand > "rerun-$i.log" 2>&1; echo "run $i exit $?"; done
   ```
   Expect three exit codes: all non-zero means a real regression, any zero means the failure depends on how CI ran it.
3. **Rerun the test with the rest of its suite in parallel, the way CI runs it.**
   ```bash
   npx jest "$(dirname "$TEST_FILE")" --maxWorkers=4 > parallel.log 2>&1; echo "exit $?"
   ```
   Expect a failure here but not in step 2 points at state shared between tests, most often two collectors binding one port.
4. **Diff the failing CI output against a passing rerun.**
   ```bash
   diff <(grep -E 'Error|expect|EADDRINUSE' failed-ci.log) <(grep -E 'Error|expect|EADDRINUSE' rerun-1.log)
   ```
   Expect `EADDRINUSE` or a timeout only on the CI side for port contention, the same assertion on both sides for a regression.
5. **Record the verdict, flaky or regression, on the work item before anyone quarantines the test.**
   ```bash
   curl -s -b "$COOKIE_JAR" -X POST "$BFF/api/graph/work-items/$WORK_ITEM_ID/comments" \
     -H 'content-type: application/json' \
     -d '{"body":"Flaky: EADDRINUSE under parallel CI, passes 3 of 3 alone (rerun-1.log, parallel.log)."}'
   ```
   Expect the new comment in the response, signed with your name.

## Verify

- The work item carries the verdict and names the logs it rests on.
- A test marked flaky passed all three solo reruns in step 2.

## If it goes wrong

| Symptom | Likely cause | Do this |
|---|---|---|
| All three solo reruns fail | A real regression, not a flake | Debug the code; do not quarantine the test |
| Solo reruns pass, the parallel run fails with `EADDRINUSE` | Two collectors in the suite bind the same port | Give each test its own port, then rerun step 3 |
| The CI log is gone | The job was re-run over in CI | Re-run the CI job once and save its log before anything else |

## Roll back

1. Take the test back out of quarantine if a later failure contradicts a flaky verdict, and post the new evidence on the work item.

## Selection hints

- Labels: flaky, ci, otel
- Repos: orgiq-observability
- Tools: jest, gh
- Keywords: flaky, test, regression, rerun, quarantine, collector

## Notes

Quarantining without this check once hid a real regression for a week: a seed-value bug shipped under a "known flaky" label.
The Library skill `skill-flaky-test-triage` is the invocable form of this runbook.

## How to report back
- When you finish, say which runbooks you followed: `lab applied rb-flaky-test-rerun-diff followed` (or `lab applied rb-flaky-test-rerun-diff failed --step 2 "why"`).
- If a runbook was wrong or missing a step, write the corrected markdown to a file and run `lab propose rb-flaky-test-rerun-diff ./runbook.md` (or `lab propose new ./runbook.md`). A person reviews it.
- Record anything else you learned with `lab remember`.
