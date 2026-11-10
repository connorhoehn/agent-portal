# Infrastructure security notes

Work item 19 in `docs/next-steps.md` §8 (least privilege for the infrastructure). This file lists every context flag the change added, the order to roll it out to an environment that already exists, and what is still open.

## Context flags

| Flag | Default | What it does |
|---|---|---|
| `protectData` | `true` | Deletion protection on, and RETAIN, for Aurora (plus 7-day backups), the documents bucket and the Cognito user pool. `-c protectData=false` is for throwaway stacks: DESTROY, 1-day backups, deletion protection off. |
| `auroraSkipFinalSnapshot` | `false` | Only with `protectData=false`. The Aurora deleter takes a final snapshot (`<prefix>-aurora-final-<time>`) unless this is `true`. |
| `dbMasterSecret` | `false` | One-release fallback. Hands the Aurora master secret back to the middleware, the writer agents and the knowledge base instead of their own logins. |
| `kbMasterSecret` | `false` | One-release fallback for the knowledge base only. Switching the KB to its own login replaces it (see step 5 below). |
| `plaintextCallbackSecrets` | `false` | One-release fallback. Accepts the old `approvalsRequestSecret`, `harnessTraceSecret`, `assessmentRunCompleteSecret` and `labCallbackSecret` values in context. Without it, passing a value fails the synth. `deploy.sh` sets it only with `PLAINTEXT_CALLBACK_SECRETS=1`. |
| `authDev` | `false` | Development Cognito pool: adds the localhost callback and sign-out URLs and the admin-password flow (`AdminInitiateAuth`). |
| `allowHttpOrigin` | `false` | Lets `deployPortal` run without `certificateArn`, so CloudFront reaches the ALB over plain HTTP. Throwaway stacks only; it leaves a synth warning. |
| `nag` | unset | `true` requires cdk-nag and fails the synth without it, `false` skips it. Unset runs it when installed and warns when not. |
| `microvm` | `false` | Adds OrgIQ-MicrovmNetwork and OrgIQ-MicrovmRuntime and the middleware's microVM grants. See "microVM runner" below. |
| `xrayIndexingPercent` | unset | A number from 1 to 100. OrgIQ-AgentCoreTelemetry then manages X-Ray Transaction Search for the account and Region (`AWS::XRay::TransactionSearchConfig`, plus the CloudWatch Logs policy that lets X-Ray write `aws/spans`) at that indexing share. The traces list only sees indexed spans, and the default is 1%. Unset leaves the setting alone. In an account that already turned Transaction Search on outside CloudFormation, set the share with one call instead: `aws xray update-indexing-rule --name Default --rule '{"Probabilistic":{"DesiredSamplingPercentage":100}}'`. Indexing above 1% is billed per span. |

Middleware sizing: with the realtime gateway on (`realtimeGateway=true`), the middleware task now defaults to 2 vCPU / 4 GB. That is the measured profile: 1,000 sockets and 100 calls with no errors and chat p95 about 0.7 s (`docs/spend-map.md`). At 1 vCPU the BFF pinned one core and chat p95 was 1.2 to 1.8 s. Without the gateway the size is unchanged. `middlewareCpu` and `middlewareMemoryMiB` still override it.

## What changed

- **One Aurora login per service.** `schema/service_roles.sql` creates `orgiq_app_middleware`, `orgiq_graph_writer` and `orgiq_kb_service`, and OrgIQ-Aurora mints a secret for each (`<prefix>-aurora-{middleware,graph-writer,kb}-credentials`).
  - graph-builder and scoring write as the graph writer.
  - search, advisor and ingestion read as `orgiq_graph_reader`.
  - supervisor and the assessment agents get no database access.
  - The master secret is left to schema loading and migrations. The KnowledgeBase init steps, SpanProjector and PromptCanary still use it (see open items).
