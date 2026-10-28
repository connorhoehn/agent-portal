# DE-6 Callback credentials without hand-copied runtime env

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Independent of DE-30 to DE-53. Pairs with DE-1 (one-command runtime rollout),
which today has to thread three secret contexts through every runtime deploy.

## Current state (read from the code, 2026-10-27)

The backlog line is right about the symptom and partly wrong about the cause.

- **Who holds what.** `OrgIQ-MiddlewareService` mints five callback secrets
  by fixed name: `orgiq-approvals-request-secret`, `-harness-trace-secret`,
  `-assessment-run-complete-secret`, `-lab-callback-secret`,
  `-harness-runner-secret` (`infra/lib/middleware-service-stack.ts:308`,
  `:315`, `:322`, `:351`, `:384`), and injects them as ECS container secrets
  (`:968`–`:978`). None has a rotation schedule.
- **How the fleet gets them.** The runtimes receive three of them as plain
  CDK context strings (`infra/bin/app.ts:245`–`:247`) written straight into
  `CfnRuntime.environmentVariables` (`infra/lib/agentcore-runtime-stack.ts:498`–`:500`);
  the devbox gets `labCallbackSecret` the same way (`app.ts:369`,
  `infra/lib/devbox-stack.ts:258`). The value is plaintext to anyone with
  `GetAgentRuntime`, and lives in the operator's shell history.
- **Why it is ordered.** The middleware stack is declared after the runtime
  and devbox stacks (`app.ts:209`, `:345`, `:402`) and Secrets Manager picks the
  value, so the runbook is: roll images, deploy middleware, read the value,
  redeploy every runtime (`docs/agentcore-preview-surface.md` §6a, steps 1–4).
  Each runtime redeploy is a version roll that wipes `/mnt/workspace`.
- **The stated cause is incomplete.** "Runtime env cannot reference Secrets
  Manager" is true of the env map, but nothing requires the value to arrive
  through env. The agents already fetch the Aurora credential at run time by
  ARN with `GetSecretValue` (`AURORA_SECRET_ARN`, `agentcore-runtime-stack.ts:328`–`:331`, `:450`).
  The callback secrets have fixed names, so a runtime can be granted
  `arn:…:secret:orgiq-approvals-request-secret-*` and read it by name with no
  cross-stack export and no ordering edge.
- **Read sites.** Agents read `os.environ[cb.env_var]` on every call
  (`agents/_shared/callbacks.py:142`–`:162`); the BFF reads `process.env[spec.envVar]`
  on every request (`middleware/src/lib/service-auth.ts:190`–`:192`), but ECS
  resolves that env once at task start, so a rotated value needs a task restart.
- **Envelope signing already shipped (lane C4).** The secret is now an HMAC key
  for service-runtime's signed envelope (`service-auth.ts:245`–`:270`,
  `callbacks.py:228`), with `SERVICE_AUTH_LEGACY_HEADERS` as the transition
  flag. The static header still crosses the wire until `refuse` is set. That
  rollout is blocked on cloud credentials (§6a.1).
- **AgentCore Identity is half-present.** `OrgIQ-AgentCoreCapabilities` creates
  one `CfnWorkloadIdentity` (`infra/lib/agentcore-capabilities-stack.ts:126`–`:134`);
  the BFF uses it only for the connected-sources token vault
  (`middleware/src/providers/connected-sources.ts:15`–`:16`, `:46`–`:51`), and the
  middleware stack never sets `WORKLOAD_IDENTITY_ARN` on the task, so that
  feature reads "not configured" when deployed. Runtimes are granted
  `GetWorkloadAccessToken*` (`agentcore-runtime-stack.ts:276`–`:277`) but no
  agent calls it.

## Change

Two steps. The first removes the hand copy and the ordered deploy with
mechanisms already proven in this repo; the second is the token swap the
backlog asks for, gated on facts not verifiable here.

**Step 1: fetch by name, accept two keys.**

1. Runtime and devbox execution roles get `secretsmanager:GetSecretValue` on
   the callback secrets by name pattern (`orgiq-<callback>-secret-*`), and the
   runtime env carries names, not values: `APPROVALS_REQUEST_SECRET_ID=orgiq-approvals-request-secret`, and so on.
2. `callbacks.secret_for` resolves `<VAR>` first (local dev and tests keep
   working unchanged), else `<VAR>_ID` through boto3 with a 300 s cache. On a
   401 it refetches once and re-signs, so a rotation heals without a restart.
3. The BFF stops taking these four as ECS secrets and reads them the same way
   (a small `lib/service-secrets.ts` with the same cache), keeping both
   `AWSCURRENT` and `AWSPREVIOUS`. `verifySignedRequest` tries current then
   previous, so a rotation has no window in either direction.
4. Add `addRotationSchedule` with a single-user rotation Lambda (generate
   random, set `AWSCURRENT`), every 90 days, per secret.
5. Delete the three runtime contexts and `labCallbackSecret` from `app.ts`,
   the stacks and §6a. A fresh account deploys the runtimes before the
   middleware: the reads fail closed until the secret exists, and callbacks
   behave as today's "unset" path does.

**Step 2 (optional, after step 1): workload tokens instead of a shared key.**
The agent obtains a workload access token for its runtime identity and sends
it as a bearer; the BFF verifies it and maps the workload name to the allowed
callbacks. **Unverified here:** whether a workload access token is a JWT a
third party can verify (issuer, JWKS endpoint, audience), whether each runtime
gets its own workload identity automatically, and whether the BFF can call
`GetWorkloadAccessTokenForJwt` without a user JWT. If any of those fails, the
fallback is a Cognito client-credentials app per agent (one OAuth2 credential
provider in the token vault), verified with the BFF's existing JWKS code path.
Step 2 is worth doing only if per-agent attribution or revocation matters;
step 1 already removes the plaintext values and the ordering.

Also fix in passing: set `WORKLOAD_IDENTITY_ARN` on the middleware task from
the capabilities stack's output by SSM name, as the other capability ids are.

## Decisions owed

- **Step 2 at all?** Proposal: ship step 1 now, park step 2 until a second
  external caller exists or per-agent revocation is asked for.
- **Rotation cadence.** Proposal: 90 days, plus a documented manual
  `rotate-secret` for a leak; both are now zero-window.
- **Order against lane C4.** Proposal: finish C4's `refuse` step first, so step
  1 only changes where the key comes from, not what crosses the wire.

## Done when

- `grep -n "approvalsRequestSecret\|harnessTraceSecret\|assessmentRunCompleteSecret\|labCallbackSecret" infra/bin/app.ts infra/lib/*.ts`
  returns nothing.
- `cd infra && npm test` includes assertions that no `CfnRuntime`
  `EnvironmentVariables` value matches a secret value or the `*_SECRET` names
  (only `*_SECRET_ID`), and that each runtime role can read exactly its
  callback secrets by name.
- `cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_callbacks`
  covers: env value wins, `_ID` fetch with cache, refetch-once on 401.
- A middleware jest test signs with the previous key and passes, signs with a
  key older than previous and gets 401.
- §6a's runbook is reduced to "deploy in any order"; a fresh-account deploy
  of runtime then middleware with no `--context` secrets passes an approval
  round trip (cloud check, blocked until credentials return).
