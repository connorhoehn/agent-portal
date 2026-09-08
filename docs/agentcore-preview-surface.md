# AgentCore preview surface — what's new, what fits OrgIQ

Research pass, no code changes. Triggered by the AWS post
[*It's safe to close your laptop now: hosting coding agents on Amazon Bedrock AgentCore*](https://aws.amazon.com/blogs/machine-learning/its-safe-to-close-your-laptop-now-hosting-coding-agents-on-amazon-bedrock-agentcore/),
which showcases a set of AgentCore Runtime features this repo doesn't use yet.

Scope: identify every preview/new capability in that post, verify the real API
shape against AWS docs and the SDK type definitions, and map each one onto OrgIQ
with a recommended build order.

**Status: design doc. Nothing here is implemented.**

---

## 1. How these claims were verified

The blog post is a marketing artifact and its snippets are abridged. Every claim
below was checked against a primary source:

| Source | Used for |
|---|---|
| `infra/node_modules/aws-cdk-lib/aws-bedrockagentcore/lib/bedrockagentcore.generated.d.ts` (2.253.1, installed) | What the repo can build **today** |
| `aws-cdk-lib@2.265.0` (fetched via `npm pack`) | What a CDK bump would unlock |
| [CFN `FilesystemConfiguration` reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-bedrockagentcore-runtime-filesystemconfiguration.html) | Authoritative CloudFormation property set |
| [File system configurations for AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html) | Mount rules, IAM, VPC prerequisites, lifecycle |
| [Quotas for Amazon Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html) | Every numeric limit quoted below |
| [`InvokeAgentRuntimeCommand` API reference](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntimeCommand.html) | Exact request/response shape |
| botocore `develop` service model, plus a live `get_service_model` probe against the installed boto3 | Which operations actually exist in the Python SDK |

Where the blog and a primary source disagree, the primary source wins and the
discrepancy is called out.

---

## 2. Current state of the repo

All nine runtimes are built in `infra/lib/agentcore-runtime-stack.ts:329` with
only four fields set:

```ts
new bedrockagentcore.CfnRuntime(this, `${pascal}Runtime`, {
  agentRuntimeName: safeRuntimeName,
  roleArn: executionRole.roleArn,
  agentRuntimeArtifact: { containerConfiguration: { containerUri: ... } },
  networkConfiguration: { networkMode: 'PUBLIC' },
  protocolConfiguration: 'HTTP',
  environmentVariables: { ... },
});
```

Every knob discussed in this document is unset. Relevant context:

- **Region**: `us-east-1` (`infra/bin/app.ts:28`). Session storage is supported there.
- **Container user**: `bedrock_agentcore`, UID 1000 (`agents/base/Dockerfile`). Matters for BYO mounts.
- **VPCs already exist** but not for agents: `aurora-stack.ts:41` and `middleware-service-stack.ts:100`. Agents are `PUBLIC`.
- **Session IDs already thread through** — the supervisor forwards `runtimeSessionId` to sub-agents (`agents/supervisor/main.py`, `_invoke_sub_agent`), and the middleware forwards `payload.sessionId` (`middleware/src/providers/agentcore.ts:585`).

### Stale line in CLAUDE.md

`CLAUDE.md` states **"Max image size: 1 GB"** under the Dockerfile requirements.
The current quota is **2 GB** for a container image in an AgentCore Runtime.
Worth correcting whenever we next touch that file.

---

## 3. Toolchain availability matrix

The single most useful output of this research: what's reachable **today** vs.
what needs an upgrade.

| Capability | CDK 2.253.1 (installed) | CDK 2.265.0 | boto3 1.42.92 (system) | boto3 1.43.34 (`.venv-schema`) |
|---|---|---|---|---|
| `sessionStorage` mount | ✅ | ✅ | n/a | n/a |
| `lifecycleConfiguration` | ✅ | ✅ | n/a | n/a |
| `requestHeaderConfiguration` | ✅ | ✅ | n/a | n/a |
| VPC network mode | ✅ | ✅ | n/a | n/a |
| `s3FilesAccessPoint` mount | ❌ | ✅ | n/a | n/a |
| `efsAccessPoint` mount | ❌ | ✅ | n/a | n/a |
| `InvokeAgentRuntimeCommand` | n/a | n/a | ✅ | ✅ |
| `InvokeHarness` | n/a | n/a | ❌ | ✅ |

Verified empirically for the boto3 columns:

```
boto3 1.42.92  InvokeAgentRuntime ✓  InvokeAgentRuntimeCommand ✓  StopRuntimeSession ✓  InvokeHarness ✗
boto3 1.43.34  InvokeAgentRuntime ✓  InvokeAgentRuntimeCommand ✓  StopRuntimeSession ✓  InvokeHarness ✓
```

**Takeaway**: `CfnRuntime`'s *top-level* props are byte-identical between 2.253.1
and 2.265.0. The only Runtime-facing delta is two extra fields inside
`FilesystemConfigurationProperty`. Session storage, lifecycle, header allowlist,
and VPC mode all ship on the CDK already in `infra/node_modules`.

---

## 4. Feature-by-feature

### 4.1 Managed session storage (Preview) — *recommended first*

A service-managed persistent directory, mounted per session, that survives
stop/resume of the microVM. No VPC, no extra IAM.

```ts
filesystemConfigurations: [
  { sessionStorage: { mountPath: '/mnt/workspace' } },
],
```

**Limits** (all non-adjustable):

| Limit | Value |
|---|---|
| Max storage size | 1 GB per session |
| Max filesystem metadata | ~50 MB (~100,000–200,000 files) |
| Max directory depth | 200 levels |
| Max filename length | 255 bytes |
| Max symlink target | 4,095 bytes |
| Max sessionStorage configs per runtime | 1 |

**Mount path rules** — must be under `/mnt/` with exactly one subdirectory
level, pattern `/mnt/[a-zA-Z0-9._-]+/?`, length 6–200 chars, unique across
configs, and no config's path may be a subdirectory of another's.

**Unsupported**: hard links, device files/FIFOs/sockets (`mknod`), extended
attributes, `fallocate`, and file locks across stop/resume. Symlinks, `chmod`,
`chown`, `stat`, `git`, `npm`, `pip` all work. Note that permissions are
*stored but not enforced* — access checks always succeed, since the agent is the
only user in the microVM.

#### ⚠️ The gotcha that matters most for this repo

> **On runtime version update: data wiped — fresh file system on next invoke.**

`resolveContainerUri()` (`infra/lib/agentcore-runtime-stack.ts:14-36`) pins the
container to an ECR **digest** specifically so that CloudFormation sees a diff
and rolls the runtime on every image push. That's a deliberate, good design for
deploys — but it means **every `agents/build-all.sh` + deploy cycle wipes all
session storage for that agent.**

This is fine for scratch space. It is *not* fine for anything treated as a
durable store. Any design that leans on session storage must treat it as a cache
that can vanish on deploy, or use a BYO mount instead (§4.2), which is unaffected
by version updates.

Second lifecycle rule: data resets after **14 days** without an invocation on
that session ID.

#### Fit for OrgIQ — `ingestion` + `graph-builder`

These two are the right first target. Both do multi-step work with real
intermediate artifacts that currently have nowhere to live between tool calls:

- **`ingestion`** — staged/normalized document batches, chunking intermediates, partial embedding batches. Today these are re-derived or round-tripped through S3.
- **`graph-builder`** — partial merge sets and dedup state across `merge_*` tool calls within one build.

Both are invoked with a `runtimeSessionId` already threaded from the supervisor,
so the plumbing exists.

Deliberately **not** recommending it for the other six: `search`, `scoring`,
`advisor`, and the two assessment agents are largely read-through-and-respond,
and `supervisor`'s multi-turn state is already handled by AgentCore Memory + the
AG-UI session work in `47f0a99`.

**Open question to settle during implementation**: the docs state the mount is
*"available only at the time of agent invocation, not during initialization."*
Agent code must not touch `/mnt/workspace` at module import time — only inside
the request handler. Both target agents need an audit for this.

---

### 4.2 Bring-your-own file systems — S3 Files / EFS

Attach your own access point, shared across sessions and agents, customer-managed
persistence. Needs **CDK ≥ 2.265.0**.

```ts
filesystemConfigurations: [
  { s3FilesAccessPoint: { accessPointArn: '...', mountPath: '/mnt/datasets' } },
  { efsAccessPoint:     { accessPointArn: '...', mountPath: '/mnt/tools' } },
],
```

**Prerequisites — this is the expensive part.** Unlike session storage, BYO
mounts are not a one-line change:

1. **`networkMode: 'VPC'` is mandatory.** All nine runtimes are currently `PUBLIC`. Moving them into a VPC is a real change with knock-on effects — the agents call Bedrock, Aurora Data API, S3, DynamoDB, and OpenSearch, so we'd need NAT or a full set of interface endpoints. This is the dominant cost of adopting BYO mounts.
2. **Same account and same VPC.** Cross-account is not supported.
3. **AZ alignment.** Runtime subnets must overlap the file system's mount target AZs. Required for S3 Files, recommended for EFS.
4. **Security groups.** Outbound TCP 2049 from the runtime SG, inbound 2049 on the mount target SG.
5. **POSIX UID/GID on the access point must match the container user** — `1000:1000` here, per `agents/base/Dockerfile`.
6. **IAM on the execution role**, with an `AccessPointArn` condition:
   - S3 Files: `s3files:ClientMount`, `s3files:ClientWrite`, `s3files:GetAccessPoint`
   - EFS: `elasticfilesystem:ClientMount`, `elasticfilesystem:ClientWrite`

**Limits**: 5 total filesystem configs per runtime; max 2 S3 Files, max 2 EFS,
max 1 session storage.

**Failure mode**: a failed mount returns **HTTP 424**. Each mount has a 30-second
timeout, all mounts happen in parallel, and *a single failure fails the entire
invocation*. That's a meaningful new availability dependency for all nine agents.

#### Fit for OrgIQ

Genuinely useful, but none of it is urgent:

- **S3 Files at `/mnt/documents`** — the natural one. `ingestion` currently reads the documents bucket via `s3:GetObject` (`agentcore-runtime-stack.ts:268`). A mount would let it use ordinary file I/O while the bucket stays readable by the existing synth pipeline and KB ingestion. Nice, not necessary.
- **EFS at `/mnt/shared`** — shared cache across agents. No current demand.

**Recommendation: defer.** The VPC migration is the real work, and it should be
justified by a security requirement (private networking for agents) rather than
by convenience of file access. Revisit as its own project.

---

### 4.3 Lifecycle configuration — *cheapest win available*

```ts
lifecycleConfiguration: {
  idleRuntimeSessionTimeout: 900,   // seconds; service default 15 min
  maxLifetime: 28800,               // seconds; service default/max 8 hours
},
```

Two integers, already supported by the installed CDK, no prerequisites at all.

**Fit for OrgIQ**: directly relevant to the cost posture this repo already cares
about (budget alarm, `idle.sh`, the Aurora 0.5-ACU note in CLAUDE.md). Lowering
`idleRuntimeSessionTimeout` on the six non-interactive agents releases session
workloads sooner. It also pairs with session storage — a shorter idle timeout
means more stop/resume cycles, which is exactly the case session storage is
designed to make cheap.

Worth setting explicitly even where we keep the default value, simply so the
number is visible in source rather than implicit.

---

### 4.4 `InvokeAgentRuntimeCommand`

Run a one-shot shell command inside a live runtime session, streaming
stdout/stderr back. Bypasses the LLM entirely — deterministic operations only.

```
POST /runtimes/{agentRuntimeArn}/commands?qualifier={qualifier}
X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: {runtimeSessionId}

{ "command": "ls -la /mnt/workspace", "timeout": 300 }
```

Response is a stream of chunks:

```
chunk.contentStart {}
chunk.contentDelta { "stdout": "...", "stderr": "..." }
chunk.contentStop  { "exitCode": 0, "status": "..." }
```

**Constraints**: command 1 byte–64 KB · timeout 1–3600s (default 300) · response
up to 100 MB · streaming chunk up to 64 KB · **`runtimeSessionId` minimum length
33 characters**. IAM action: `bedrock-agentcore:InvokeAgentRuntimeCommand`.
Shares the 1,000 TPS data-plane budget with `InvokeAgentRuntime`.

> ⚠️ **The 33-character session-ID minimum is a real trap.** The middleware
> forwards whatever `payload.sessionId` it's given
> (`middleware/src/providers/agentcore.ts:585`) with no length validation. A
> bare UUID is 36 chars and passes; anything shorter — a slug, a numeric ID —
> would be rejected. Needs an audit of session-ID generation before we build on
> this.

**Fit for OrgIQ**: a genuine operator capability for the Admin/Observability
tenant. The portal already has 21 observability pages and an
`invocations`/`traces` surface; a "session shell" panel that runs read-only
commands against a live runtime session would slot in naturally and would pair
well with session storage (inspect `/mnt/workspace` without redeploying).

Treat as **read-only and heavily gated**: this executes arbitrary shell in the
agent container. It belongs behind the existing Cedar/role machinery, not on a
general-purpose page.

---

### 4.5 Interactive shell (`agentcore exec --it`) — *not reachable from Python*

The blog's headline demo. Worth being precise about, because it's the one thing
here that we **cannot** build on directly.

The quotas doc confirms a real API named `InvokeAgentRuntimeCommandShell`
(max connection 1 hour · max frame payload 64 KB · **10 concurrent shell
sessions per runtime** · 256 KB reconnection buffer). But an enumeration of the
botocore `develop` service model for `bedrock-agentcore` returns **66
operations, and neither `InvokeAgentRuntimeCommandShell` nor
`InvokeAgentRuntimeWithWebSocketStream` is among them** — consistent with
botocore not supporting bidirectional streaming operations in Python.

So the interactive shell is reachable only via the `@aws/agentcore` CLI
(currently `0.27.0`; **not installed on this machine** — `which agentcore` finds
nothing, despite CLAUDE.md listing it as a global install).

**Fit for OrgIQ: none for now.** A browser-based PTY would mean bridging a
bidirectional stream the Python SDK can't speak. `InvokeAgentRuntimeCommand`
(§4.4) delivers most of the operator value at a fraction of the cost. Revisit if
botocore ever adds the operation.

---

### 4.6 The CDK 2.265.0 delta — ten new resources

Not from the blog, but discovered while checking whether the bump was needed, and
more consequential than the blog's contents. `aws-cdk-lib` 2.265.0 adds ten
AgentCore L1 resources absent at 2.253.1:

`CfnHarness` · `CfnDataset` · `CfnConfigurationBundle` · `CfnTokenVault` ·
`CfnResourcePolicy` · `CfnBrowser` · `CfnCodeInterpreter` · `CfnPaymentManager` ·
`CfnPaymentConnector` · `CfnPaymentCredentialProvider`

Three are worth attention:

**`CfnHarness`** — a declaratively-defined agent. `model`, `systemPrompt`,
`tools`, `allowedTools`, `skills`, `memory`, `maxIterations`, `maxTokens`,
`timeoutSeconds`, `truncation`, plus `environment` / `environmentArtifact`. The
model config is multi-provider (`bedrockModelConfig`, `openAiModelConfig`,
`geminiModelConfig`, `liteLlmModelConfig`) and skills load from git, S3, a path,
or AWS-managed sources. It has its own data-plane operation, `InvokeHarness`
(present in boto3 1.43.34, absent in 1.42.92), and per the quotas doc each
harness is backed by a managed Runtime that AWS provisions for you.

This is a direct alternative to the repo's container-per-agent pattern: no
Dockerfile, no ECR, no `build-all.sh`, no ARM64 cross-build. It is architecturally
significant enough to deserve its own evaluation rather than a footnote.

> ⚠️ **Naming collision.** This repo already has an unrelated *evaluation*
> harness — `middleware/src/routes/harness.ts` (50 KB) and
> `infra/scripts/harness.py` (55 KB). Anything built on `CfnHarness` needs a
> distinct name from day one (`agentHarness`? `managedAgent`?) or the codebase
> becomes very confusing very quickly.

**`CfnDataset`** — versioned schema plus examples, inline or from a JSONL file in
S3. Plausibly relevant to `OrgIQ-AgentCoreTelemetry`'s evaluators and to the
calibration/quality pages.

**`CfnConfigurationBundle`** — git-like versioning (`branchName`, `commitMessage`,
`createdBy`) over a map of component configurations. Overlaps conceptually with
what `prompt-canary-stack.ts` and the prompt-version routes do by hand.

The quotas doc also reveals adjacent services with no CDK resource yet — Batch
Evaluation, AB Testing, Recommendations, Agent Registry — several of which
overlap the repo's hand-rolled canary/drift/calibration surfaces. Out of scope
here, but worth knowing they exist before building more of that by hand.

---

## 5. Recommended build order

Sequenced by value-per-unit-risk. Each phase is independently shippable.

### Phase 1 — Runtime knobs, no CDK bump *(recommended next step)*

Touches one file: `infra/lib/agentcore-runtime-stack.ts`.

1. Add `lifecycleConfiguration` to all nine runtimes, tuned per agent (§4.3).
2. Add `sessionStorage: { mountPath: '/mnt/workspace' }` to `ingestion` and `graph-builder` only (§4.1), behind a per-agent flag so others can opt in later.
3. Audit both agents for init-time access to the mount path — the mount only exists at invocation time.
4. Document the wipe-on-deploy interaction (§4.1) in CLAUDE.md's Gotchas section, next to the existing runtime notes.

No new IAM, no VPC, no dependency changes. Reversible.

### Phase 2 — Operator shell surface

5. Add `bedrock-agentcore:InvokeAgentRuntimeCommand` to the execution roles.
6. Audit session-ID generation for the 33-character minimum before anything depends on it (§4.4).
7. Middleware route wrapping `InvokeAgentRuntimeCommand` with a command allowlist; portal panel under Observability, gated by role.

Value depends on Phase 1 landing first — inspecting `/mnt/workspace` is the main
thing you'd want a shell for.

### Phase 3 — CDK bump to 2.265.0

8. Upgrade `aws-cdk-lib` and `aws-cdk`, then `npx cdk synth` all 17 stacks and diff the templates. **The bump is the deliverable** — no behavior change intended.

Unblocks Phases 4–5. Best done as an isolated commit so a regression is easy to
bisect.

### Phase 4 — `CfnHarness` spike *(time-boxed)*

9. Stand up one throwaway harness-based agent alongside the existing nine and compare: cold start, cost, tool fidelity vs. the Strands `@tool` definitions, OpenInference span quality (does `agents/_shared/instrumentation.py` still get its root AGENT span?), and guardrail attachment.

The instrumentation question is the crux. This repo's observability story depends
on code that runs *inside* the container; a managed harness may not admit it.
Answer that before considering any migration.

### Phase 5 — VPC + BYO filesystems *(defer)*

10. Only if private networking becomes a requirement. The VPC migration is the real cost; the mounts are a small addition once agents are in a VPC (§4.2).

---

## 6. Open questions

Things I could not settle from documentation and that need a live deploy or a
decision:

1. **Session-storage ownership.** Docs say permissions are "stored but not enforced" and one third-party write-up observed files owned by `root`. Our container runs as UID 1000. Almost certainly fine given non-enforcement, but it should be confirmed on first deploy rather than assumed.
2. **Does session storage survive a `CfnRuntimeEndpoint` update**, or only a `CfnRuntime` version change? Docs say "agent runtime version is updated." The blast radius of our digest-pinning depends on the answer.
3. **Do `ingestion` / `graph-builder` receive stable session IDs** on their real invocation paths, or only when called through the supervisor? Direct invocation via `/invoke` may not thread one, in which case session storage buys those calls nothing.
4. **Is `agentcore` CLI meant to be installed here?** CLAUDE.md documents it as a global npm install and `agentcore dev` as the local dev loop, but it isn't present. Either the doc or the machine is out of date.
5. **CLAUDE.md image-size limit** — says 1 GB, quota is 2 GB (§2).

## 6a. Machine-callback auth secrets — operator runbook

Three middleware routes are agent-facing callbacks with no session
(`POST /api/observability/approvals/request`, `POST /api/observability/harness/trace`,
`POST /api/assessment/runs/:runId/complete` — see `middleware/src/routes/{approvals,harness,assessment}.ts`).
Each guard (`requireServiceAuth` / `requireTraceAuth` / `requireRunCompleteAuth`)
is **open** when its env var (`APPROVALS_REQUEST_SECRET` / `HARNESS_TRACE_SECRET`
/ `ASSESSMENT_RUN_COMPLETE_SECRET`) is unset and does a constant-time header
check (`x-approvals-auth` / `x-harness-auth` / `x-assessment-run-auth`) when set.
In the deployed stack these vars were never set, so all three callbacks were
open on the internet-facing ALB.

`OrgIQ-MiddlewareService` (`infra/lib/middleware-service-stack.ts`) now mints
three separate Secrets Manager secrets (`orgiq-approvals-request-secret`,
`orgiq-harness-trace-secret`, `orgiq-assessment-run-complete-secret`) and
injects them as ECS container secrets (`ecs.Secret.fromSecretsManager`, same
mechanism as `COGNITO_CLIENT_SECRET`) — the values never appear in the task
definition's plaintext `Environment` block, only under `Secrets`, resolved by
the execution role at container start. Three secrets rather than one JSON
blob: CDK's `generateSecretString` only auto-generates one field per Secret
resource, and independent secrets let an operator rotate one leaked
credential without touching the other two.

**The agent half has now shipped** (`agents/_shared/callbacks.py`, wired into
`instrumentation.py::post_trace` and `approval_tool.py::request_approval`).
Every callback reads its secret from the runtime's own environment and sends
the matching header **only when that variable is set**; unset sends no header,
which is byte-for-byte the pre-existing request. So the two halves are
independent — a runtime carrying the secret works against an open middleware
(the header is ignored) and a runtime without it works against an open one —
and the *only* thing that forces an ordering is that the secret value does
not exist until `OrgIQ-MiddlewareService` mints it.

The third callback (`/runs/:runId/complete`) still has no in-repo driver; per
its own route comment it is hit out of band by a deployed or `agentcore dev`-run
scorer. `callbacks.post_run_complete()` is the canonical header-aware client
for it — whatever ends up driving assessment runs should call that rather than
hand-rolling a POST, or it will be the one thing left behind by this rollout.

**Why the runtime side can't just import the ARN.** `AgentCoreRuntimeStack`
is instantiated before `MiddlewareServiceStack` in `infra/bin/app.ts` with no
dependency edge between them, so an `Fn.importValue` there would reference an
export that doesn't exist on `OrgIQ-AgentCoreRuntime`'s own first deploy.
Separately, `AWS::BedrockAgentCore::Runtime.EnvironmentVariables` is a bare
string map — unlike ECS, this resource type has no `Secret`/
`fromSecretsManager`-equivalent that resolves a value at container start.
Getting a Secrets Manager value into it at all means a raw CloudFormation
dynamic reference resolved before the `CreateAgentRuntime` call, which would
still land in the runtime's plaintext environment (visible via
`DescribeAgentRuntime`) — defeating the purpose, on top of being unconfirmed
for this preview-era resource type. Rather than invent that mechanism,
`AgentCoreRuntimeStack` takes the three values as plain CDK context strings
(`approvalsRequestSecret` / `harnessTraceSecret` / `assessmentRunCompleteSecret`,
wired through `infra/bin/app.ts`) that the operator copies in by hand.

