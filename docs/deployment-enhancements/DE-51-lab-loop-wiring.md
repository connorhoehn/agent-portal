# DE-51 Lab loop wiring in AWS

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Needs DE-52 (a devbox runtime must exist for its env to matter). Related: DE-6
(the secret is a plain runtime env var).

## Current state (read from the code, 2026-10-27)

The middleware half is done. `requireServiceAuth` answers 503 in production
when the secret is unset (`middleware/src/lib/service-auth.ts:323-327`,
covered by `middleware/src/lib/__tests__/service-auth-guard.test.ts:38`).
`LAB_CALLBACK_SERVICE_AUTH` (`service-auth.ts:178`) accepts a signed
`X-Service-Auth` envelope from service `orgiq-devbox` plus the static
`x-lab-auth` header during the transition. `OrgIQ-MiddlewareService` mints
`orgiq-lab-callback-secret` (`infra/lib/middleware-service-stack.ts:351`) and
injects it as `LAB_CALLBACK_SECRET` (`:978`). That is verified in the stack
code, not against the live task definition.

The devbox half is inert:

- `DevboxStack` renders `LAB_API_BASE` / `LAB_CALLBACK_SECRET` only when the
  props are given (`infra/lib/devbox-stack.ts:257-258`), and only on the phase 2
  runtime, after the early return at `:210`. `OrgIQ-Devbox` is phase 1 only in
  AWS (`docs/aws-deploy-open-items-2026-10-27.md:12`), so no env exists at all.
- `infra/bin/app.ts:368-369` reads both from hand-typed context
  (`labApiBase`, `labCallbackSecret`). Nothing defaults them, and
  `infra/scripts/deploy.sh` does not infer either one: its sticky-context block
  (`deploy.sh:382-468`) infers the three agent-callback secrets and
  `portalPublicUrl`, but not the lab secret, the lab origin, or `deployDevbox`.
- `agents/devbox/lab:70-73` soft-exits ("LAB_API_BASE is not set") on every
  call, so `lab brief`, `lab skills`, `lab signal`, `lab consult` and
  `lab keep` all do nothing in AWS.

**Which URL.** The runtime uses `networkMode: 'PUBLIC'` (`devbox-stack.ts:222`),
so it egresses from AWS addresses outside any `albAllowCidr`. The ALB has no
open listener because custodian revokes `0.0.0.0/0` within seconds
(`middleware-service-stack.ts:1125-1136`). With `deployPortal` the listener's
default action is a 403, and it forwards only requests that carry CloudFront's
origin-verify header or come from an allowlisted CIDR (`:1286-1311`). So the
ALB DNS name cannot work from a microVM. CloudFront can: `/api/*` is a
pass-through behaviour with every method, no caching and all viewer headers
forwarded (`infra/lib/portal-stack.ts:74`, `:190-197`), so `X-Service-Auth`,
`x-service-nonce` and `x-lab-run-token` arrive intact. Middleware 401s and 404s
are not rewritten into `index.html`, because the SPA rewrite is S3-only
(`:200-203`). The agent runtimes already use this route: their `MIDDLEWARE_URL`
defaults to `portalPublicUrl` (`app.ts:248-252`). The browser-origin
gate is not an obstacle. It acts only when an `Origin` header is present
(`middleware/src/lib/browser-origin.ts:36-37`), and `curl` from `lab` sends
none.

**The backlog line is accurate**, with one omission: even after DE-52, any
later `deploy.sh` that does not repeat `--context labApiBase=… labCallbackSecret=…`
silently strips both vars from the runtime, because neither is inferred.

## Change

1. **Default the origin** in `infra/bin/app.ts`: `labApiBase` falls back to
   `portalPublicUrl` in the same way as `middlewareUrl` (`app.ts:252`).
   `--context labApiBase=` still overrides it. Apply the same `https://` origin
   check used for `portalPublicUrl` (`app.ts:106`).
