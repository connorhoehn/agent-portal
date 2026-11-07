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
- **cdk-nag.** `bin/app.ts` applies AwsSolutions with the suppressions in `nag-suppressions.ts`, and `test/nag.test.ts` fails on any unsuppressed finding.

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

## Open items

- **cdk-nag is not installed.** `npm install -D cdk-nag@^2` turns `test/nag.test.ts` on. The suppression list has not been checked against a real run yet; expect to add or delete entries and to narrow IAM5 to `appliesTo`.
- **SpanProjector and PromptCanary still use the master secret.** They write observability tables and could run as `orgiq_app_middleware` or a new observability role.
- **The middleware holds CREATE on schema `public`.** It needs it only because the KB registry creates per-KB vector tables at run time. Move those tables to their own schema and grant `orgiq_kb_service` on them instead.
- **`ALTER ROLE … PASSWORD` sends the password in clear.** `pg_stat_statements` is preloaded, so the statement may be recorded (§7, unverified). Sending a pre-computed SCRAM verifier would avoid it, if the Data API accepts SCRAM logins.
- **Unconfirmed against a live account:** the AgentCore browser action names (`ConnectBrowserAutomationStream` and the rest) and whether ECS task execution roles accept the source conditions (they are exempt for now).
