# The microVM runner: one session per (user, project), one work item, one pull request

Design for the runner that [project-story.md](project-story.md) §14 and [next-steps.md](next-steps.md) §5 item 2 point at, and that §8 package 15 asks for (workspace wipe between actors, no cross-actor resume, clone target confined, no skipped permissions, the lab token out of the agent's reach, content never logged). Written 7 November 2026 from the code named below; nothing here is built.

Tags: **fact** = read in this repository (file named), **fact (AWS)** / **fact (Claude Code)** / **fact (GitHub)** = platform behaviour from the vendor's documentation, to confirm against the pinned versions at build time; **decision** = a choice this design makes.

## 1. What exists today

- A tenth AgentCore runtime, `orgiq_devbox`, runs Claude Code behind `agents/devbox/main.py`: `claude -p` with `--dangerously-skip-permissions`, `--continue` when the payload says `resume`, HOME pointed at the managed session-storage mount `/mnt/workspace` so the tree and `~/.claude` survive stop/resume, LAB_* variables put in the `claude` child's environment, the prompt's first 120 characters logged. `networkMode: 'PUBLIC'`, idle 1 h, max 8 h, storage wiped on every image deploy and after 14 idle days, session ids at least 33 characters. **fact** (`agents/devbox/main.py`, `infra/lib/devbox-stack.ts`)
- Boxes are a fleet, reused across jobs and across users; the dispatcher claims any idle box for the queue head, so one actor's `resume` can continue another actor's conversation and files. **fact** (`lib/job-dispatcher.ts` tick, next-steps §8 High)
- Credentialed git already runs as a separate invoke payload (`op: clone|push`), the token handed to the git child as an `http.extraheader` through `GIT_CONFIG_*`, never argv, config or disk; tokens come from `lib/repo-token-provider.ts` (GitHub App installation tokens: one repository, named permissions, one hour, an audit row in `credential_issues` per mint, no PAT fallback once the app is configured). The clone op `rm -rf`s whatever absolute target the payload names; `SAFE_REF` allows a leading dash. **fact** (`lib/devbox-git.ts`, `lib/repo-token-provider.ts`, `lib/github-app-token.ts`, `main.py` `_run_git`)
- Delivery pushes a branch `orgiq/change-<id>` as `OrgIQ Agent <agent@orgiq.local>` and opens the PR with the connection's stored token, so the PR author is the connection, not the person; it never merges. **fact** (`lib/change-delivery.ts`, `lib/github-connector.ts` `openPullRequest`)
- Money: `reserveSpend` is the one chokepoint, called between `claimNextJob` and `markRunning` with a p75 forecast for the model; the hold expires at `STALE_MINUTES` + 5 min grace; a refusal unclaims without burning an attempt; the run meter cuts at the ceiling and a backstop stops the session 30 s later; cost settles as reported / estimated / unknown, never 0. **fact** (`lib/spend-holds.ts`, `lib/job-dispatcher.ts`, `lib/devbox-runner.ts`, `lib/run-cost.ts`)
- The brief is assembled once per `run_ref`, frozen write-once, 6,000 tokens, and records the skill library's sha; the box receives it through the managed `SessionStart` hook `lab brief`, which first syncs every published runbook into `~/.claude/skills` as a Claude Code skill, verified by sha. The run token (HMAC under the session signing key, header `x-lab-run-token`) binds the box to its run; the fleet secret `LAB_CALLBACK_SECRET` only proves "some box". `LAB_API_BASE` has never been set in a deployed session because the middleware ALB is not public. **fact** (`lib/run-brief.ts`, `lib/runbooks/brief.ts`, `lib/runbooks/library.ts`, `agents/devbox/lab`, `managed-settings.json`, `lib/run-token.ts`, `devbox-stack.ts` `labApiBase`)
- `devbox_profiles.network_class` already has the value `egress-allowlist`, with nothing behind it: network class is deploy-time per runtime. **fact** (`schema/devbox_profiles_schema.sql`, `lib/devbox-profile.ts`)
- The budget the owner wants is "agent time plus compute time". **fact** (project-story §14)

## 2. The shape of the runner

- **decision** Stay on AgentCore Runtime, which already gives an isolated microVM per session **fact (AWS)**; do not self-host Firecracker. A second runtime, `orgiq_microvm`, is deployed from the same image in VPC mode. Whether AgentCore is Firecracker underneath is not this design's concern.
- **decision** One runtime session per (actor, agent project, job attempt). The session id is derived, not chosen: `mvm1-<sha256(tenant:sub)[:16]>-<agent_project_id[:12]>-<job_id[:12]>-<attempt>` (≥33 chars). Two actors can never share a session by construction; the same actor's next job on the same project gets a fresh microVM. "Per (user, project)" is the ownership and billing key, not a long-lived VM.
- **decision** No managed session storage on `orgiq_microvm`. The workspace is the container's ephemeral filesystem; nothing survives the session on purpose. Durable state leaves by git (the branch) and by one transcript object (§9). This also removes the wipe-on-deploy and 1 GB caveats.
- **decision** The session runs exactly one work item: boot → wipe → clone → skills → `claude -p` under the allowlist → snapshot commit → push → PR → report → stop. A second job is a second session.
- **decision** Claude never holds a credential that leaves the VM: no git token, no run token, no fleet secret in its environment. Pushing and PR creation are the runner's and the BFF's steps, after `claude` has exited.
- **decision** The fleet path (`orgiq_devbox`, Computer Lab, PTY) stays for interactive use; queue jobs move to the microVM path by profile (§14).

## 3. Sequence

```mermaid
sequenceDiagram
  autonumber
  participant D as Dispatcher (BFF)
  participant H as Holds + ledger
  participant T as Token service (BFF)
  participant AC as AgentCore
  participant VM as main.py (microVM)
  participant C as claude -p
  participant GH as GitHub
  D->>D: claimNextJob; preflight (§10)
  D->>H: reserveSpend(p75 model + compute forecast)
  H-->>D: held (holdId) | refusal → unclaim
  D->>D: freezeBrief(job) → brief sha, run token
  D->>T: mint read token (contents:read, 1 repo) → credential_issues
  D->>AC: InvokeAgentRuntime(session mvm1-…, {op: boot, repo, target, token, library sha, brief ref})
  AC->>VM: start microVM (VPC, allowlist)
  VM->>VM: wipe workspace, start lab broker on unix socket (holds run token + fleet secret)
  VM->>GH: git clone (token in git child env only)
  VM->>D: GET /api/runs/:ref/skills + /brief via broker (internal ALB)
  VM-->>D: boot_end {head sha, library sha ok}
  D->>AC: InvokeAgentRuntime(same session, {op: task, budget, model, timeout})
  VM->>C: spawn claude -p (managed settings allowlist, no tokens in env)
  C->>C: SessionStart: lab brief (sha check only)
  C->>AC: Bedrock InvokeModel via VPC endpoint (execution role)
  C-->>VM: stream-json events (usage, tools, result)
  VM-->>D: events teed to the run log; meter observes; cutoff → process-group kill
  C->>C: SessionEnd: lab keep / lab applied
  VM->>VM: snapshot commit (author = actor's GitHub identity), transcript → presigned S3 PUT
  VM-->>D: devbox_end {exit, fresh tokens, head sha, session_id}
  D->>T: mint write token (contents:write, 1 repo)
  D->>AC: InvokeAgentRuntime(same session, {op: push, branch orgiq/<sub8>/<job8>, token})
  VM->>GH: git push --force-with-lease
  D->>GH: open PR with the actor's user-to-server token (BFF only)
  D->>H: recordSpend(real tokens + compute seconds) → hold settled
  D->>AC: StopRuntimeSession(mvm1-…)
  D->>D: completeJob → awaiting_review {prUrl, branch, headSha}
```

## 4. Workspace isolation and wipe

- **fact** Today one `/mnt/workspace` is shared by whoever the dispatcher hands the box to. **decision** The microVM has no shared mount and the session id carries the actor, so cross-actor leakage is structurally impossible; the explicit `wipe` step (`find $WORKSPACE -mindepth 1 -delete`, then recreate `~/.claude`) remains as defence against a reused container and is also added to the fleet path (`op: wipe`) for package 15.
- **decision** `main.py` computes `WORKSPACE_ROOT = realpath(workspace)` once and refuses any `target` whose `realpath` is not strictly under it before any `rmtree` or `git` call; `buildGitOpPayload` applies the same check against `/mnt/workspace`. `SAFE_REF` becomes `^[A-Za-z0-9][\w./-]{0,199}$` and `git checkout -B -- <branch>` is used.
- **decision** `--continue` is removed from `_build_cmd`. Resume is §9's explicit, actor-checked mechanism.
- **decision** `resume` and `boxId` in a `devbox:task` payload are refused by `enqueueJob` for `runner = 'microvm'`.

## 5. Egress allowlist, and where it is enforced

- **decision** A `MicrovmNetworkStack`: a VPC with two private subnets for the runtime, two firewall subnets, one NAT gateway in a public subnet; AWS Network Firewall in strict order with a stateful rule group that allows TLS SNI only for `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com` and drops everything else, port 80 included; Route 53 Resolver DNS Firewall with the same domain list so a name that is not allowed never resolves; firewall flow and alert logs to `/orgiq/microvm/egress`.
- **decision** Bedrock never leaves the VPC: an interface endpoint for `bedrock-runtime` with private DNS, and the runtime security group's egress to it on 443 only. The endpoint policy restricts `bedrock:InvokeModel*` to the same model ARNs as the role (§12), so a stolen role credential used from elsewhere still meets the role policy, and a credential used from inside meets both.
- **decision** The BFF callback is the internal ALB **fact** (non-public by default). A Route 53 private hosted zone name `lab.orgiq.internal` with an ACM certificate, the runtime SG allowed into the ALB SG on 443, `LAB_API_BASE=https://lab.orgiq.internal`. This is what finally turns the lab loop on in a deployed session.
- **decision** `CfnRuntime` for `orgiq_microvm` uses `networkConfiguration: { networkMode: 'VPC', networkModeConfig: { subnets, securityGroups } }` **fact (AWS)**. The runtime security group has no inbound rules and three egress rules: the endpoint SG (443), the ALB SG (443), and `0.0.0.0/0:443` whose only route is through the firewall. Whether the ENIs are managed by the AgentCore service-linked role or need statements on the execution role is unverified; confirm at `cdk deploy`.
- **decision** `devbox_profiles.network_class = 'egress-allowlist'` is now meaningful: the dispatcher resolves it to the `orgiq_microvm` runtime ARN; `'public'` resolves to `orgiq_devbox`. A profile may not combine `egress-allowlist` with `org_access = 'read'` (there is no Aurora or KB path in the allowlist).

## 6. The budget hold and settlement

- **fact** The hold is taken between claim and `markRunning`, before any side effect. **decision** Unchanged in order; the forecast gains a compute term: `p75 wall-clock seconds for (repo, model) × vCPU/GB rate` (AgentCore meters active session time per vCPU-second and GB-second **fact (AWS)**; the rate is a config value `MICROVM_COMPUTE_USD_PER_SECOND`). `source` is `'microvm'`; `source_id` stays `${job.id}:${attempts}` so the ledger entry settles the hold as today.
- **decision** Settlement on `devbox_end`: token cost as today (reported, else estimated from `usage`, else unknown) plus `compute_seconds = stop − boot` priced at the rate and written beside it; the ledger entry carries both and the hold closes. A run that never sends `devbox_end` settles `unknown` (not 0) when the backstop stops it, and the hold expires at `STALE_MINUTES + grace`. **fact** for the unknown-never-zero rule.
- **decision** The meter's token ceiling rides the task payload as `budget.max_fresh_tokens` exactly as now **fact**; the compute ceiling is the task timeout (§7), so a stuck run cannot out-spend its hold on either axis.
- **decision** Boot and clone time are charged to the job, not absorbed: the microVM is billing from `boot`, and the owner asked for compute in the budget.

## 7. Session lifetime, idle timeout, cleanup

- **decision** Runtime `lifecycleConfiguration`: `idleRuntimeSessionTimeout 300`, `maxLifetime = profile.task_timeout_s + 900` rounded up to the next hour, within AgentCore's 8 h **fact**. A job session is never idle on purpose; five minutes covers the gap between `boot_end` and `task`, and between `devbox_end` and `push`.
- **decision** The dispatcher stops the session itself after the PR step (or after a failed step), through `stopDevboxSession` **fact**; the reaper's `task-overrun` **fact** and the cutoff backstop **fact** are the second and third lines. A `microvm_sessions` row that is still `running` with `started_at` older than `task_timeout_s + grace` is swept by the reaper and recorded `stop_reason = 'overrun'`.
- **decision** Cleanup is the stop. There is no workspace to delete and no transient fleet box to keep: the dispatcher registers a transient `FleetBox` with `ownerId = actor` for the duration so the existing tail UI works **fact** (`registerBox`), and removes it on stop.

## 8. Which process holds which secret

| Secret | Minted by | Lives in | Reaches | Never reaches |
|---|---|---|---|---|
| Bedrock credentials (execution role) | AgentCore | container env | `claude` (it must call Bedrock) | outside the VPC endpoint (§5) |
| Repo read token (1 h, `contents:read`) | BFF, `mintAuditedRepoToken` **fact** | `boot` payload → git child env **fact** | `git clone` | `claude`, logs, disk |
| Repo write token (1 h, `contents:write`, `pull_requests:write`) | BFF, after `devbox_end` | `push` payload → git child env | `git push` | `claude` (already exited) |
| Run token (`x-lab-run-token`) **fact** | BFF, `labRunContext` **fact** | `boot` payload → the lab broker's memory | the broker | `claude` env, `lab` argv |
| Fleet secret `LAB_CALLBACK_SECRET` | deploy | runtime env → broker | the broker | `claude` env (`_subprocess_env` strips it) |
| Transcript presigned PUT URL (15 min) | BFF | `task` payload → main.py | main.py's upload | `claude` |
| Actor's GitHub user token | GitHub OAuth, stored in Secrets Manager `orgiq/github-user/<sub>` | BFF process only | `openPullRequest` | any microVM |

- **decision** The lab broker: `main.py` starts an asyncio HTTP server on `/run/orgiq/lab.sock` (mode 0600, owned by uid 1000) that signs the service envelope and adds `x-lab-run-token`; `lab` talks to `LAB_API_BASE=http+unix:///run/orgiq/lab.sock`. Claude keeps exactly the authority it had (its own run's lab routes) and loses the token bytes. `_subprocess_env` for the `claude` child pops `LAB_RUN_TOKEN`, `LAB_CALLBACK_SECRET`, `GIT_CONFIG_*` and `AWS_*` other than region; a test pins the list.

## 9. Resume, safely

- **fact** Today `resume` means `claude --continue` in a shared mount. **decision** Resume is a new job with `resume_of_job_id`, accepted only when the dispatcher finds: the same `actor_sub`, the same agent project, the original in `failed | awaiting_review | cancelled` within `MICROVM_RESUME_WINDOW_H` (default 72), and a `microvm_sessions` row for it with `branch` and `transcript_s3_key` set.
- **decision** State is reconstituted, never shared: `boot` clones the repository and checks out the original's branch (`orgiq/<sub8>/<job8>`, pushed at exit even when the run failed, as long as there was a commit), downloads the transcript from a presigned GET into `~/.claude/projects/<cwd-slug>/<session_uuid>.jsonl`, and `task` runs `claude -p --resume <session_uuid>` **fact (Claude Code)** (the `result` event's `session_id` **fact** is what was recorded). The brief is the original's frozen brief (same `run_ref` family), so "what was this run told" stays answerable.
- **decision** A resume takes its own hold and its own session; the new PR step updates the existing PR (same head branch) rather than opening a second one **fact** (`openPullRequest` handles 422).

## 10. What the dispatcher checks before placing a job

In order; the first failure sets `held_back` with that reason, unclaims and leaves the attempt un-burned (**fact** for the unclaim shape):

1. `job.runner = 'microvm'` and `kind = 'devbox:task'`; payload has no `resume`, no `boxId`.
2. `actor_sub` is set (from the session at enqueue, never the body), the user exists, is in the tenant, and is a member or owner of the initiative (Cedar/project rule, as `FleetBox.projectId` visibility uses today **fact**).
3. The initiative's `devbox_profiles` row resolves, names the requested model (else 400 at enqueue **fact**), and has `network_class = 'egress-allowlist'` → runtime ARN resolves.
4. `agent_projects` row exists for the repo, `repo_full_name` matches `REPO_FULL_NAME_RE` **fact**, has a connection or the GitHub App is installed on the owner.
5. The actor has a live `github_user_grants` row (else reason `no-github-identity`; the portal offers the OAuth link). Push can proceed without it; the PR cannot, so the job is held rather than half-delivered.
6. Kill switches and run limits (`fleetPaused`, `saturatedInitiatives`, slots) **fact**.
7. `reserveSpend` → `held`.
8. `freezeBrief` succeeds and the skill library loads with a sha. **decision** A microVM run never starts without a frozen brief (today a failed freeze still runs **fact**).
9. For `resume_of_job_id`: §9's conditions.
10. Concurrency: at most `MICROVM_MAX_SESSIONS_PER_ACTOR` (default 2) live sessions for the actor and the global `run_limits` **fact**.

## 11. Observability

- Logged, structured, per session: job id, attempt, session id, `actor_sub`, tenant, initiative, repo, head sha before and after, model, profile (id, version), brief sha, library sha, each `credential_issues` id, each step's start/end and exit code, tool names and the clipped target field (as `ActivityEntry` does today **fact**), fresh tokens, cost (reported/estimated/unknown), compute seconds, branch, PR url, stop reason, Network Firewall denials (domain, count) joined by session id through the ENI/flow log.
- Never logged: the prompt or brief text (`main.py` logs `len` and `sha256` instead of `prompt[:120]`; next-steps §8 Low), any token or presigned URL, file contents or diffs, environment dumps, the user's GitHub token, the transcript (it goes to S3 under the run prefix with the bucket's default encryption, 30-day expiry, readable by the BFF role only).
- Metrics through `emitFleetMetric` **fact**: `microvm-boot-seconds`, `microvm-run-cutoff`, `microvm-egress-denied`, `microvm-held-back{reason}`, `microvm-pr-opened`.