**Important: there is no staged "mint but stay open" mode.** The container
secrets are wired unconditionally, so the moment `OrgIQ-MiddlewareService`'s
new task definition rolls out, all three guards go from open to required —
in the same deploy that creates the secrets. There is still no way to learn
the generated secret *value* before that deploy runs (Secrets Manager picks
it), so a window between "middleware requires the header" and "the fleet
carries it" remains. What the agent half changes is that the window no longer
needs an image build inside it, and nothing in it is unsafe.

Required order:

1. **Roll the agent images first, with no secret context.** The header-capable
   code (`agents/_shared/callbacks.py`) has to be *inside* the running
   containers before any env var can matter. Build and push
   (`agents/base/build.sh`, then `agents/build-all.sh` — local ARM64 buildx),
   then `./scripts/deploy.sh OrgIQ-AgentCoreRuntime --context deployRuntimes=true`
   with **none** of the three secret contexts set. This is behaviourally a
   no-op — no env var, no header, identical requests — so it can be done days
   ahead, on its own change window. It is also the slow step (image build +
   push + a full runtime version roll, which per the digest-pinning gotcha
   wipes `/mnt/workspace`); getting it out of the way is the point.
2. Deploy `OrgIQ-MiddlewareService`. The moment its new tasks are live, all
   three callbacks require the header — this starts the window.
