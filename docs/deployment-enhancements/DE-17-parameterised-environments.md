# DE-17 Parameterised environments

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Unblocks DE-14 (it reads the environment file), DE-15 (one GitHub environment
per file) and DE-16 (the account check). Related: DE-23 (allowlists), DE-29
(tenant manifest).

## Current state (read from the code, 2026-10-27)

**Account.** CDK takes it from the credentials (`env.account =
CDK_DEFAULT_ACCOUNT`, `infra/bin/app.ts:32-35`), so personal credentials would
deploy the whole fleet into 264161986065 without complaint. `deploy.sh` prints
the account and never checks it (`deploy.sh:43-48`), and neither does
`destroy.sh` (`:41`). Only the image scripts refuse the personal account
(`FORBIDDEN_ACCOUNTS`, `scripts/docker/social-images-build.mjs:34-36`, `:89`;
`middleware-image-build.mjs:58`; `document-workspace-push.mjs:129`), and they
only *warn* on any other account (`middleware-image-build.mjs:133`). Neither
`portal-publish.mjs` nor `agents/build-all.sh`, `agents/base/build.sh` and
`agents/devbox/build.sh` check the account at all.

**Region.** It is read under three spellings, each defaulting to us-east-1:
`CDK_DEFAULT_REGION` (`app.ts:34`), `AWS_DEFAULT_REGION` (`deploy.sh:42`,
`destroy.sh:40`, the `.mjs` scripts), and `AWS_REGION` (`agents/build-all.sh:13`,
`agents/base/build.sh:6`, `agents/devbox/build.sh:10`,
`schema/dump-stack-outputs.sh:13`). A shell that sets one but not the others
builds images in one region and deploys stacks in another.

**Prefix, and how it disagrees between the scripts and CDK.** CDK reads
`projectPrefix` from context (`app.ts:28`, `cdk.json:16`). `deploy.sh` and
`destroy.sh` read the `PREFIX` env var (`deploy.sh:41`, `destroy.sh:39`) and
never pass it to CDK. So `PREFIX=preview ./scripts/deploy.sh` sweeps
`preview-*` orphans and then deploys `orgiq-*`. Several things ignore the
prefix entirely:
- the stack ids are literal `OrgIQ-*` (`app.ts:40` and every stack), and
  `deploy.sh` queries them by those names (`:384`, `:391-441`, `:573-612`);
- the agent repositories are hard-coded (`build-all.sh:16`, `:42`;
  `base/build.sh:8`; `devbox/build.sh:12`);
- the span projector's function, rule, export and SSM name
  (`span-projector-stack.ts:42`, `:62`, `:122`, `:135`);
- the canary's SSM parameters and log group (`prompt-canary-stack.ts:159-184`);
- the `OTEL_SERVICE_NAME` (`agentcore-runtime-stack.ts:428`).

As a result, a second environment in the same account and region collides on
stack names and on these resources.

**Checked-in account state.** `cdk.json:20-50` holds a whole `documentWorkspace`
block: grant-key secret ARNs carrying `647757222309`, five image digests, and a
placeholder `publicBaseUrl` (`https://orgiq-docs.orgiq.test`). Live deploys
override it from SSM (`deploy.sh:441-447`). Any other environment that turns on
`deployDocumentWorkspace` would silently use the lab's ARNs.

**Domain vs CloudFront.** CloudFront-only works: the portal URL is the
distribution's own domain (`portal-stack.ts:233`). A domain exists only for the
ALB: `certificateArn` plus `portalAlbOriginHost` (`app.ts:388`,
`portal-stack.ts:162-166`). A custom alias on the portal distribution is
explicitly **not built** (`docs/social-calls-deploy-plan.md:858-860`).

## Change

1. **Environment files**, `infra/environments/<name>.json`, checked in and with
   no secrets:

   ```json
   { "name": "lab", "account": "647757222309", "region": "us-east-1",
     "prefix": "orgiq", "stackPrefix": "OrgIQ",
     "edge": { "mode": "cloudfront" },
     "features": { "social": true, "documents": true, "devbox": false },
     "monthlyBudgetUsd": 200, "alertEmail": "" }
   ```

   `edge.mode` is `cloudfront`, or `domain` with `certificateArn`,
   `portalAlbOriginHost` and optional `portalAliases` (with
   `portalCertificateArn`, which must be in us-east-1). The aliases are new
   work; until they exist, `domain` covers only what Runbook B already does.
