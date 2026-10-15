# Distillation → runbooks: migration report

Generated once by `migrate-distillation.mjs` (deterministic, no model calls). The script and the distillation fixtures it read were retired in R7
(the script is in `docs/history/runbooks-migration/`), so this report is frozen: the runbooks now live in `middleware/src/mock/runbooks.seed.ts`.

Source: the distillation fixtures (mock/distillation.ts, deleted in R7), scenario `default`.

Artifacts: 11 · migrated: 9 · not migrated: 2 · unaccounted: 0

## Every artifact

- **art-001** (runbook, published) "Rerun-and-diff triage for a flaky collector-fleet test": migrated → rb-flaky-test-rerun-diff (published, v1, sha e342c04f19c6)
- **art-002** (runbook, published) "Recover a cold Aurora Data API with a warm SELECT 1 and retry": migrated → rb-aurora-cold-start-retry (published, v1, sha e491d03807c6)
- **art-003** (insight, published) "Collector-fleet Fargate tasks are ARM64": migrated → rb-fargate-arm64-image (published, v1, sha e26b43d8c7cd)
- **art-004** (decision, published) "Gate auth diffs on the CSRF evaluator before merge": migrated → rb-auth-pr-csrf-gate (published, v1, sha f30a894ddc96)
- **art-005** (convention, published) "Scan every ingested document for PII before it reaches the knowledge base": migrated → rb-ingest-pii-scan (published, v1, sha c05a8b7b2b13)
- **art-006** (runbook, draft) "Decommission StatsD service by service without breaking dashboards": migrated → rb-statsd-decommission (draft, v1, sha 3f52b1c476cd)
- **art-007** (convention, draft) "Bump session_epoch on every tenant/role switch": not-migrated: not a procedure: a session convention with nothing to run; kept as a note on rb-tenant-cutover and to be re-homed as a decision on p-auth-migration
- **art-008** (insight, retired) "OpenSearch Serverless and Aurora Serverless v2 both bill a floor at zero traffic": not-migrated: retired and superseded (the Aurora half by skill-cold-start-aurora); its pre-drain lesson is a note on rb-idle-teardown-proposal
- **art-009** (procedure, published) "Bring SSO up on a new origin without breaking the picker": migrated → rb-sso-new-origin (published, v1, sha 6e17a35c6d20)
- **art-010** (procedure, draft) "Cut one tenant over from SAML to Cognito": migrated → rb-tenant-cutover (published, v1, sha 2efaf8e20806)
- **art-011** (procedure, published) "Propose an idle-capacity teardown that gets approved": migrated → rb-idle-teardown-proposal (published, v1, sha 0ae3b9e0d04c)

## Runbooks emitted

| Runbook | Title | Scope | Owner | Status | Steps | From |
|---|---|---|---|---|---|---|
| rb-flaky-test-rerun-diff | Tell a flaky test from a real regression | repo orgiq-observability | Nora DaSilva | published | 5 | art-001 (runbook) |
| rb-aurora-cold-start-retry | Wake a cold Aurora Data API and retry the first call | tool aurora | Layla Hassan | published | 4 | art-002 (runbook) |
| rb-fargate-arm64-image | Deploy a Mac-built image to Fargate without exec format errors | tool fargate | Nora DaSilva | published | 4 | art-003 (insight) |
| rb-auth-pr-csrf-gate | Get an auth-service pull request through the CSRF check | repo orgiq-auth-service | Vera Green | published | 4 | art-004 (decision) |
| rb-ingest-pii-scan | Ingest a document into the knowledge base after a PII scan | repo orgiq-llm-platform | Nina Rivera | published | 5 | art-005 (convention) |
| rb-statsd-decommission | Move one service's metrics off StatsD without losing an alert | repo orgiq-observability | Nora DaSilva | draft | 5 | art-006 (runbook) |
| rb-sso-new-origin | Bring SSO up on a new origin without breaking the picker | Auth Migration | Vera Green | published | 5 | art-009 (procedure) |
| rb-tenant-cutover | Cut one tenant over from SAML to Cognito | Auth Migration | Vera Green | published | 3 | art-010 (procedure) |
| rb-idle-teardown-proposal | Propose an idle-capacity teardown that gets approved | Cost Optimization | Layla Hassan | published | 4 | art-011 (procedure) |

## Procedure steps, old to new

Each ordered fact of a source procedure and where it landed in the rewrite.

- art-009 → rb-sso-new-origin:
  - fact-013 (source step 1) → step 1: Leave the Cognito callback unset
  - fact-014 (source step 2) → step 2: Test SSO locally first
  - fact-015 (source step 3) → step 3: Put an HTTPS front door up
  - fact-016 (source step 4) → step 4: Set the callback (and step 5 confirms it)
- art-010 → rb-tenant-cutover:
  - fact-018 (source step 1) → step 1: Confirm sign-in works on the shim (the shim stays, flagged)
  - fact-019 (source step 2) → step 3: Sign in and check no live session was dropped
  - fact-020 (source step 3) → step 2: Flip only this tenant's flag
  - fact-021 (source step 4) → not a step: Roll back (flip the flag back)
- art-011 → rb-idle-teardown-proposal:
  - fact-022 (source step 1) → step 2: Tag the resource with its initiative
  - fact-023 (source step 2) → step 3: Write the proposal naming floor, initiative and dollars
  - fact-024 (source step 3) → step 4: Bring the dollar figure to the meeting

## Claims folded into rewrites

- fact-001, fact-002 (art-001) → the steps and notes of rb-flaky-test-rerun-diff
- fact-003, fact-004 (art-002) → the steps and notes of rb-aurora-cold-start-retry
- fact-005 (art-003) → the steps and notes of rb-fargate-arm64-image
- fact-006, fact-007 (art-004) → the steps and notes of rb-auth-pr-csrf-gate
- fact-008 (art-005) → the steps and notes of rb-ingest-pii-scan
- fact-009 (art-006) → the steps and notes of rb-statsd-decommission

## Procedure applications carried over (v1)

- papp-001 on sess-auth-04 → rba-sso-new-origin-1 on rb-sso-new-origin: succeeded → followed
- papp-002 on sess-auth-05 → rba-sso-new-origin-2 on rb-sso-new-origin: succeeded → followed
- papp-003 on sess-auth-06 → rba-sso-new-origin-3 on rb-sso-new-origin: succeeded → followed
- papp-004 on sess-auth-04 → rba-sso-new-origin-4 on rb-sso-new-origin: succeeded → followed
- papp-005 on sess-auth-05 → rba-tenant-cutover-1 on rb-tenant-cutover: succeeded → followed
- papp-006 on sess-auth-06 → rba-tenant-cutover-2 on rb-tenant-cutover: failed → failed at step 2

## Notes that cite non-procedural artifacts

- rb-tenant-cutover cites art-007
- rb-idle-teardown-proposal cites art-008