- **Named actions on named ARNs.** The gateway role holds `AuthorizeAction`, `PartiallyAuthorizeActions` and `GetPolicyEngine` on its policy engine. It used to hold `bedrock-agentcore:*` on `*`. `GetAgentRuntime` and `InvokeAgentRuntime` are limited to `runtime/<prefix>_*`. `test/least-privilege.test.ts` keeps it that way.
- **Confused-deputy conditions.** Every service trust policy has `aws:SourceAccount` and `aws:SourceArn` (`lib/service-trust.ts`, `test/service-trust.test.ts`). Three kinds of role are exempt because their services do not send those keys: Lambda execution roles, EC2 instance roles and ECS task execution roles. The eight unused `<prefix>-<agent>-role` roles in OrgIQ-Agents are gone.
- **Callback secrets by name.** Runtimes get `<VAR>_ID` (for example `APPROVALS_REQUEST_SECRET_ID=orgiq-approvals-request-secret`) and permission to read only that secret. The value never enters the template.
- **Cognito.** MFA is optional, authenticator app (TOTP) only. Passwords need a symbol. Refresh tokens last 7 days. There is no admin-password flow and no localhost callback unless `authDev=true`.
- **cdk-nag.** `bin/app.ts` applies AwsSolutions with the suppressions in `nag-suppressions.ts`, and `test/nag.test.ts` fails on any unsuppressed finding. See the cdk-nag section below.

## cdk-nag

cdk-nag 2.38.2 (devDependency) runs AwsSolutions over every stack; `npx cdk synth --quiet -c nag=true` exits 0 for the default app and for the full-app context `test/nag.test.ts` uses. `NAG_NO_SUPPRESS=1` prints every raw finding.

**Fixed in the stacks:** `enforceSSL` on the documents, artifacts and portal buckets (S10) and on both SNS topics (SNS3). Earlier fixes stay unsuppressed: RDS10, COG1, CFR5.

**Suppressed** (`nag-suppressions.ts`; IAM4 and IAM5 are scoped to named constructs, so a new wildcard still fails the synth):

| Rule | Where | Reason |
|---|---|---|
| IAM4 | Lambda roles (custom resources, tool Lambdas, SpanProjector, ParseMetrics, LogRetention, AgentBaseRole); MiddlewareExecutionRole; SfuInstanceRole | AWS-maintained minimum policies (Lambda basic execution, ECS task execution, SSM managed instance). |
| IAM5 | AgentCoreRuntime execution roles, GatewayRole and tool roles, evaluation/memory/sandbox/devbox roles, Aurora deleter, Foundation/KB/Portal bucket roles, AwsCustomResource policies, MiddlewareTask/ExecutionRole, canary and projector roles, Social roles, SfuInstanceRole | Actions with no resource-level permission, or prefix/account-scoped names (`runtime/<prefix>_*`, `table/<prefix>-social-*`, `bucket/*` objects, `index/*`). Named actions are pinned by `test/least-privilege.test.ts`. |
| L1 | all inline Lambdas | python3.12 / nodejs20.x pinned on purpose; runtime upgrades are their own change. |
| SMG4 | every generated secret | No rotation Lambda yet; logins are tied to DB roles by `apply_all_seed.py`. |
| S1, CFR3, ELB2 | Foundation, Portal, MiddlewareService | No log bucket exists and the account custodian strips the bucket-policy grant log delivery needs. |
| RDS6 | Aurora | Data API with Secrets Manager logins only. |
| AEC3, AEC4, AEC5, AEC6 | Social (SocialRedis) | Single private node, no AUTH or TLS: research stack, cost. |
| COG2, COG8 | Authentication | MFA optional by decision; Plus plan is paid. |
| VPC7, CFR2, EC28, EC29, SF2 | Aurora and MiddlewareService VPCs, Portal, SocialMedia, PromptCanary | Flow logs, WAF, detailed monitoring, termination protection, X-Ray: research stack, cost. |
| EC23 | MiddlewareService ALB security group | `addRedirect` opens 0.0.0.0/0:80 for the redirect only; custodian revokes it. Open item: `open: false`. |
| ECS2, CFR1, CFR4, DDB3 | MiddlewareService, Social, Portal, Foundation | Non-secret env vars only; no geo restriction; default CloudFront certificate; PITR only on durable tables. |

Still open: the Devbox role grants `bedrock:InvokeModel` on a foundation-model ARN with a wildcard region; it is suppressed under IAM5 but deserves a look against the AWS-native-models rule.