3. Read each value:
   `aws secretsmanager get-secret-value --secret-id orgiq-approvals-request-secret --query SecretString --output text`
   (repeat for `orgiq-harness-trace-secret` and `orgiq-assessment-run-complete-secret`).
4. Redeploy `OrgIQ-AgentCoreRuntime --context deployRuntimes=true --context approvalsRequestSecret=<value> --context harnessTraceSecret=<value> --context assessmentRunCompleteSecret=<value>`. No rebuild — the images from step 1 already contain the code; this only changes `EnvironmentVariables`. It still rolls every runtime to a new version (and wipes `/mnt/workspace` again).

Skipping step 1 does not just lengthen the window, it makes it unbounded: a
runtime running a pre-`callbacks.py` image sends no header no matter what
env you hand it in step 4.

**What the window between steps 2 and 4 actually costs**, per callback:

- **Traces — no data loss.** `post_trace` emits the `ORGIQ_TRACE:` stdout line
  *before* it POSTs, so CloudWatch → the middleware's log poller delivers the
  same bundle regardless; only the low-latency HTTP path is down. A 401 is
  logged at ERROR naming `HARNESS_TRACE_SECRET`, and is deliberately **not**
  retried without the header (it could not succeed, and a silent downgrade
  would hide the ordering mistake).