## 12. IAM for the `orgiq_microvm` execution role (and the two BFF additions)

Trust: `bedrock-agentcore.amazonaws.com` with `aws:SourceAccount = <account>` and `aws:SourceArn = arn:aws:bedrock-agentcore:<region>:<account>:runtime/*` (next-steps §7 Low). Statements, each on named resources:

| Sid | Actions | Resources |
|---|---|---|
| BedrockInvokeClaude | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, `bedrock:CountTokens` | the profile's inference-profile ARNs + foundation-model ARNs (`bedrockModelArns` **fact**) |
| EcrPull | `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` | the `orgiq-devbox` repository ARN |
| EcrAuth | `ecr:GetAuthorizationToken` | `*` (the API has no resource) |
| Logs | `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` | `arn:aws:logs:<r>:<a>:log-group:/aws/bedrock-agentcore/runtimes/orgiq_microvm*` |
| Traces | `xray:PutTraceSegments`, `xray:PutTelemetryRecords` | `*` (no resource type) |
| Metrics | `cloudwatch:PutMetricData` | `*` with `cloudwatch:namespace = bedrock-agentcore` |
| Workload | `bedrock-agentcore:GetWorkloadAccessToken` | the runtime's workload identity ARN |

Deliberately absent: `secretsmanager:*`, `rds-data:*`, `bedrock:Retrieve`, `s3:*` (the transcript goes through a presigned URL, so the role needs nothing), `bedrock-agentcore:InvokeAgentRuntime*`. **decision** The existing `BedrockInvokeClaude` statement is kept verbatim; everything else is narrower than `orgiq_devbox` today **fact**.