## microVM runner

The infrastructure half of `docs/microvm-runner-design.md` (§2, §5, §7, §11, §12). It is all behind `-c microvm=true`; without the flag the synth output is unchanged (`test/microvm-stacks.test.ts` checks both).

- **Stacks.** `lib/microvm-network-stack.ts` builds the VPC, the firewalls, the Bedrock endpoint and the private zone. `lib/microvm-runtime-stack.ts` builds the `<prefix>_microvm` runtime, its execution role and the runs bucket. The middleware gains its grants through the `microvmRuntimeArn` prop. The stacks are joined by stable export names, so no hash-named export is frozen.
- **Deploy order.** First `OrgIQ-MicrovmNetwork`. Then `OrgIQ-MicrovmRuntime`, once `agents/devbox/build.sh` has pushed the image the devbox already uses. Last, `OrgIQ-MiddlewareService` with `-c microvm=true`, which imports the runtime ARN, the endpoint ARN and the bucket name. Pass the flag on every later middleware deploy, or the grants and `MICROVM_*` variables are removed.
- **Other context.** `microvmTaskTimeoutSeconds` (default 840) sets `maxLifetime`: the timeout plus 900 s, rounded up to the hour, capped at 8 h. The idle timeout is 300 s. The middleware gets the same number as `MICROVM_MAX_LIFETIME_S` (`MicrovmRuntimeStack.maxLifetime`, a synth-time value, not an import), and the dispatcher holds back any profile whose task plus its 10-minute boot allowance does not fit (`profile-exceeds-runtime-lifetime`). To run a 3,300 s profile, deploy the runtime and the middleware with `-c microvmTaskTimeoutSeconds=3300` (lifetime 7,200 s). `microvmComputeUsdPerSecond` (default `0`) becomes `MICROVM_COMPUTE_USD_PER_SECOND`; set it from the AgentCore price list. The flagged middleware also gets `PROJECT_PREFIX`, which pins the actor's token read to `<prefix>/github-user/`.
- **Egress allowlist.**
  - Network Firewall runs in strict order. It drops TCP to port 80 first. Next it drops TCP to port 443 at any address outside GitHub's published ranges (priority 15, `GithubDestinationRuleGroup`). Only then does it pass TLS whose SNI is `github.com`, `api.github.com`, `codeload.github.com` or `objects.githubusercontent.com`. The default action drops and alerts on every other established flow. SNI alone is what the client claims, so without the address check a run that knew an attacker's IP could send `SNI=github.com` to it and pass (sweep 4 M2).
  - The address list is `lib/github-ip-ranges.ts`: the IPv4 `git`, `web` and `api` ranges from `https://api.github.com/meta`, collapsed (88 CIDRs), with the date they were taken. Synth never fetches. To refresh, run `node scripts/refresh-github-ip-ranges.mjs` from `infra/` (or `--from <saved meta.json>` offline, and `--check` to only report whether GitHub's list moved), then `npm test -s` and redeploy `OrgIQ-MicrovmNetwork`. A stale list fails closed: clones and pushes to a new GitHub address are dropped and appear in the alert log. The Bedrock endpoint and the BFF are reached without crossing the firewall, so the list does not name them; if the BFF is ever reached through the firewall instead of a peering route, this rule drops it.
  - DNS Firewall allows the same four names and answers NXDOMAIN for everything else. It also allows two names that never cross Network Firewall, because blocking them would break Bedrock and the lab loop: `bedrock-runtime.<region>.amazonaws.com` (the endpoint's private DNS) and `lab.<prefix>.internal`.
  - Flow and alert logs go to `/<prefix>/microvm/egress`, kept 30 days.
  - The runtime security group has no inbound rules. Outbound, it allows 443 to the endpoint group, to the ALB group when one is given, and to `0.0.0.0/0`, whose only route is the firewall endpoint.
  - The `bedrock-runtime` endpoint policy allows `InvokeModel*` and `CountTokens` only on the role's model ARNs, and only for principals in this account.
- **What the execution role deliberately lacks.** No `secretsmanager:*`, `rds-data:*`, `bedrock:Retrieve`, `s3:*` or `InvokeAgentRuntime*`. The test pins the Sids to §12's seven, and only EcrAuth, Traces and Metrics may name `*`. One consequence: unlike the devbox, the runtime gets no `LAB_CALLBACK_SECRET_ID`, because it could not read the secret. The lab broker has to receive the fleet secret in the `boot` payload, next to the run token. That change belongs in `agents/devbox/main.py` and the dispatcher.
- **Middleware additions.** These apply only with the prop:
  - `InvokeAgentRuntime` and `StopRuntimeSession` on the runtime and endpoint ARNs.
  - `GetSecretValue` on `<prefix>/github-app*` and `<prefix>/github-user/*`.
  - `s3:PutObject` and `s3:GetObject` on `<runs-bucket>/runs/*`.
  - The runs bucket blocks public access, uses SSE-S3, requires TLS and expires `runs/` after 30 days.
  - The older `AgentCoreInvoke` statement on `runtime/<prefix>_*` still covers the new runtime as well. Replacing it, per §12, is a separate change.
- **cdk-nag.** `npx cdk synth -c nag=true -c microvm=true` exits 0. The new path-scoped suppressions are IAM5 on `MicrovmExecutionRole`, VPC7 on `MicrovmVpc` (the firewall's flow logs cover every egress) and S1 on `RunsBucket`.
- **Unverified without AWS.**
  - Whether AgentCore creates the VPC network interfaces through its service-linked role, or the execution role also needs `ec2:CreateNetworkInterface`, `ec2:DescribeNetworkInterfaces`, `ec2:DeleteNetworkInterface` and related statements. Confirm at the first `cdk deploy`.
  - The ACM certificate for `lab.<prefix>.internal`. It is not requested here. The BFF's HTTPS listener needs one, from a private CA or imported, before `LAB_API_BASE=https://lab.<prefix>.internal` verifies.
  - Whether the BFF is reachable from this VPC at all. The middleware ALB is internet-facing and sits in `MiddlewareVpc`. A security-group reference and a private alias work only across a peering or transit-gateway link, so `bin/app.ts` does not pass the ALB, and the zone has no record until one exists.
  - Whether Network Firewall accepts one log group for both the FLOW and ALERT destinations.
  - That the destination rule (`drop tcp $HOME_NET any -> !$GITHUB_NETS 443`, an IP-set variable of 88 CIDRs) deploys at capacity 10, and that clone, push and the API still work through it. Checked only by the template test.
  - Every route uses the first firewall endpoint. `EndpointIds` is an unordered `az:vpce` list, so the AZ of each entry cannot be picked with intrinsics.

## Row-level security (work item 22)

`schema/row_level_security.sql` turns on RLS for every tenant table and binds `orgiq_app_middleware` to a per-transaction `app.tenant`. The file's header lists the tables, the predicate for each, and the tables left out on purpose.

- **The setting.** The middleware sends `SELECT set_config('app.tenant', :app_tenant, true)` in the same Data API transaction as the statement (`middleware/src/providers/data-api.ts`). The value is the session's active tenant followed by the user's other granted tenants. It is `*` for `admin`, for the access tenant, and for system work outside a request. Unset reads nothing.
- **The flag.** `RLS_ENFORCE` defaults on, whatever `AURORA_SECRET_ARN` names (docs/fail-open-audit.md §2). The master owns the tables, so RLS never applies to it; under `dbMasterSecret` enforcing costs only the extra round trips, and `RLS_ENFORCE=false` is the explicit opt-out. Only statements on a protected table pay the transaction.
- **Cost.** An autocommit statement on a protected table becomes four Data API calls instead of one (begin, set, statement, commit). An explicit transaction gains one call. On a local PostgreSQL 16, pgbench measured 0.058 ms for the statement alone and 0.182 ms for the four-statement form. The Data API's own per-call latency is not measured yet; it needs a live cluster.
- **Rollout.** `python3 schema/apply_all_seed.py --roles-only` now applies it after the two role files. Run that before the middleware moves to its own login. Re-run it after every migration: its assertions fail the apply when a new table carries a tenant column without a policy.
- **Proof.** `schema/test_row_level_security_postgres.py` (opt-in, disposable container) shows that a wrong or unset setting returns zero rows and that a cross-tenant write is refused.

## Migration order for an existing environment

1. **Agent images first.** `agents/_shared/callbacks.py` and the devbox must read the `*_SECRET_ID` variables (see "Change needed in agents/" below). Until those images are deployed, run deploys with `PLAINTEXT_CALLBACK_SECRETS=1 ./scripts/deploy.sh …`. Without it, the callbacks go unsigned and the middleware refuses them.
2. **Deploy OrgIQ-Foundation and OrgIQ-Aurora.** This turns on deletion protection and RETAIN, and mints the three login secrets.
   - The documents emptier and the Aurora deleter stay in the template with a no-op Delete. Do not remove them: a custom resource that leaves a template runs its Delete handler.
3. **Create the logins:** `python3 schema/apply_all_seed.py --roles-only`. It runs as the master secret, applies `service_roles.sql` and `graph_readonly_role.sql`, sets each password from its secret, and asks PostgreSQL to confirm the boundaries.
   - Run it again after every migration. The middleware only sees tables that existed when it last ran (there are no default privileges).
4. **OrgIQ-Agents.** If an OrgIQ-AgentCoreGateway older than the tool manifest is still deployed, it may import the removed `<prefix>-<agent>-role-arn` exports. In that case deploy `OrgIQ-AgentCoreGateway --exclusively` before OrgIQ-Agents. The other exports the roles used are kept for one release with `exportValue` in `bin/app.ts`, and `test/fixtures/export-ledger.json` guards the rest.
5. **The knowledge base.** Moving it to `orgiq_kb_service` changes its storage configuration, which replaces the knowledge base. Four stacks import its id, so CloudFormation refuses the replacement while they do.
   - Deploy with `-c kbMasterSecret=true` until you rebuild it.
   - Then rebuild through the existing recovery path: `-c kbId=<new id>` plus a `knowledge_bases` registry repoint, followed by a re-sync.
   - On a fresh account no flag is needed. The init chain creates the login before Bedrock validates it.
6. **The runtimes and the middleware.** The middleware task restarts on `orgiq_app_middleware`. If step 3 has not run, every query fails to authenticate; the escape is `-c dbMasterSecret=true` for one deploy.
7. **The portal.** `deployPortal` now needs `certificateArn` and `portalAlbOriginHost`. A live portal without a certificate makes `deploy.sh` stop at synth. Add the certificate, or pass `-c allowHttpOrigin=true` knowingly.
8. **Cognito.** Users of the admin-password flow (headless demo logins) and of localhost callbacks need `-c authDev=true`. Existing passwords stay valid; the symbol rule applies to new ones.
9. **Next release: remove the fallbacks.** Delete `dbMasterSecret`, `kbMasterSecret` and `plaintextCallbackSecrets`, the `exportValue` lines marked "one release" in `bin/app.ts`, and the deprecated `agentRoles` / `agentRoleArn` props.

**Tearing down a protected stack:** deploy it with `-c protectData=false` first, which turns deletion protection off and arms the deleter, then destroy. Destroying while protected leaves Aurora, the documents bucket and the user pool in place. The Aurora VPC then ends DELETE_FAILED because its subnets are still in use.

## Change needed in agents/ (not made here; agents/ was out of scope)

- **`agents/_shared/callbacks.py`, `secret_for()`.**
  - When `os.environ[cb.env_var]` is empty and `os.environ.get(cb.env_var + "_ID")` is set, fetch `boto3.client("secretsmanager").get_secret_value(SecretId=<id>)["SecretString"].strip()`.
  - Fetch once per process, cache the result in a module dict, and return `""` (with the existing announce-once log) on any error, so a failure stays unsigned and fails closed.
  - The runtimes already have permission for exactly the secrets they are given.
- **The devbox lab loop.** At session start, before `lab` can run, `agents/devbox/main.py` should do the same for `LAB_CALLBACK_SECRET_ID` and put the value into the `lab` process's environment as `LAB_CALLBACK_SECRET`.
- **`agents/tests/test_readonly_role.py:405`.** It asserts the old source line `resources: [useReadOnlySecret ? readOnlySecretArn! : props.auroraCredentialsSecretArn]`. Replace it with assertions on `resources: [dbSecretArn]` and `login === 'reader' ? readOnlySecretArn`; the behaviour is covered in `infra/test/agentcore-runtime-stack.test.ts`.
- **`agents/_shared/db_credentials.py`.** Its docstring says ingestion, graph-builder and scoring write with the admin credential. Now ingestion reads as the reader and the other two use the graph writer.

## Voice navigator

- **The flag.** `-c voice=true` (default off) is read by `OrgIQ-MiddlewareService`. Without it nothing voice-related is synthesised.
- **The secret.** The stack imports `<prefix>/openai/api-key` by name and never creates it, so no value is ever in a template, a task definition or state. Create it once, before deploying with the flag:
  `aws secretsmanager create-secret --name <prefix>/openai/api-key --secret-string '<key>'`
- **Delivery.** `OPENAI_API_KEY` reaches the middleware task as an ECS secret reference (`ValueFrom` is the ARN). The task role gets `secretsmanager:GetSecretValue` on that one secret and no other voice permission.
- **Never the browser.** Only the middleware reads the key. The browser gets an SDP answer and an opaque session id, never the key or an OpenAI token of its own (spec §6).
- **Settings.** Plain environment from context: `voiceUsdPerMinute` (0.05), `voiceSessionMinutesP75` (10), `voiceSessionMaxMinutes` (30), `voiceModel` (`gpt-live-1`), `voiceVoice` (unset). They become `VOICE_USD_PER_MINUTE`, `VOICE_SESSION_MINUTES_P75`, `VOICE_SESSION_MAX_MINUTES`, `VOICE_LIVE_MODEL`, `VOICE_VOICE`.
- **CSP.** No addition. The mint is proxied by the middleware, so `connect-src` does not need `https://api.openai.com`, and WebRTC media travels over ICE/DTLS, which CSP does not govern. A test asserts the portal's policy never names OpenAI. If the data channel proves to need an HTTPS fallback (spec §6, unverified), pass `-c cspConnectOrigins=https://api.openai.com`.

## Knowledge base: one data source per tenant prefix

- **What changed.** `tenants/kb-prefixes.json` declares each tenant's prefixes of the documents bucket (orgiq: `orgiq/`, `synth/`, `uploads/`, `crawled/`; assessment: `assessment/`). OrgIQ-KnowledgeBase creates one S3 data source per prefix with that prefix as its only inclusion prefix (`DataSource-<tenant>-<prefix>`), in place of the single `S3DataSource` that indexed the whole bucket. A key under no declared prefix is no longer indexed. The middleware (`lib/kb-prefixes.ts`) and the agents (`_shared/kb_resolver.py`) keep literal copies of the map; `test/knowledge-base-data-sources.test.ts` and both sides' tests compare them to the file. A knowledge base takes at most 5 data sources, so the file holds at most 5 prefixes (the loader refuses more).
- **Tenant metadata.** Each indexed document carries a `<key>.metadata.json` sidecar, `{"metadataAttributes": {"tenant": "<owner>"}}`, the owner being the tenant of the longest registered or declared prefix. The middleware's upload, the crawler and the corpus load (`schema/synth/load.py`) write it. Retrieval in the search and advisor agents now sends a Bedrock metadata filter for the caller's verified tenant and still drops any result whose key another tenant owns (belt and braces).
- **Outputs.** `DataSourceId` is now the `orgiq/` data source (the registry's default row sits under it); `SynthDataSourceId` is the one the corpus load syncs; `TenantDataSources` maps every declared prefix to its id. The ingestion agent picks the data source whose inclusion prefix holds the run's prefix when a knowledge base has several.
- **Migration for an environment that already exists.** Deploying replaces the data source: CloudFormation creates the per-prefix data sources and deletes `S3DataSource` together with the vectors it indexed. Then:
  1. Backfill the metadata for documents written before this change: `python3 schema/backfill_kb_tenant_metadata.py --bucket <documents bucket>` prints the plan, `--apply` writes the sidecars. Pass `--prefix TENANT=PREFIX` for each prefix registered in `/admin/knowledge`.
  2. Move any document that sits outside every declared prefix (for example at the bucket root) under one, or it stays unindexed.
  3. Start one ingestion job per data source (`TenantDataSources`), one at a time (one concurrent job per knowledge base). Until a document is re-ingested with its sidecar, the metadata filter does not return it, so retrieval comes back thinner, never wider.
  4. Re-point the registry's default row with the corpus load or `/admin/knowledge` adoption (it reads `DataSourceId`).
- **Not covered.** Knowledge bases created at run time by the registry (`/admin/knowledge`) are separate knowledge bases with their own data source, outside this stack. Presigned landing-zone uploads cannot write a sidecar; the backfill covers them until the landing zone writes one itself.

## Signed-request replay table

- **The weakness.** A signed request carries a fresh nonce, and each verifier remembered spent nonces only in its own process. With more than one middleware replica, or an agent runtime serving one endpoint from several replicas, a captured signed request could be accepted once more per replica inside its 70 second window.
- **The fix.** OrgIQ-Foundation creates `<prefix>-signed-request-replay`: string partition key `nonce_hash`, TTL on `expires_at`, on-demand, default encryption like the other Foundation tables, and DESTROY (its items live for one signature window). Each verifier keeps its in-process cache in front and then claims the nonce with one conditional put; a live item means another replica already accepted it.
- **Two writers, one table.** The middleware (`SERVICE_AUTH_REPLAY_TABLE`, `middleware/src/lib/service-nonce-store.ts`) writes keys prefixed `service-envelope#`; the agents that verify signed invokes (`AGENT_INVOKE_REPLAY_TABLE`, `agents/_shared/replay_store.py`) write a bare SHA-256 digest. Each role gets `dynamodb:PutItem` only, on this table only, with `dynamodb:LeadingKeys` pinning it to its side of the prefix, so neither writer can spend the other's nonces and nobody can read, scan or delete.
- **Fail closed.** With the variable set, any store error (throttling, no permission, a missing table, an unreachable endpoint, a client that cannot be built) refuses the request. Unset keeps the in-process cache alone, which is what local runs use. `*_DYNAMODB_ENDPOINT` points either verifier at a local DynamoDB-compatible store; it is not set in the cloud.
- **Order.** Deploy OrgIQ-Foundation before the runtimes and the middleware: once they carry the variable, a missing table refuses every signed request.
- **Bounded calls.** Both clients use the same limits: 2 s to connect, 5 s to read. The agents' client (`replay_store.client_config`) also makes at most two attempts, so a stalled table refuses the invoke in seconds rather than holding it on the SDK's default 60 s reads and retries.
- **Network path (checked 10 November 2026).** `AGENT_INVOKE_REPLAY_TABLE` is set only by OrgIQ-AgentCoreRuntime, on the five agents that verify signed invokes (supervisor, search, advisor, assessment-scorer, assessment-drafter). Every runtime in that stack runs in `PUBLIC` network mode and reaches DynamoDB the way it reaches Bedrock, S3 and its other AWS services, so no VPC endpoint is needed. The only VPC-mode runtime (the microVM runner) does not get the variable. A synth test (`agentcore-runtime-stack.test.ts`) fails if a runtime that names the table leaves `PUBLIC` mode; moving one into a VPC needs a DynamoDB gateway endpoint in that VPC first.

## Open items

- **SpanProjector and PromptCanary still use the master secret.** They write observability tables and could run as `orgiq_app_middleware` or a new observability role.
- **The middleware holds CREATE on schema `public`.** It needs it only because the KB registry creates per-KB vector tables at run time. Move those tables to their own schema and grant `orgiq_kb_service` on them instead.
- **`ALTER ROLE … PASSWORD` sends the password in clear.** `pg_stat_statements` is preloaded, so the statement may be recorded (§7, unverified). Sending a pre-computed SCRAM verifier would avoid it, if the Data API accepts SCRAM logins.
- **Unconfirmed against a live account:** the AgentCore browser action names (`ConnectBrowserAutomationStream` and the rest) and whether ECS task execution roles accept the source conditions (they are exempt for now).