- **Approvals — a real outage, failing safe.** There is no second path, so
  `request_approval` returns `{"status": "ERROR"}` with a note naming
  `APPROVALS_REQUEST_SECRET`. No approval row is created and the agent never
  reads a rejected request as a decision, so a gated action is blocked, not
  auto-approved. Time step 2→4 tightly if anything is mid-workflow.
  (Separate, pre-existing: only `POST /approvals/request` is a machine
  callback. The tool's long-poll of `GET /approvals/:id` goes through
  `requireTenant('orgiq') + requireAction('ViewObservability')`, which a
  cookie-less agent can only pass in dev open-mode — so the HITL loop cannot
  complete against a session-enforcing deployment regardless of these secrets.
  Middleware-side; not addressed here.)
- **Run-complete — nothing in-repo is affected.** An out-of-band caller using
  `callbacks.post_run_complete()` gets `ok: false` with the same actionable
  note; its run stays `running` and holds a `RUN_CONCURRENCY_CAP` slot until
  it is re-reported or `/stop`ped.

**Rollback** is the reverse and is safe in either order: unset the middleware
secrets (guards reopen) and/or redeploy the runtimes without the contexts (no
header sent). A runtime holding a stale secret against a reopened middleware
is also fine — an open guard ignores the header entirely.