BFF task role additions: `bedrock-agentcore:InvokeAgentRuntime` and `bedrock-agentcore:StopRuntimeSession` on the `orgiq_microvm` runtime and endpoint ARNs (replacing `GetAgentRuntime` on `*`, next-steps §7); `secretsmanager:GetSecretValue` on `orgiq/github-app*` and `orgiq/github-user/*`; `s3:PutObject`, `s3:GetObject` on `arn:aws:s3:::<runs-bucket>/runs/*` for presigning.

## 13. Data model changes

New tables:

- `microvm_sessions` (`session_id TEXT PK`, `job_id TEXT NOT NULL REFERENCES agent_jobs`, `attempt INT NOT NULL`, `actor_sub TEXT NOT NULL`, `tenant TEXT NOT NULL`, `agent_project_id UUID REFERENCES agent_projects`, `initiative_id TEXT REFERENCES projects`, `runtime_arn TEXT`, `profile_id TEXT`, `profile_version INT`, `network_class TEXT`, `status TEXT CHECK IN ('booting','cloning','ready','running','pushing','reporting','stopped','failed')`, `hold_id UUID REFERENCES spend_holds`, `brief_sha TEXT`, `library_sha TEXT`, `claude_session_id TEXT`, `base_sha TEXT`, `head_sha TEXT`, `branch TEXT`, `pr_url TEXT`, `transcript_s3_key TEXT`, `exit_code INT`, `fresh_tokens BIGINT`, `cost_usd NUMERIC(10,4)`, `cost_basis TEXT`, `compute_seconds INT`, `compute_usd NUMERIC(10,4)`, `stop_reason TEXT`, `booted_at`, `started_at`, `ended_at`, `stopped_at TIMESTAMPTZ`), unique on (`job_id`, `attempt`).
- `github_user_grants` (`user_sub TEXT PK`, `tenant TEXT NOT NULL`, `github_login TEXT NOT NULL`, `github_user_id BIGINT NOT NULL`, `noreply_email TEXT NOT NULL`, `secret_arn TEXT NOT NULL`, `scopes TEXT[]`, `granted_at TIMESTAMPTZ`, `refreshed_at TIMESTAMPTZ`, `revoked_at TIMESTAMPTZ`). The token itself is only in Secrets Manager.