2. **Infer the secret and the gate** in `deploy.sh`'s sticky-context block:
   - `labCallbackSecret` from `${PREFIX}-lab-callback-secret`, using the existing
     `infer … secret` path so the value is never echoed. Add it to the loop at
     `deploy.sh:453`.
   - `deployDevbox=true` when `OrgIQ-Devbox` owns an
     `AWS::BedrockAgentCore::Runtime`, using the same count query as
     `deployRuntimes` (`deploy.sh:384-386`). This is shared with DE-52.
   The origin needs no extra inference rule: `portalPublicUrl` is already
   inferred from `OrgIQ-Portal`'s `PortalUrl` output (`deploy.sh:392-397`).
3. **Warn at synth** in `DevboxStack` when `deployDevbox` is on and
   `labApiBase` is set without `labCallbackSecret`. The production middleware
   then answers every lab call with a 401. Use `cdk.Annotations.addWarning`,
   following `middleware-service-stack.ts:1212`.
4. **Sign only.** Set `SERVICE_AUTH_LEGACY_HEADERS=refuse` in the runtime env.
   The `lab` script then sends only the single-use signed envelope and drops the
   static `x-lab-auth` header (`agents/devbox/lab:86-88`), so the shared secret
   never crosses CloudFront as a replayable header. The middleware keeps
   accepting the static header from other callers until its own flag flips.
5. **A smoke step** added to the DE-52 rollout runs `lab recall` in command mode
   on a fresh session. `GET /api/lab/experiences` is behind the lab guard, so a
   JSON answer proves the origin, the CloudFront path and the signature
   together. The "not wired" line means the env is missing. A 401 or 503 means
   the secret is wrong or missing.

**Ordered deploy** (cloud creds are currently `InvalidClientTokenId`; start
with `aws sts get-caller-identity` = 647757222309):

1. Confirm `OrgIQ-MiddlewareService` is live with the secret:
   `aws secretsmanager describe-secret --secret-id orgiq-lab-callback-secret`.
2. Confirm `OrgIQ-Portal` is live and its prefix-list rule survived custodian:
   `curl -sf $PORTAL_URL/health`. A 504 here means read the CloudFront SG first
   (`middleware-service-stack.ts:1224-1229`).
3. Run the DE-52 rollout. It deploys `OrgIQ-Devbox` with `deployDevbox=true`,
   and steps 1-2 of the Change supply the lab context.
4. Run the smoke in Change step 5.

The middleware already enforces auth, so the order cannot open a gap.
Rollback is redeploying the devbox with `--context labApiBase=` (empty), which
returns the loop to inert.

## Decisions owed

- Origin: CloudFront (`portalPublicUrl`) or something else. The alternatives
  are allowlisting AgentCore egress (no stable CIDR exists) or VPC network mode
  with an internal ALB path (a new subnet/SG design under custodian). Proposal:
  CloudFront, the path the agent callbacks already use.
- Whether `SERVICE_AUTH_LEGACY_HEADERS=refuse` ships on the devbox now (step 4)
  or waits for the middleware-wide flip. Proposal: now. The `lab` script has
  signed since lane C4, and the tests already run it with `refuse`
  (`middleware/src/lib/__tests__/lab-cli-skills.test.ts:48`).

## Done when

- `cd infra && npm test` passes, with new assertions:
  - `deploy-config.test.ts`'s inferred-key list (`:121-126`) includes
    `labCallbackSecret` and `deployDevbox`;
  - `devbox-stack.test.ts` "lab loop wiring" (`:112`) shows `LAB_API_BASE`
    equal to `portalPublicUrl` when only that is given, and
    `SERVICE_AUTH_LEGACY_HEADERS=refuse` on the runtime;
  - synthesizing with `deployDevbox=true labApiBase=https://x` and no secret
    produces the warning.
- `DEPLOY_INFER_CONTEXT=true ./scripts/deploy.sh OrgIQ-Devbox` against the live
  account prints `--context labCallbackSecret=<from Secrets Manager>` and
  `--context deployDevbox=true` among the inferred values.
- `aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <id>
  --query 'environmentVariables.LAB_API_BASE'` returns the CloudFront origin.
- The smoke `lab recall` on a fresh devbox session prints JSON, not
  "lab: LAB_API_BASE is not set".
- A dispatched run's `lab brief` prints a brief whose sha matches the run's
  brief in the portal, which exercises `x-lab-run-token` through CloudFront.