2. **One loader**, `infra/lib/environment.ts` (`loadEnvironment(name)`). It
   reads `--context env=<name>` and defaults to `lab`. It validates the file:
   the account is 12 digits and not in `FORBIDDEN_ACCOUNTS`, the region is
   known, and the prefix matches `^[a-z][a-z0-9-]{1,14}$`. `app.ts` then sets
   **`env: { account, region }` from the file, not from the shell**. CDK refuses
   to deploy a stack whose explicit account differs from the credentials, so
   this is the hard guard against 264161986065. `FORBIDDEN_ACCOUNTS` moves to
   `infra/environments/forbidden-accounts.json`, read by the loader, by
   `scripts/lib/aws-env.mjs` (re-exported by `social-images-build.mjs`, so its
   current importers keep working) and by DE-16's `aws-session.sh`.
3. **Stack ids from `stackPrefix`.** Each id becomes `${stackPrefix}-Foundation`
   and so on. With `lab`'s `"OrgIQ"`, every id is unchanged, so nothing
   replaces. `deploy.sh` and `destroy.sh` read `prefix`, `stackPrefix`,
   `region` and `account` from the same file (`ENV=lab`, via `node -e` over the
   loader's output) and pass `--context env=<name>`. The `PREFIX` and region
   env vars are removed. A set `PREFIX` that disagrees with the file is an
   error, not an override.
4. **Prefix the hard-coded names** listed above, but only for environments
   other than `lab`. The rule is `prefix === 'orgiq' ? literal :
   \`/${prefix}/…\``, so lab's names, and with them its SSM state and alarms,
   do not move. The agent build scripts take `PREFIX`, `REGION` and `ACCOUNT`
   from the loader instead of their own defaults.
5. **Per-environment mutable state goes to SSM.** The `documentWorkspace` block
   leaves `cdk.json`. It already lives in SSM for lab, and `deploy.sh` already
   reads it. An environment without that parameter simply has no document
   workspace.
6. **Synth-time check.** `cdk synth --context env=lab` writes the resolved
   environment to `${stackPrefix}-Foundation` as the SSM parameter
   `/<prefix>/environment`, so `cdk diff` shows it whenever someone changes an
   environment file. (Built first as template Metadata, which CloudFormation
   never applies on its own: it never reached the account and every diff
   showed it pending. Changed 2026-10-29.)

## Decisions owed

- Do preview environments share the lab account, with their own prefix, or get
  accounts of their own? Proposal: the same account with prefix `pv<n>` for
  now. Aurora's idle cost (about $45 a month each; the knowledge base shares
  the cluster, see DE-26) makes previews expensive, so DE-26 needs to land
  with them.
- Should a custom portal domain (CloudFront alias, us-east-1 certificate, DNS
  record) be built? Proposal: not until a domain exists. Keep
  `edge.mode: cloudfront` as the only fully supported mode, and have the loader
  reject `portalAliases` until the stack supports them.
- Does `alertEmail` belong in a checked-in file? Proposal: no. Keep it in
  context or an SSM parameter, because it is personal data.

## Done when

- `cd infra && npm test` passes, with a new `environment.test.ts`:
  - `lab.json` loads, and a file whose account is `264161986065` throws;
  - a bad prefix or region throws;
  - every stack the `lab` environment synthesizes keeps its current id and an
    explicit `env.account` of `647757222309`.
- Snapshot test: `cdk synth --context env=lab` before and after the change
  gives identical templates, apart from the new metadata (no resource renames).
- A synth of a test environment `pv1` produces `pv1-*` resource names and
  `OrgIQPv1-*` stack ids, with no literal `orgiq` left in names (a grep over
  `cdk.out` for `"orgiq-` and `/orgiq/` comes back empty).
- `deploy-config.test.ts`: `cdk.json` has no `documentWorkspace` and no
  12-digit account. `deploy.sh` and `destroy.sh` read no `PREFIX` or
  `AWS_DEFAULT_REGION` defaults.
- With a stub `aws` on `PATH` whose `sts get-caller-identity` answers
  `264161986065`, `ENV=lab ./scripts/deploy.sh` exits non-zero before the first
  orphan sweep, and the stub records no `delete-*` or `rb` call. With
  `111111111111` it fails the same way.