Columns added:

- `agent_jobs`: `runner TEXT NOT NULL DEFAULT 'fleet' CHECK IN ('fleet','microvm','local')`, `actor_sub TEXT`, `resume_of_job_id TEXT REFERENCES agent_jobs (id)`. (`created_by` stays as the display attribution **fact**; `actor_sub` is the authority.)
- `spend_holds.source` CHECK gains `'microvm'`; `spend_entries` gains `compute_seconds INT`, `compute_usd NUMERIC(10,4)`, `session_id TEXT`.
- `credential_issues`: `session_id TEXT`, `kind TEXT CHECK IN ('repo-install','repo-user','run-token','presign')`.
- `devbox_profiles`: no new column; `network_class` gains meaning (§5). Seed a `restricted` profile (`egress-allowlist`, `org_access none`, models Haiku + Sonnet).
- `agent_project_runs`: `session_id` already exists **fact**; add `runner TEXT`.

## 14. Migration from today's fleet boxes

1. **Package 15 first, on the fleet path, no new runtime**: `op: wipe` and a wipe before every dispatched job whose `actor` differs from the box's last; `resume` refused across actors; `realpath` confinement in `main.py` and `buildGitOpPayload`; `SAFE_REF` tightened; `prompt` logging replaced by length + sha. Ships with the next image.
2. **The allowlist replaces skipped permissions in the shared image**: `managed-settings.json` gains `permissions.allow` (`Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash(git status|diff|log|add|commit|checkout|switch|stash*)`, `Bash(npm test*)`, `Bash(npm run lint*)`, `Bash(lab *)`, the per-repo test runners) and `permissions.deny` (`Bash(git push*)`, `Bash(curl*)`, `Bash(wget*)`, `Bash(ssh*)`, `Bash(aws*)`, `WebFetch`, `WebSearch`, `Read(./.env*)`, `Read(~/.aws/**)`); `--dangerously-skip-permissions` is dropped. Managed settings cannot be widened by a repository's `.claude/settings.json`, deny wins over allow, and in `-p` mode a call no rule allows is refused and reported to the model rather than waiting on a prompt **fact (Claude Code)**, confirm against the pinned CLI. Pin `@anthropic-ai/claude-code` and the base image digest (next-steps §7 Low).
3. **Deploy `orgiq_microvm`** (VPC stack, firewall, endpoint, internal ALB name) beside `orgiq_devbox`; `restricted` profile; one initiative pointed at it; `job.runner` set from the profile at enqueue.
4. **Dispatcher routes by `runner`**: `'microvm'` jobs take the §3 path (no box claim); `'fleet'` jobs keep today's path. The GitHub OAuth link page ships here so actors can grant their identity.
5. **Default profile → `egress-allowlist`** once a week of microVM runs settles cleanly; fleet boxes remain for interactive PTY use only; `resume` and `boxId` leave the `devbox:task` payload contract; `change-delivery.ts`'s legacy shell push path is deleted with `DEVBOX_GIT_ENTRYPOINT`.

