# DE-49 Workspace persistence that survives a runtime version update

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Related: DE-2 (digest-pinned rollout), DE-45 (credentials out of shell strings,
which the re-clone path reuses), DE-48 (lifetimes).

## Current state (read from the code, 2026-10-27)

The backlog line is correct. What it leaves out is that nothing detects the
wipe, so the platform keeps using workspaces that are empty.

- **Storage and its lifecycle.** The devbox runtime mounts managed session
  storage at `/mnt/workspace` (`infra/lib/devbox-stack.ts:224-229`). It
  survives stop/resume on the same `runtimeSessionId`, is wiped on every
  runtime version update, expires after 14 idle days and is capped at 1 GB
  (`devbox-stack.ts:66-69`, `agents/devbox/main.py:17-26`).
- **Every image push rolls the runtime.** `resolveContainerUri` pins the
  `:latest` digest at synth (`infra/lib/agentcore-runtime-stack.ts:14-36`,
  used at `devbox-stack.ts:219`), so a new image means a new runtime version.
  Probably any other `CfnRuntime` property change (env vars such as
  `LAB_API_BASE`) does too; I did not verify that against AWS.
- **What lives there.** The checkout (`checkoutPath`,
  `middleware/src/providers/agent-projects.ts:226-229`, cloned `--depth 50`
  at `:249`) and Claude Code's state, because `HOME` is the mount
  (`main.py:165`), so `resume: true` (`--continue`, `main.py:114-117`) depends
  on `~/.claude` surviving. Commit-per-capture commits
  (`commitCapture`, `lib/sdlc-pipeline.ts:184`) also live only there until delivery.
- **Nothing notices the wipe.** Box rows outlive it: `loadFleet` restores every
  non-stopped box (`providers/devbox-fleet-store.ts:75-99`), and
  `ensureWorkspace` reuses a codebase's box whenever it is registered and not
  busy, without checking the checkout exists (`lib/bot-runner.ts:816-824`).
  `agent_projects.session_id`/`cloned_at` keep claiming "in workspace"
  (`schema/agent_projects_schema.sql:29-33`). The only wipe-aware code is
  delivery, which checks the captured commit with `git cat-file` and tells the
  user to re-run (`lib/change-delivery.ts:70-79`); its comment blames the
  reaper, but a reaper stop does not wipe storage, a version update does.
  The run timeline flags only a missing mount, not an emptied one
  (`portal/src/components/runs/RunTimeline.tsx:171`).
- **The captured diff is already durable.** `agent_change_requests.diff`
  (`schema/agent_sdlc_schema.sql:27-31`), bounded and flagged when truncated.
- **No S3 path exists.** The devbox execution role grants ECR, logs, X-Ray,
  `cloudwatch:PutMetricData`, workload identity and optionally RDS Data/KB
  (`devbox-stack.ts:114-197`); no bucket.

## Change

Deterministic re-establishment first, snapshots only for what cannot be
re-derived.

1. **Workspace generation marker.** On every clone, write
   `/mnt/workspace/.orgiq-workspace.json` (`{ repo, branch, headSha, clonedAt,
   runtimeVersion }`), and record `head_sha` + `runtime_version` on
   `agent_projects` (additive columns). `main.py` reads its runtime version
   from the environment the platform provides, or an image-baked
   `ORGIQ_IMAGE_DIGEST` build arg if it provides none, and returns it in the
   `devbox_start` event beside `workspace_persistent`.
2. **Detect and rebuild.** `ensureWorkspace` and the SDLC pipeline run one
   command-mode probe (`test -f <marker> && cat <marker>`) before reusing a
   box. Missing marker, or a `runtime_version` that differs from the
   middleware's resolved one: mark the box `wiped`, re-clone at the recorded
   `head_sha` (fall back to the default branch tip), rewrite the marker, and
   append a `workspace_rebuilt` event so the tail says why the first minute
   was a clone. `markCloned` clears only on success, as today.
3. **Re-apply captured work.** Delivery's missing-commit branch
   (`change-delivery.ts:73-79`) re-clones and `git apply`s the stored diff
   when `diff_truncated` is false, instead of asking for a re-run. A truncated
   diff keeps today's message.
4. **Snapshot `~/.claude` only (opt-in).** A per-run tarball of
   `$HOME/.claude/projects/<checkout>` (not the checkout) to
   `s3://<prefix>-devbox-state/<projectId>/<sessionId>.tgz` at `devbox_end`,
   restored before `--continue` when the marker was rebuilt. Needs a bucket in
   `OrgIQ-Devbox` (self-role emptier, per the custodian gotcha) and a
   prefix-scoped `s3:GetObject/PutObject` grant on the execution role, 7-day
   lifecycle expiry. Behind `--context devboxStateSnapshots=true`.
5. **Fix the delivery comment** to name the version update, not the reaper.

## Decisions owed

- **Snapshot `~/.claude` at all?** It holds conversation transcripts, which
  may include repository contents and secrets read during a run. Proposal:
  ship 1-3 and 5 now; take 4 only if losing `--continue` across a deploy is a
  felt problem, and then with SSE-KMS and the 7-day expiry.
- **Deploys that roll the devbox runtime while runs are in flight.**
  Proposal: `deploy.sh` refuses to roll `OrgIQ-Devbox` while any box is
  `running` unless `--force-devbox-roll` is passed (pairs with DE-50's pause).

## Done when

- `cd agents/devbox && ../../.venv-synth/bin/python -m unittest` covers the
  marker write and the runtime version in `devbox_start`.
- A bot-runner unit test: a registered, idle box whose probe returns no marker
  is re-cloned at the recorded `head_sha`, emits `workspace_rebuilt`, and the
  run proceeds; a marker with a matching version skips the clone.
- A change-delivery test: missing commit plus an untruncated stored diff
  re-applies and pushes; a truncated diff returns the existing error.
- `agent_projects` additive columns are registered in both loaders and
  `scripts/validate-mock-floor.sh` stays green.
- With snapshots enabled, infra `npx jest test/devbox-stack.test.ts` asserts
  the bucket, its expiry, and that the execution role's S3 grant is scoped to
  the bucket prefix.
