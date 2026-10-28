# DE-15 CI/CD from GitHub Actions

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Needs DE-14 (CI runs `orchestrate.mjs` and nothing else), DE-16 (exit 75 and
session length) and DE-17 (one GitHub environment per environment file).
Related: DE-18 (digest pins), DE-21 (verification gate).

## Current state (read from the code, 2026-10-27)

- **There is no CI.** This repo has no `.github/` directory. The remote is
  `git@github.com:connorhoehnslalom/aws-agentcore.git`. Every deploy and image
  build runs on the operator's laptop with `aws-azure-login` credentials.
- **Local builds are a stated choice.** `middleware-image-build.mjs:3` and
  `social-images-build.mjs:3` say "local `docker buildx`, never CodeBuild", and
  `docs/social-calls-deploy-plan.md:360-361` repeats it without giving a reason.
  Every image is `linux/arm64` (`middleware-image-build.mjs:64`,
  `agents/build-all.sh:46`, `agents/base/build.sh:20`). On an x86 runner that
  means QEMU emulation, which is slow.
- **Private GitHub code spans two owners and nine repositories.** This is more
  than the backlog line suggests:
  - Middleware: `connorhoehn/distributed-core` and `connorhoehn/service-runtime`
    are `git+ssh` lockfile pins (`middleware/package.json:35`, `:54`).
    `prepare-libraries.mjs` fetches each from `git@github.com:<owner>/<repo>`
    (`:37`, `:58`, `:66`) into sibling checkouts (`:15`).
  - Social images: `connorhoehn/realtime-examples`,
    `connorhoehnslalom/platform-api` and `connorhoehn/live-video-streaming` are
    cloned with `--ssh default`, and the SFU build also needs `GH_TOKEN`
    (`social-images-build.mjs:101-102`, `:167-168`).
  - Documents: `connorhoehn/managed-nosql-store`, `connorhoehnslalom/message-queue`,
    `connorhoehnslalom/event-catalog` and `connorhoehnslalom/ui-components`
    (`scripts/docker/document-workspace-sources.json`), fetched into a bare
    cache (`document-workspace-build.mjs`, `resolveCommittedRepository`).
  - The portal and the infra need **no** GitHub credential, because
    ui-components, realtime-modules and realtime-examples-cdk are vendored
    tarballs (`portal/vendor/`, `infra/vendor/`). The agent Dockerfiles have no
    private dependencies.

  A fine-grained PAT or a GitHub App installation token is scoped to **one**
  owner, so the credential has to come in two parts.
- **Synth calls AWS.** `resolveContainerUri` shells out to `aws ecr
  describe-images` (`agentcore-runtime-stack.ts:14-36`). Even a PR-time
  `cdk synth` therefore needs read credentials, or it falls back to `:latest`.
- **`deploy.sh` deletes things.** The orphan sweeps remove buckets, tables, ECR
  repositories and pending secrets (`deploy.sh:85-307`), and inference reads
  secret values (`:457`). A CI role that can run `deploy.sh` as it stands needs
  delete rights over most of the account.
- **Plain secrets reach the synthesized template.** The callback secrets go in
  as context and become runtime env vars (`app.ts:245-247`), so `cdk.out` must
  never be uploaded as an artifact.

## Change