## 15. Tests that prove isolation (one line each)

- Two jobs from different actors on one project derive different session ids, and `wipe` leaves `find $WORKSPACE -mindepth 1` empty before the clone (`test_main.py`).
- A job with `resume_of_job_id` owned by another actor is held back with `resume-cross-actor` before `reserveSpend` is called (dispatcher test with a fake hold).
- A clone target of `/etc` or `/mnt/workspace/../etc` raises in both `main.py` and `buildGitOpPayload` before any delete.
- The `claude` child's environment has none of `LAB_RUN_TOKEN`, `LAB_CALLBACK_SECRET`, `GIT_CONFIG_*`, while the git child's has the extraheader (env snapshot assertions).
- The lab broker refuses a request whose path is not under `/api/runs/<this run>/` or `/api/lab/`.
- A `Bash(curl …)` tool call under the managed settings is denied in `-p` mode and the run completes with the denial in the transcript.
- From inside a VPC-mode session, `curl https://example.com` fails and appears in the firewall log; `git ls-remote https://github.com/<repo>` succeeds; one `InvokeModel` succeeds through the endpoint (deploy validator).
- A dispatcher tick whose `reserveSpend` returns anything but `held` never calls `InvokeAgentRuntime` (fake client records zero calls).
- `devbox_end` with `fresh_tokens` yields one `spend_entries` row with `source_id = <job>:<attempt>`, `compute_seconds > 0`, and the hold `settled`; a session with no `result` settles `unknown`, never 0.
- After the PR step, `StopRuntimeSession` is called with that session id; a session that never sends `devbox_end` is stopped by the backstop within grace.
- The PR is created with the actor's user token and the push with the installation token; the recorded invoke payloads never contain the user token.
- Every mint in a run writes a `credential_issues` row with `run_ref = job id` and `session_id`; the count equals read + write + run-token + presign.
- `main.py`'s log output for a run contains the prompt's length and sha and not any 40-character substring of the prompt.
- A skill library whose sha differs from the brief's is refused by `lab skills` and the run fails at `boot` with `library-mismatch`, before `claude` starts.
- A repository `.claude/settings.json` that allows `Bash(git push*)` does not override the managed deny (settings precedence test against the pinned CLI).