**Rotation** is one secret at a time (that is why they are three resources):
put the new value in Secrets Manager, redeploy `OrgIQ-MiddlewareService`, then
redeploy the runtimes with the new context value. The same window applies, with
the same per-callback costs.

**A fourth credential: `HARNESS_RUNNER_SECRET`, the harness runner's own
identity.** `infra/scripts/harness.py` now sends `x-harness-auth` on the trace
POST — but the trace POST is one of *seven* middleware calls it makes, and the
other six (`POST /api/observability/prompt-versions`, `POST|GET
/api/observability/harness/runs`, `GET|PATCH .../runs/{id}`, `POST
.../runs/{id}/results`, `POST .../harness/promote`) are session-gated: tenant
scope plus a Cedar action. The runner carries no cookie, so it reached them only
through the middleware's **dev demo-user fallback**, which `demoFallbackAllowed()`
turns off the moment Cognito is configured. Against the deployment this runbook
describes, the runner therefore worked *asymmetrically*: the trace POST
succeeded and the result POST that records the verdict 401'd.

The runner now presents `x-harness-runner-auth` (`HARNESS_RUNNER_SECRET`) on
every middleware call. The middleware half is `serviceAuthOr(
HARNESS_RUNNER_SERVICE_AUTH, …)` in `routes/harness.ts`, `routes/
prompt-versions.ts` and that router's `index.ts` mount — the *dual-caller* guard
shape, not the open-when-unset one, because the portal reads and writes these
same routes with a real session. Consequences worth stating plainly:

* **Nothing changes until the secret exists.** `serviceAuthOr` never opens on an
  unset secret, so with `HARNESS_RUNNER_SECRET` unconfigured every one of these
  routes is byte-for-byte the gate it was, for humans and for the runner alike.
* **No image roll, no window.** Unlike the three callbacks above, this one has no
  agent-runtime half. The credential is read from the shell that runs
  `harness.py`, so steps 1–4 of the ordering above do not apply to it.
* **Minted.** `OrgIQ-MiddlewareService` now mints four secrets:
  `orgiq-harness-runner-secret` sits beside the other three
  (`HarnessRunnerSecret` in `infra/lib/middleware-service-stack.ts`), is granted
  to the task role, is wired into the container as `HARNESS_RUNNER_SECRET`, and
  is exported as `orgiq-harness-runner-secret-arn`. A runner without it still
  fails loudly and with the fix named: `runner_auth_hint()` distinguishes "unset
  in this shell" from "does not match the middleware's / the middleware has none
  wired".

**What a deployer does for the fourth secret** — and, more usefully, what they
*don't*:

```bash
cd infra && ./scripts/deploy.sh OrgIQ-MiddlewareService --context deployMiddlewareService=true
export HARNESS_RUNNER_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id orgiq-harness-runner-secret --query SecretString --output text)
python infra/scripts/harness.py run --middleware https://<alb-or-cf-origin>
```

