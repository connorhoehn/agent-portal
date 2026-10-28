# DE-19 Script-made document resources under CloudFormation

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Uses DE-18's digest-context convention for the five document images.

## Current state (read from the code, 2026-10-27)

The backlog line is accurate. `scripts/docker/document-workspace-push.mjs`
provisions three kinds of resource that no stack owns:

| Resource | Created by | Notes |
|----------|------------|-------|
| ECR `orgiq-documents-{gateway,platform,catalog,mq,redis}` | `ensureRepository`, `:84-88` (`create-repository`, scan on push, no lifecycle rule) | images grow without bound |
| Secrets `orgiq-document-grant-{private,public}-key` | `ensureKeyPair`, `:91-111` (openssl Ed25519, `create-secret`) | reused, never rotated; refuses a half pair (`:96`) |
| SSM `/orgiq/documents/workspace-config` | `put-parameter --overwrite`, `:152-153` | the whole `DocumentWorkspaceConfig`: repo names, five digests, key ARNs, public URL |

The middleware stack consumes them by name or ARN and never creates them:
`attachDocumentWorkspace` imports the repos with `fromRepositoryName`
(`infra/lib/document-workspace.ts:66-68`) and the keys with
`fromSecretCompleteArn` (`:104-105`); its interface says "CDK never generates
or reads key bytes" (`:26`). Two other document secrets *are* CFN-generated
in the same file (`:101-103`), and the tables and upload EFS are CFN-owned
with `RetainExceptOnCreate` (`:80-98`).

How the deploy and teardown cope today:

- `deploy.sh` reads the SSM parameter back as `documentWorkspace` context
  whenever the middleware stack reports `DocumentGatewayPublicUrl`
  (`infra/scripts/deploy.sh:437-448`), because a deploy without it would tear
  the document services down.
- `destroy.sh` deletes the repos, secrets and parameter only under
  `PURGE_RETAINED=true` (`infra/scripts/destroy.sh:513-524`, `:563-575`), so
  they are the "teardown has resources CloudFormation does not own" item in
  `docs/aws-deploy-open-items-2026-10-27.md` §7.
- `deploy.sh`'s ECR orphan sweep does **not** list the document repos
  (`deploy.sh:262-276`). That is correct today: the sweep force-deletes any
  listed repo no stack owns (`:279-301`), so listing a script-made repo would
  delete it and its images on every deploy.
- `infra/cdk.json:20-49` carries a stale `documentWorkspace` block (account
  ARNs, `publicBaseUrl` `https://orgiq-docs.orgiq.test`, old digests). It is
  only the default when no `--context` is passed, so the SSM copy wins on
  every real deploy, but it is a second, wrong source.

The pattern to copy is `OrgIQ-SocialImages` (`infra/lib/social-images-stack.ts`):
RETAIN repos with a lifecycle rule, consumers import by name so no export
freezes, and the stack joins the app whenever a consumer's flag is set
(`infra/bin/app.ts:496-516`).

## Change

1. **`OrgIQ-DocumentImages`** (`infra/lib/document-images-stack.ts`) owns:
   - the five repos, named by the push script's existing
     `documentRepository()` rule, `RETAIN`, scan on push, a lifecycle rule
     (DE-18's tagged-by-count, untagged-by-age);
   - the two grant-key secrets, `RETAIN`, declared so a stack update never
     regenerates their value (verify on a scratch secret that the chosen
     declaration does not rewrite the value on update);
   - two `StringParameter`s holding the secrets' **complete** ARNs, read by
     name in the middleware stack, the same fix `social-stack.ts:397-401`
     made for partial-ARN imports.
2. **App wiring.** The stack joins the app when `deployDocumentImages` or
   `deployDocumentWorkspace` is set, and the middleware stack depends on it
   when both are in the app.
3. **Config shrinks to what is really input.** `DocumentWorkspaceConfig`
   keeps tenant, issuer, key id, architecture and optional source; repo names
   come from the naming rule, key ARNs from the parameters, `publicBaseUrl`
   from the portal parameters the middleware already reads under
   `portalPublicUrls` (`middleware-service-stack.ts:827-835`), and the digests
   from a `documentImageDigests` context (DE-18), carried forward by
   `deploy.sh` from a new middleware-stack output. `/orgiq/documents/workspace-config`
   and the `cdk.json` block are retired.
4. **Push script** only pushes and prints digests. It fails with "deploy
   OrgIQ-DocumentImages first" when a repo is missing, and mints keys only
   with `--mint-keys`, by `put-secret-value` into the CFN-owned secrets when
   they still hold the placeholder.
5. **Adopt, do not recreate.** On the live account, bring the existing repos,
   secrets and parameter in with `cdk import` (all three types support
   import), so images and key bytes survive. One-off runbook step, written in
   the stack's header comment.
6. **Teardown and sweep.** `deploy.sh`'s ECR orphan list gains the five names
   (now owned, so the ownership check protects them); `destroy.sh`'s
   script-resource block becomes the ordinary RETAIN purge, and the "created
   outside CFN" comment (`destroy.sh:518`) goes.

## Decisions owed

- **Who mints the key pair on a fresh account?** Proposal: keep it in the
  push script (`--mint-keys`), which honours "CDK never generates or reads key
  bytes". The alternative is a create-only custom resource using
  `crypto.generateKeyPairSync('ed25519')`; it makes a fresh deploy one step
  shorter but puts key generation in a Lambda.
- **Retention of the key secrets on teardown.** Proposal: RETAIN, like the
  repos, so a rebuild keeps verifying grants issued before it;
  `PURGE_RETAINED=true` still deletes them.

## Done when

- `cd infra && node --require ts-node/register --test test/document-images-stack.test.ts test/document-workspace.test.ts test/app-wiring.test.ts`
  passes: five RETAIN repos with lifecycle rules, two RETAIN secrets, two
  ARN parameters; the middleware template references the repos by name and
  the keys through the parameters; no `fromSecretNameV2`.
- `grep -nE "create-repository|create-secret|put-parameter" scripts/docker/document-workspace-push.mjs`
  finds nothing, and `node --test scripts/docker/tests/document-workspace-push.test.mjs`
  passes with a "repo missing → deploy the stack first" case.
- `grep -n documentWorkspace infra/cdk.json` finds nothing.
- `grep -c "documents-" infra/scripts/deploy.sh` covers all five repo names
  in `ECR_REPOS`.
- Cloud (once credentials work), after the import:
  `aws cloudformation describe-stack-resources --physical-resource-id orgiq-documents-gateway --query 'StackResources[0].StackName'`
  answers `OrgIQ-DocumentImages`; each repo's `list-images` count and each
  secret's `describe-secret … VersionIdsToStages` are unchanged from before
  the import; a `deploy.sh` with no document context keeps the services
  running.