## 16. Built (7 November 2026)

The runner was built in three lanes. Nothing has run against AWS: every lane is proven with unit tests and fakes only.

### What landed

- **Infra (0c53f09d).** `OrgIQ-MicrovmNetwork` and `OrgIQ-MicrovmRuntime` behind `-c microvm=true`. The network stack has the VPC, Network Firewall (strict order, port 80 dropped, TLS SNI allowlist for the four GitHub names), DNS Firewall, the `bedrock-runtime` endpoint and the `lab.<prefix>.internal` zone. The runtime stack has `<prefix>_microvm` (VPC mode, idle 300 s, maxLifetime from the task timeout), the §12 execution role, and the runs bucket (30-day `runs/` expiry). The middleware gets invoke/stop, the GitHub secrets and the `runs/*` object grants, and `MICROVM_RUNTIME_ARN`, `MICROVM_RUNS_BUCKET` and `MICROVM_COMPUTE_USD_PER_SECOND`. See `infra/SECURITY-NOTES.md`, "microVM runner".
- **Box (a689ef40, a29632fc).** `agents/devbox/main.py` handles `runner: "microvm"` with three ops. `boot` wipes the workspace, confines the target by realpath, clones with the read token, starts the lab broker on a 0600 unix socket and checks the library sha. `task` runs `claude -p` with no `--continue` and with `--resume` only for an explicit id, then makes a snapshot commit as the actor, PUTs the transcript and sends one `devbox_end`. `push` pushes `orgiq/*` with an explicit lease. The broker takes the fleet secret from the `boot` payload, because the role cannot read Secrets Manager. The `claude` child keeps the role's credential-provider variables and loses static keys, lab secrets and `GIT_CONFIG_*`. `--dangerously-skip-permissions` is gone: `managed-settings.json` carries the allow/deny lists.
- **Dispatcher (this lane, `middleware/` and `schema/`).**
  - Schema. `schema/microvm_sessions.sql` creates the session table and adds `agent_jobs.runner/actor_sub/resume_of_job_id`, `spend_entries.compute_seconds/compute_usd/session_id` and `agent_project_runs.runner`. `schema/github_user_grants.sql` creates the grant table. `spend_holds.source` and `spend_entries.source` gain `microvm`. `credential_issues` gains `session_id` and `kind`, and its provider list gains `github-user`, `lab` and `s3`. A `restricted` profile is seeded (egress-allowlist, org access none, Haiku and Sonnet). Both new tables are in `schema/manifest.json`, in `row_level_security.sql` and in the middleware's tenant-table pattern. `microvm_sessions` also has a `task_timeout_s` column, which the reaper needs.
  - Enqueue. `lib/microvm-enqueue.ts` sets the runner from the initiative's profile for every `enqueueJob`. It reads the profile store strictly, so a store outage fails the enqueue instead of falling back to the public fleet. A microvm payload with `resume` or `boxId` is a 400, and so is `resumeOfJobId` on fleet work. `POST /api/work/jobs` and the promote route pass `actorSub` from the session. On a cluster without the runner column, microvm work is refused at enqueue.
  - Claims. The fleet claims (`claimNextJob`, `claimJob`) never take a microvm row. `claimNextMicrovmJob` takes nothing else. The fleet tick, its restart recovery and the fleet reaper all skip the runner's `mvm:` boxes.
  - Dispatch. `lib/microvm-dispatcher.ts` runs on its own tick, started by `startJobDispatcher`. It does the §10 checks, each failure held back with a named reason, then the §3 sequence. It records one `credential_issues` row per credential: read token, write token, run token, each presigned URL, and the user-token read. It updates the `microvm_sessions` row at every status and keeps a transient `FleetBox` owned by the actor for the tail. Transport and presigning are in `lib/microvm-invoke.ts`. The presigned PUT lasts 15 minutes and signs `content-type: application/x-ndjson`.
  - Settlement. Token cost comes from `devbox_end`: reported, else estimated from `usage`, else unknown. Compute is `stopped − booted` times the rate. `cost_usd` is tokens plus compute when the token cost is known. When it is unknown, `cost_usd` stays null and `compute_seconds/compute_usd` are still written.
  - Reaper. The leader sweeps for sessions past `task_timeout_s + grace` and stops them as `overrun` (`ReaperDeps.microvmSweep`).
  - Metrics. `microvm-boot-seconds`, `microvm-run-cutoff`, `microvm-held-back{reason}` and `microvm-pr-opened`.
  - PRs. `openPullRequestWithToken` opens the PR with a token the caller holds, with the same 422 handling as before.
