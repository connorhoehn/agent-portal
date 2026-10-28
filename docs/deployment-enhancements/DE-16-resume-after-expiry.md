# DE-16 Resume after credential expiry

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
The checkpoints are DE-14's state file. This spec owns the detection and the
safe stop. It also fixes, in `deploy.sh`, the place where an expired session is
mistaken for an empty account. DE-15 benefits: CI sessions expire too.

## Current state (read from the code, 2026-10-27)

- **The session is checked once.** `deploy.sh:43` reads `ACCOUNT=$(aws sts
  get-caller-identity …)` under `set -e`, so a deploy that **starts** expired
  fails at once. Nothing after that line checks again. The image scripts and
  `portal-publish.mjs` behave the same way (`middleware-image-build.mjs:93-99`,
  `document-workspace-push.mjs:128`). Nothing in `infra/scripts` or
  `scripts/docker` recognises `ExpiredToken`.
- **`destroy.sh` is the precedent.** Its `require_creds` (`destroy.sh:73-80`)
  stops with "re-run after aws-azure-login" and is called before its phases
  (`:483`, `:528`). Its header records why: it once reported success through
  expired credentials (`:43-46`).
- **`deploy.sh` treats "cannot read" as "absent", and that is the dangerous
  part.** Each inference query swallows errors and falls back to "nothing is
  live": the runtime count (`deploy.sh:384-386`, `|| echo 0`), the middleware
  desired count (`:388-390`), `stack_output` (`:368-374`, `|| true`),
  `stack_live` through `stack_status` (`:77-80`, `|| echo NOT_FOUND`), and the
  callback secrets (`:457-459`). If the session dies between `:43` and
  `:470`, the deploy runs with no `deployRuntimes`, no `deployMiddlewareService`
  and no `deployPortal`. The comment at `:351-357` lists what that does: it
  deletes every `CfnRuntime`, scales the BFF to 0, and removes the CloudFront
  lock. Today the only protection is that `cdk deploy` would usually fail on the
  same dead session.
- **Synth also hides it.** `resolveContainerUri` catches every error and returns
  `:latest` (`agentcore-runtime-stack.ts:30-35`). A synth on a dead session
  therefore changes each runtime's container URI from `@sha256:…` to `:latest`.
  The devbox shares this code (`devbox-stack.ts:219`, see DE-52).
- **A session that expires during `cdk deploy`** leaves CloudFormation running
  on the server while cdk's polling fails. The reconcile then calls every stack
  `NOT_FOUND (skipped — a dependency failed)` (`deploy.sh:702-706`), because
  `stack_status` cannot tell an auth error from a missing stack. That
  misdiagnosis is what an operator reads. The re-run then meets stacks still
  `*_IN_PROGRESS`, which CloudFormation refuses to update. The only waiter is
  `await_terminal` (`:656-663`), and it is used only on the replacement path.
- How long a session lasts is set by `aws-azure-login` and the role's maximum
  session. I did not read the operator's `~/.aws/config`. The open-items doc
  records this deploy running across two operator IPs overnight
  (`docs/aws-deploy-open-items-2026-10-27.md` item 5).

## Change

1. **One session library**, `infra/scripts/lib/aws-session.sh`, sourced by
   `deploy.sh`, `destroy.sh`, `idle.sh` and the agent build scripts. A Node
   twin, `scripts/lib/aws-session.mjs`, serves the `.mjs` scripts. It provides:
   - `require_session <min-minutes>`: `sts get-caller-identity` succeeds, the
     account equals the environment's (DE-17) and is not in
     `FORBIDDEN_ACCOUNTS`, and the expiry from `aws configure
     export-credentials` (CLI v2) is at least `min-minutes` away. A missing
     expiry, as with static keys, passes with a note.
   - `aws_read <args…>`: runs the call and classifies the failure. It prints
     the value on success. A real absence (`ValidationError … does not exist`,
     `ResourceNotFoundException`, `ParameterNotFound`, `NoSuchBucket`) returns
     the empty string with exit 0. `ExpiredToken`, `ExpiredTokenException`,
     `InvalidClientTokenId`, `UnrecognizedClientException` and "Unable to
     locate credentials" exit with code **75** (`EX_TEMPFAIL`), with one line
     to stderr: "AWS session expired: run aws-azure-login --mode gui, then
     resume". Any other error exits 1.
2. **`deploy.sh` stops instead of guessing.** Every inference query and
   `stack_status` go through `aws_read`. A 75 from any of them aborts **before**
   `cdk deploy`. `require_session 30` runs at the top and again right before
   `run_cdk_deploy`. The minimum is configurable as `DEPLOY_MIN_SESSION_MIN`.
   The reconcile reports `UNKNOWN (session expired)` rather than `NOT_FOUND`,
   and exits 75.
3. **Synth fails closed on auth.** `resolveContainerUri` keeps the `:latest`
   fallback only for a real empty repository (`ImageNotFoundException` /
   `RepositoryNotFoundException`). On an auth error it throws, so a dead
   session can no longer change a runtime's image.
4. **Resume settles in-flight stacks first.** On `resume` (DE-14), and at the
   top of `deploy.sh` for each stack it expects, any `*_IN_PROGRESS` stack is
   awaited with a bounded wait (`await_terminal`, raised to 30 min with a
   heartbeat line every 60 s, never `until grep`). A `*_FAILED` left behind
   goes through the existing single-shot recoveries. Only then does the deploy
   run.
5. **Long phases check the session first.** DE-14's runner calls
   `require_session` with each phase's expected duration before it starts: 45
   min for the fleet on a fresh account, 20 for images, 10 for publish. A phase
   that would outlive the session asks for a re-login up front rather than
   dying halfway. In CI (DE-15) it requests a role session of matching length.
6. **Exit code 75 has one meaning** across the deploy scripts: "re-login and
   resume; nothing was guessed". The orchestrator records the phase as
   `interrupted`, not `failed`.

## Decisions owed

- The minimum remaining session before a fleet deploy. Proposal: 30 min for
  `deploy.sh`. The orchestrator uses per-phase values, and an operator can lower
  them with an env var but never to zero.
- Should `InvalidClientTokenId` count as "expired" (75) or as "misconfigured"
  (1)? CLAUDE.md reports it as the steady state since early October, and that
  looks like a revoked key, not expiry. Proposal: 75 with the same re-login
  message, because the remedy is the same.

## Done when

- `node --test scripts/deploy/tests/aws-session.test.mjs` passes. It runs
  `aws-session.sh` against a stub `aws` on `PATH` and checks that each error
  string maps to the expected empty value, 75 or 1, and that `require_session`
  refuses 264161986065 and any account other than the environment's.
- A behavioural test runs `deploy.sh` with the stub answering `ExpiredToken` on
  the first inference query. It exits 75, never invokes the stub `cdk deploy`,
  and prints no `--context` lines.
- `infra/test/agentcore-runtime-stack.test.ts` checks that `resolveContainerUri`
  throws on an `ExpiredToken` stub and returns `:latest` on
  `ImageNotFoundException`.
- A reconcile against a stub that answers `ExpiredToken` prints
  `UNKNOWN (session expired)` and exits 75.
- A resume test runs against a stub stack sequence `UPDATE_IN_PROGRESS` →
  `UPDATE_COMPLETE` and waits before calling `cdk deploy`.
- `deploy-config.test.ts` gains a grep: no `2>/dev/null || echo 0` and no
  `|| echo "NOT_FOUND"` left in `deploy.sh`'s inference or `stack_status`.
