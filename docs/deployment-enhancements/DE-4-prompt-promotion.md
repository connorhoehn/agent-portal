# DE-4 Prompt promotion pipeline

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on DE-5 (the gate a promotion must pass). Parallel to DE-3.

## Current state (read from the code, 2026-10-27)

**Agents run whatever is in DRAFT.** Each runtime gets
`SYSTEM_PROMPT_NAME=orgiq-<agent>-system-prompt`, `SYSTEM_PROMPT_VERSION=DRAFT`
and `PROMPT_REFRESH_S=60` (`infra/lib/agentcore-runtime-stack.ts:433-440`).
`resolve_system_prompt` falls back to the baked literal on any error, caches
for 60 s, and only passes `promptVersion` when the env is not DRAFT
(`agents/_shared/prompt_source.py:149-152, 191-220`). On every cache miss it
pages through the **whole** `ListPrompts` listing to find the id by name
(`prompt_source.py:133-140`), for each of eight agents.

**A DRAFT edit reaches production within 60 s with no gate.**
`PUT /api/observability/canary/library/:promptId/draft` (`middleware/src/routes/canary-library.ts:386`, mounted at `middleware/src/index.ts:483`)
needs only `ManageCanary`, which `org-leader` and `hr-admin` hold
(`middleware/seeds/roles/orgiq/org-leader.cedar:12`, `hr-admin.cedar:25`).
`POST /library/:promptId/publish` creates a numbered version
(`canary-library.ts:515-546`), but nothing points an agent at it.

**The "existing prompt canary" does not touch agent prompts.** The backlog
line implies it does; it does not. `OrgIQ-PromptCanary` (on by default,
`infra/cdk.json:18`) creates two demo prompts `orgiq-canary-subject-a/b` and
a judge, each with a `CfnPromptVersion` (`infra/lib/prompt-canary-stack.ts:40-152`),
and a Step Functions controller that moves `/orgiq/canary/weight_b`
(`:158-176`, `:306-417`). The only reader of that weight is `POST /canary/ask`
(`middleware/src/routes/canary.ts:82-89`), which picks subject A or B. The
controller's thresholds (`min_samples`, `promotion_delta`, `rollback_floor`,
`/orgiq/canary/config`, `:172-176`) are the reusable part.

**Three version vocabularies exist and none is wired to the agents:**

| Store | Key | Written by | Read by an agent? |
|-------|-----|-----------|-------------------|
| Bedrock prompt versions | `1`, `2`, … | `publish` route | no (env says DRAFT) |
| `observability.prompt_version_meta.lifecycle_status` (`draft → published → deployed → promoted / rolled_back → superseded`) | prompt id + version | `PUT /meta/:promptId/:version` (`routes/prompt-history.ts:391`) | no |
| `observability.prompt_versions.promoted_at` | prompt **sha** | `POST /api/observability/harness/promote` (`routes/harness.ts:1568`) | no |

Traces stamp the content sha (`LiveAgent.prompt_sha`, `agents/_shared/agui_stream.py:186`;
`orgiq.prompt_version`, `instrumentation.py:968`), not the Bedrock version
number, so a judge score cannot today be joined to a published version
without re-hashing.

Separately, the asset library's `decideDeploy` (`middleware/src/lib/prompt-contract.ts:269-291`,
an 80 % eval bar) only computes a readiness badge in `GET /api/library/:id`
(`routes/library.ts:48`); it blocks nothing, and its evals are simulated
without Bedrock (`providers/prompt-evals.ts:182-220`).

**Versions vs aliases.** Bedrock Prompt Management versions are used here
(`CreatePromptVersionCommand`, `CfnPromptVersion`). Nothing in this repo uses
a prompt *alias*, and I could not confirm from code that Prompt Management
offers one (agents and flows have aliases); treat "prompt aliases" as
**unverified**. The design below does not need them.

## Change

**A pointer per agent is the alias.** Two SSM parameters per agent:

- `/orgiq/prompts/<agent>/live` — `{"promptId":"…","version":"7"}`
- `/orgiq/prompts/<agent>/candidate` — same shape plus `"weight": 10`, or absent

1. **`prompt_source.py` reads the pointer** (`SYSTEM_PROMPT_POINTER=/orgiq/prompts/<agent>`),
   which also removes `ListPrompts` from the hot path because the pointer
   carries the id. Per invocation, it serves the candidate with probability
   `weight/100`, otherwise live. Existing safety properties hold: never
   fail closed, never swap mid-request. `SYSTEM_PROMPT_VERSION` stays as a
   hard pin and `PROMPT_SOURCE_DISABLED=1` as the kill switch.
2. **DRAFT is refused when `APP_ENV=production`.** CDK stops setting
   `SYSTEM_PROMPT_VERSION=DRAFT`; DRAFT stays the default for `agentcore dev`.
3. **Spans carry the version**: `orgiq.prompt_version_number` and
   `orgiq.prompt_arm` (`live` or `candidate`) beside the existing sha.
4. **Promotion flow, one route per step**, each `ManageCanary` plus a
   `prompt_version_meta` transition:
   - `publish` (exists) → `published`.
   - `POST /api/iq/prompts/:agent/candidate {version}` runs the DE-5 offline
     gate for that agent with the version pinned; on pass it writes the
     candidate pointer at the configured starting weight → `deployed`.
   - The canary controller gets a second, per-agent input: score events
     grouped by `orgiq.prompt_arm`. On PROMOTE it copies candidate to live
     and deletes the candidate pointer (old live → `superseded`, new →
     `promoted`); on ROLLBACK it deletes the candidate (→ `rolled_back`).
     Thresholds come from `/orgiq/canary/config`.
5. **One promoted notion.** `harness.ts`'s sha-keyed `promoted_at` becomes a
   read of the live pointer, so there is one answer to "what is promoted".
6. **Mock floor.** Pointers are a registered fixture; offline the resolver
   reads it and never calls SSM or Bedrock; `POST /api/__mock/reset` restores it.

Out of scope: guardrails are also live on DRAFT
(`GUARDRAIL_VERSION: 'DRAFT'`, `agentcore-runtime-stack.ts:446`) and deserve
the same treatment; that is DE-12 (`DE-12-guardrail-lifecycle.md`).

## Decisions owed

- **Canary on live traffic, or gate-only.** Proposal: gate-only (DE-5 offline
  pass, then a straight pointer flip) until online eval runs (DE-5).
  Without judge scores per arm, the controller would promote on noise.
- **Who may promote.** Proposal: `ManageCanary` to make a candidate; a promote
  that skips the canary needs a second person (DE-43 separation of duties).
- **Bootstrap.** Proposal: a one-off script publishes the current DRAFT of
  each agent as version N and writes it as `live`, so day one changes nothing
  an agent says.

## Done when

- `cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_prompt_source`
  adds cases for: pointer resolution, the candidate weight split (seeded RNG),
  DRAFT refused under `APP_ENV=production`, pointer read failure falling back
  to baked, and no `list_prompts` call when a pointer is present.
- `cd infra && npx cdk synth OrgIQ-AgentCoreRuntime --context deployRuntimes=true | grep -c SYSTEM_PROMPT_VERSION`
  shows no `DRAFT` value.
- Jest route tests: candidate creation refuses a version that fails the gate;
  promote and rollback write the right pointers and `lifecycle_status` rows.
- In `dev:mock`, a `PUT …/draft` followed by a span read shows the agent still
  serving the live version.
- `validate-mock-floor.sh` and `validate-agent-eval.sh` stay green.