That is the whole procedure. None of steps 1–4 of the ordering above apply:

| Step of the coordinated dance | Applies to the fourth secret? |
|---|---|
| Patch `agents/_shared/*` to send the header, rebuild + push images | **No.** Nothing in `agents/` reads `HARNESS_RUNNER_SECRET`; the only client is `infra/scripts/harness.py`, run by a human. |
| Redeploy `OrgIQ-AgentCoreRuntime` with the value hand-copied as `--context` | **No.** No `CfnRuntime` needs it, so the `EnvironmentVariables`-is-a-bare-string-map limitation never comes up. |
| Accept a blackout window between the two stacks | **No.** The guard is `serviceAuthOr`, not `requireServiceAuth`: a request with no header (or a wrong one) falls through to the same tenant + Cedar gate it ran before. Wiring the secret only *adds* a way in, so there is no interval in which anything that worked stops working. The portal is unaffected in both directions. |
| Rotation is a two-stack, two-window operation | **No.** Rotate the secret, redeploy `OrgIQ-MiddlewareService`, re-export in the operator's shell. One stack, and only the runner notices. |

What *does* still apply is the ordering *within* the middleware stack: the
secret exists only after `OrgIQ-MiddlewareService` deploys, and the ECS task
picks it up on its next task start — so a runner that exports the value before
the new task is running will 401 until the rollout finishes, which
`runner_auth_hint()` reports as "does not match the middleware's / the
middleware has none wired".

Diagnosing a 401 after all this: each runtime logs once per process, at INFO,
whether it is sending service auth for each callback (`callbacks: POST … →
sending service auth / no service auth`), and the failure messages distinguish
"variable unset in this runtime" from "value does not match the middleware's" —
so CloudWatch answers which half is stale without guessing.

## 7. Explicitly out of scope

- Payment resources (`CfnPaymentManager` / `CfnPaymentConnector` / `CfnPaymentCredentialProvider`) — no OrgIQ use case.
- `CfnTokenVault`, `CfnResourcePolicy`, `CfnBrowser`, `CfnCodeInterpreter` — the repo already provisions Browser and Code Interpreter via `CfnBrowserCustom` / `CfnCodeInterpreterCustom`; the new resources need a separate look to determine whether they replace or complement those.
- Batch Evaluation, AB Testing, Recommendations, Agent Registry — no CDK L1 yet.
- Direct code deployment (ZIP instead of container) — a separate packaging decision from anything discussed here.