- **Gap fixes (all three lanes, proven with fakes only).**
  - Push lease. `push` takes `expected_head` (40 hex, or null for "the branch must not exist"). The dispatcher writes `microvm_sessions.head_sha` only after a confirmed push and sends it as the lease on the job's next attempt; a resume leases on its boot head. A failed lease is still `push-rejected`.
  - Library sha. `/api/runs/:ref/skills` serves the library the run's brief froze, rebuilt from the recorded skill versions (`lib/runbooks/library.ts` `skillLibraryForRun`), or the current one when nothing moved. It falls back to the current library only when the frozen set can no longer be rebuilt, and then `boot` still fails with `library-mismatch`. No new store was needed and the dispatcher does not re-freeze.
  - Hold TTL. A microvm hold and its meter last `task_timeout_s` + 10 min boot allowance + `HOLD_GRACE_MS`, never less than the old `STALE_MINUTES + 5 min` (`microvmHoldExpiresInMs`). A 3,300 s profile gets 70 minutes.
  - Runtime ARN from SSM. With `MICROVM_RUNTIME_ARN` or `MICROVM_RUNS_BUCKET` unset, start-up reads `/<prefix>/microvm/runtime-arn`, `endpoint-arn` and `runs-bucket` once and caches them (`loadMicrovmParameters`); the env always wins, and with neither the job still waits as `no-microvm-runtime`. The middleware task role gets `ssm:GetParameter` on `/<prefix>/microvm/*` (`MicrovmParameters`, flagged deploys only).
  - `lab_api_base`. Infra sets `MICROVM_LAB_API_BASE` on the middleware from the same `microvmLabApiBase(prefix)` that sets the runtime's `LAB_API_BASE`. The dispatcher logs once at start-up which source each value came from.
  - `agent_project_runs.runner`. Each session writes one `agent_project_runs` row at boot (session id, runner `microvm`, the job's agent project) through `startRun`, finished with the token cost only, because the forecast adds compute itself.
  - Workspace root. `boot` returns `workspace_root`, and a `bad-target` refusal says it too. The dispatcher uses the reported root for later boots on that runtime and retries a `bad-target` boot once on the same session. `MICROVM_WORKSPACE_ROOT` is only the pre-boot default.

### Decisions this lane made

- **Check order.** §10's order holds, except that the resume checks (item 9) and the per-actor session cap (item 10) run before `reserveSpend` (item 7). A cross-actor resume, or an actor at the cap, then holds no money (§15). Three config gates run before item 1, each its own held-back reason: `no-microvm-runtime`, `no-microvm-runs-bucket` and `no-lab-callback-secret`.
- **Order of the last steps.** The session is stopped before the ledger row is written, so `compute_seconds` covers the whole session. §3 draws the two steps the other way round.
- **Failed runs.** A failed run that left a commit still pushes its branch, so a resume has something to start from, but opens no PR. A cut run pushes nothing.
- **Bot jobs.** A job owned by a bot run is held back as `bot-owned-job`. The bot run holds its own money and has no person to act as.

### To turn it on

1. Deploy `-c microvm=true` in the order `infra/SECURITY-NOTES.md` gives: network, then runtime, then middleware. Pass `-c microvmComputeUsdPerSecond=<rate>` from the AgentCore price list, or compute is priced at 0.
2. Apply `schema/microvm_sessions.sql`, `schema/github_user_grants.sql` and the re-applied `spend_holds`, `spend_ledger`, `credential_issues` and `devbox_profiles` files. Then run `python3 schema/apply_all_seed.py --roles-only` so the middleware login and RLS cover the new tables.
3. Point an initiative at `restricted` (`PUT /api/projects/:id` with `devboxProfileId: 'restricted'`). That initiative needs exactly one agent project, and the GitHub App has to be configured or the project has to name a connection.
4. Give each actor a GitHub user grant: a `github_user_grants` row, plus the token in Secrets Manager under `orgiq/github-user/<sub>`, either bare or as JSON with `access_token`. Until the OAuth link page lands, someone has to write both by hand. Without a grant, the job waits as `no-github-identity`.

### Unverified without AWS

- **Infra** (from `infra/SECURITY-NOTES.md`):
  - Whether AgentCore makes the VPC network interfaces through its service-linked role, or the execution role needs the EC2 statements too.
  - The ACM certificate for `lab.<prefix>.internal`.
  - Whether the internet-facing middleware ALB in `MiddlewareVpc` can be reached from the runner VPC at all. Until it can, the zone has no record and the lab loop cannot work.
  - Whether one log group can take both the firewall's FLOW and ALERT logs.
  - Every route uses the first firewall endpoint.
- **Box:**
  - That the managed `permissions.allow/deny` hold in `-p` mode against the pinned CLI, and that a repository's `.claude/settings.json` cannot widen them.
  - That `claude -p --resume <uuid>` resumes from a transcript placed at `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`.
  - That Bedrock credentials reach `claude` through the container credential provider.
  - The egress allowlist from inside a session (the §15 deploy validator).
- **Dispatcher:**
  - The real `InvokeAgentRuntime` response framing for a dict-returning op. The reader takes a whole JSON body or the last SSE `data:` object.
  - That `StopRuntimeSession` on a VPC-mode session ends billing at the stop.
  - The S3 presigned PUT signed with `content-type` and `UNSIGNED-PAYLOAD`. It is built with SigV4 and checked only by shape.
  - The run-token and envelope path from the broker through `lab.<prefix>.internal` to `/api/runs/:ref/skills` and `/brief`.
  - The new SQL statements against a real PostgreSQL. They have only been checked with stubbed `exec`, including the `to_jsonb(agent_jobs)` runner guard, which works on clusters without the column.

### Gaps against what the other lanes ship

- **No `cloning` status.** `boot` does the clone inside one op and reports nothing in between, so the dispatcher never writes `cloning`.
- **No `microvm-egress-denied` metric.** It needs the firewall alert log joined to a session id through the ENI, and nothing does that join yet.
- **Bot and marketplace work on a `restricted` initiative does not run.** It is enqueued as microvm and then held back (`bot-owned-job`), or refused by `claimJob`.
- **A deploy without `-c microvm=true` cannot use the SSM fallback.** The parameter read works, but invoke/stop and the `MicrovmParameters` grant come only with the flag, so the fallback helps local runs against a deployed runtime, not an unflagged middleware.
- **The first boot on a new runtime can still guess the root wrong.** It costs one refused boot and one retry on the same session. Nothing persists the learned root across middleware restarts.
