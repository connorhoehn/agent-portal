# DE-21 Post-deploy verification gate

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Uses DE-22 (its custodian checks run inside this gate) and DE-24 (logins for
the browser checks). A step of DE-14's orchestrator once that exists.

## Current state (read from the code, 2026-10-27)

`deploy.sh` ends at CloudFormation status: it reconciles each expected stack
against `describe-stacks` and prints "Deploy complete" when all are
`CREATE_COMPLETE`/`UPDATE_COMPLETE`/`IMPORT_COMPLETE`
(`infra/scripts/deploy.sh:694-728`). Nothing after that asks whether anything
serves. The repo's own gotchas say why that is not enough: the middleware
stack reaches `CREATE_COMPLETE` with zero running tasks, and an ALB can be
healthy and unreachable once the custodian revokes its rule (CLAUDE.md,
"Deploying and tearing down").

What exists to build the gate from:

- **Two cloud specs, run by hand only.** `portal/e2e/cloud-call-smoke.spec.ts`
  (two Cognito users, one reused hangout room, audio over the SFU, two 200
  call-bindings, `:65-123`) and `portal/e2e/cloud-documents-smoke.spec.ts`
  (canvas grant, socket to `/document-realtime` through CloudFront, an edit
  that survives a reload, `:12-61`). Both skip unless `CLOUD_PORTAL_URL` and
  `CLOUD_LOGIN_*` are set (`cloud-call-smoke.spec.ts:12`,
  `cloud-documents-smoke.spec.ts:10`). `git grep` finds no caller besides
  the runbook in `docs/aws-deploy-open-items-2026-10-27.md:26-35`.
- **Sign-in goes through Cognito's hosted UI** (`portal/e2e/cloudSession.ts:7-23`),
  not `realSession.ts`: that file logs in through the picker
  (`realSession.ts:31-33`), which is 403 outside demo mode
  (`middleware/src/routes/session.ts:217-227`).
- **Logins live outside the repo**: `~/.orgiq-aws-test/logins.txt`,
  `<email> <password>` per line, mode 600, turned into `email:password` by
  `grep … | tr ' ' ':'` (open-items doc `:28-30`).
- **Test data is reused, not created.** The call spec looks up the room named
  `Cloud call smoke` and creates it only when missing, because rooms have no
  delete route (`cloud-call-smoke.spec.ts:77-91`); the document spec reuses a
  node titled `Cloud document smoke` (`cloud-documents-smoke.spec.ts:32-39`).
  Seven `Cloud call smoke <hex>` rooms and two drafts already sit on the
  shared stack (open-items item 6). The document spec still **appends** one
  `Persisted through the gateway <ms>` line per run (`:52-56`), so the reused
  draft grows forever under a gate that runs on every deploy.
- **The seat wait.** The call spec sleeps `CLOUD_SEAT_SETTLE_MS` (default
  15 s) before the guest joins (`cloud-call-smoke.spec.ts:108`), a workaround
  for the parallel-call race that realtime-modules 0.140.0 fixed locally but
  has not been proven in AWS (open-items item 1).
- **Health.** `/health` and `/api/health` (`middleware/src/index.ts:202-203`)
  answer 503 when the realtime gateway is not ready and 200 `degraded` when
  AWS credentials or the datastore probe are stale
  (`middleware/src/lib/health-handler.ts:22-50`). CloudFront forwards
  `/health` to the ALB (`infra/lib/portal-stack.ts:74`). `portal-publish.mjs`
  already fetches `/` and `/health` after a publish but only prints the result
  (`scripts/portal-publish.mjs:220-229`).
- **Target groups**: middleware (`middleware-service-stack.ts:1356`),
  platform-api (`social-stack.ts:638`), SFU API (`social-stack.ts:678`),
  document workspace (`document-workspace.ts:192`). Nothing reads their health
  after a deploy.
- Playwright runs `workers: 1`, `trace: 'retain-on-failure'`
  (`portal/playwright.config.ts:7,12`). A failed cloud run probably writes the
  typed password into its trace (`fill` arguments are recorded), under the
  gitignored `portal/test-results/`.

## Change

A standalone script, `infra/scripts/verify-deploy.sh`, that deploy.sh calls
after reconciliation and that an operator can run alone. It prints one line
per check and exits 0 (verified), 3 (deployed, not verified) or 1 (could not
run). Four tiers, each skipped only when its stack is not live:

1. **Infra (AWS API, no browser).**
   - ECS: for every service in cluster `${PREFIX}-middleware`,
     `runningCount == desiredCount` and `desiredCount > 0` where the sticky
     context says it should be (`deployMiddlewareService`,
     `deploySocialService`, `deployDocumentWorkspace`). Waits up to 5 min,
     bounded, polling `describe-services` (never a log grep).
   - Every target group attached to the middleware ALB:
     `describe-target-health` shows all targets `healthy`.
   - AgentCore: when `deployRuntimes` is live, every runtime in
     `OrgIQ-AgentCoreRuntime` is `READY`.
   - DE-22's custodian checks (security-group rules and the OAC bucket policy).
2. **HTTP through CloudFront.** `GET <PortalUrl>/` is 200 HTML;
   `GET <PortalUrl>/health` is 200 with `status: "ok"` (a `degraded` body
   fails, with its failing probe named); `GET <SfuPublicUrl>/api/ice-servers`
   and `<PlatformApiPublicUrl>/health` answer 200 when Social is live.
3. **Browser: documents** (`deployDocumentWorkspace` live):
   `cloud-documents-smoke.spec.ts`.
4. **Browser: calls** (`deploySocialMedia` and `deploySocial` live):
   `cloud-call-smoke.spec.ts`.

The browser tiers run in one `npx playwright test e2e/cloud-documents-smoke.spec.ts
e2e/cloud-call-smoke.spec.ts --project=chromium --trace=off` invocation, so
`workers: 1` keeps them sequential. That matters because Farah is the guest in
one spec and the document user in the other, and a tenant switch revokes the
same user's other cookies (CLAUDE.md, live tests).

**Logins.** The script reads `${ORGIQ_CLOUD_LOGINS:-~/.orgiq-aws-test/logins.txt}`,
refuses to run tier 3/4 unless the file is mode 600, owned by the caller and
outside the repo (`git -C <repo> ls-files --error-unmatch` fails on it), and
exports `CLOUD_LOGIN_*` into the Playwright child only. It never echoes a
password. The default mapping is by role, not by grep: call owner = a social
`community-admin` (Mira), call guest = a second social member (Farah), document
user = an assessment `ManageKnowledge` role (Farah). DE-24 writes the file.

**Spec changes.** The document spec replaces its previous `Persisted through
the gateway` line instead of appending one, so the reused draft stays the same
size. Neither spec creates a room or draft when `CLOUD_SMOKE_REUSE_ONLY=1`,
which the gate sets unless run with `--seed-fixtures` (a fresh stack's first
pass); a missing fixture then fails with "expected reused test data" instead
of minting another permanent room. Once
`cloud-call-smoke` passes with `CLOUD_SEAT_SETTLE_MS=0` on AWS, the gate passes
0 and the spec's default drops to 0.

**deploy.sh.** After "Deploy complete", it runs the gate unless
`DEPLOY_VERIFY=off`. A gate failure keeps the stacks and exits 3 with
"deployed, NOT verified". A single-stack deploy runs tiers 1–2 only;
`DEPLOY_VERIFY=full` forces the browser tiers.

## Decisions owed

- Should a failed gate fail the deploy? Proposal: exit 3, distinct from a
  CloudFormation failure (1), with no automatic rollback; the operator decides.
- Should browser tiers run on every full deploy? Each costs about 3 minutes.
  Proposal: run them on full deploys and whenever the Middleware, Social,
  SocialMedia, Portal or document stacks change; skip them on a single
  unrelated stack.
- One-off cleanup of the seven `Cloud call smoke <hex>` rooms. Rooms have no
  delete route; proposal: leave them, and queue a social-admin archive route
  rather than editing the table by hand.

## Done when

- `bash -n infra/scripts/verify-deploy.sh` passes, and `infra/test/deploy-config.test.ts`
  gains cases asserting that deploy.sh calls the gate after reconciliation,
  honours `DEPLOY_VERIFY=off`, and exits 3 (not 0) when the gate fails.
- A unit test drives the gate's parsers with recorded `describe-services`,
  `describe-target-health` and `/health` JSON fixtures: `runningCount <
  desiredCount`, one `unhealthy` target and a `degraded` health body each fail
  with the resource named.
- The gate refuses a logins file that is mode 644, or one inside the repo, and
  prints no password when it runs (`verify-deploy.sh 2>&1 | grep -c '<password>'` is 0
  against a test file).
- Two consecutive gate runs on the shared stack leave `/api/social/rooms` with
  the same count of rooms named `Cloud call smoke*`, and the reused draft's
  line count unchanged.
- Against the deployed stack: `infra/scripts/verify-deploy.sh` exits 0, and
  exits 3 after `aws ecs update-service --desired-count 0` on platform-api
  (restored afterwards).