1. **`OrgIQ-CiCd` stack** (opt-in, `--context deployCiCd=true`, deployed once by
   the operator). It holds the GitHub OIDC provider
   (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`) and two
   roles. Both trust only `repo:connorhoehnslalom/aws-agentcore:environment:<env>`,
   never `ref:*` or `pull_request`:
   - `orgiq-ci-deploy`: may `sts:AssumeRole` into the CDK bootstrap roles
     (`cdk-hnb659fds-{deploy,file-publishing,image-publishing,lookup}-role-<account>-<region>`).
     It also gets the reads `deploy.sh` inference needs, scoped by name:
     `GetSecretValue` on `${prefix}-*-secret`, SSM `/${prefix}/*`, and the
     `ecs:Describe*`, `cloudformation:Describe*`/`List*` and
     `bedrock-agentcore-control:Get*`/`List*` calls. It can also push to the
     `${prefix}-*` ECR repositories, sync and invalidate the portal, and
     `ecs:UpdateService` on the cluster. It gets **no** delete rights outside
     what CloudFormation does through the bootstrap role. `MaxSessionDuration`
     is 2 h, sized by DE-16's per-phase minimums.
   - `orgiq-ci-read`: read-only, for PR `cdk diff` and `plan --dry-run`. Its
     trust allows `environment:<env>-plan`.
   The stack's `env.account` comes from DE-17, so it cannot be created in
   264161986065.
2. **The deploy skips orphan sweeps in CI.** `DEPLOY_SWEEP_ORPHANS=false` (new,
   default `true`) skips `deploy.sh:85-333`. A sweep is a rebuild-after-teardown
   tool for an operator. If CI meets a stack that will fail on a stranded name,
   it fails and names the operator command.
3. **Workflows** in `.github/workflows/`:
   - `ci.yml` (pull requests, no AWS): `cd infra && npm ci && npm test`,
     `node --test scripts/docker/tests/*.test.mjs scripts/deploy/tests/*.test.mjs`,
     `bash -n` over `infra/scripts/*.sh agents/**/*.sh`, and every
     `--dry-run`. Not the middleware or portal full suites: CLAUDE.md warns
     that concurrent full runs hang, so they keep a job of their own, one at a
     time.
   - `plan.yml` (manual or nightly, environment `lab-plan`, `orgiq-ci-read`):
     `orchestrate.mjs plan --env lab --dry-run`, with the plan posted as the job
     summary.
   - `deploy.yml` (`workflow_dispatch` only, environment `lab` with the user as
     required reviewer, `concurrency: deploy-lab`): `orchestrate.mjs apply --env
     lab`. Exit 75 marks the run "interrupted, re-run to resume", and a re-run
     resumes from DE-14's SSM run record and lock.
4. **ARM64 builds in the cloud, natively.** The image phases run on an arm64
   runner, so buildx builds `linux/arm64` without emulation. The scripts do not
   change: they already take `--account`/`--region` and push by digest. See
   the first decision for which runner.
5. **A scoped GitHub read credential.** A GitHub App `orgiq-ci-read` with only
   `contents: read` is installed on `connorhoehn` and on `connorhoehnslalom`,
   limited to the nine repositories above. The job mints two installation
   tokens with `actions/create-github-app-token` (`owner:` set to each account)
   and maps them with `git config url."https://x-access-token:<t>@github.com/<owner>/".insteadOf
   "git@github.com:<owner>/"`. The `git+ssh` locators that `prepare-libraries`
   and the source manifest read then resolve with no SSH key. `GH_TOKEN` for
   the SFU build is the `connorhoehn` token. The app's private key is a secret
   of the GitHub environment, never a repository secret.
6. **Guards:** the deploy job runs `aws sts get-caller-identity` first and fails
   unless the result equals the environment file's account. CI never uploads
   `cdk.out` or `.scratch/`. And the existing rule applies: a repository CI
   creates is checked with `gh repo list --visibility public`.

## Decisions owed

- Which arm64 runner. GitHub's standard arm64 runners are free for public
  repositories; a private repository needs paid larger runners, and I did not
  check this account's plan. The alternative is CodeBuild on `ARM_CONTAINER` as
  a GitHub Actions runner, which builds inside the account but reverses the
  "never CodeBuild" choice and needs a CodeConnections link. Proposal: GitHub
  larger arm64 runners if the plan has them, otherwise CodeBuild runners.
- GitHub App or per-repository deploy keys. Nine read-only deploy keys need no
  app, but each needs its own SSH host alias. Proposal: the App, because it is
  one credential to rotate and its scope shows on one page.
- Deploy on merge to `main`, or manual only. Proposal: manual only until DE-21's
  verification gate exists. A nightly `plan` shows drift without changing
  anything.
- Whether the account custodian allows an IAM OIDC provider and roles with this
  trust policy. This is unknown. Proposal: deploy `OrgIQ-CiCd` first, read the
  provider back after 60 s, as the CloudFront probe did
  (`social-calls-deploy-plan.md:783-785`), and stop if it was removed.

## Done when

- `cd infra && npm test` passes with `ci-cd-stack.test.ts`:
  - the trust policy's `sub` condition is exactly
    `repo:connorhoehnslalom/aws-agentcore:environment:lab`, with no wildcard;
  - the deploy role has no `*:Delete*` outside `sts:AssumeRole` to the
    bootstrap roles;
  - synthesizing for account `264161986065` throws.
- `deploy-config.test.ts` shows that `DEPLOY_SWEEP_ORPHANS=false` guards every
  `delete-repository`, `rb` and `delete-table` in `deploy.sh`.
- `actionlint .github/workflows/*.yml` is clean, and `ci.yml` passes on a pull
  request with no AWS or GitHub App secrets present.
- `plan.yml` on `main` produces a dry-run plan whose account line is
  `647757222309` and whose log contains no `docker push` or
  `cdk deploy`.
- One `deploy.yml` run builds the middleware image on an arm64 runner.
  `docker buildx imagetools inspect <repo>@<digest> --raw` shows a single
  `linux/arm64` manifest, and the run needed neither an SSH key nor a personal
  token.
