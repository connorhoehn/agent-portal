# DE-3 Central, versioned model registry

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Pairs with DE-5 (a registry change is a ship event the eval gate judges) and
DE-10 (per-model metering). Independent of DE-4.

## Current state (read from the code, 2026-10-27)

Every Strands agent reads one env var with a literal default and builds one
`BedrockModel` from it at import time; nothing is shared:

| Agent | Default in code | Extra direct Bedrock call |
|-------|-----------------|---------------------------|
| supervisor | `amazon.nova-lite-v1:0` (`agents/supervisor/main.py:54`) | — |
| search, advisor, scoring | `amazon.nova-pro-v1:0` (`search/main.py:71`, `advisor/main.py:65`, `scoring/main.py:49`) | — |
| ingestion, graph-builder | `amazon.nova-pro-v1:0` (`ingestion/main.py:48`, `graph-builder/main.py:49`) | raw `converse(modelId=MODEL_ID)` (`ingestion/main.py:269`, `graph-builder/main.py:350`) |
| assessment-drafter, -scorer | `amazon.nova-pro-v1:0` (`assessment-drafter/main.py:58`, `assessment-scorer/main.py:48`) | — |

Temperature and max tokens are separate env vars per agent
(`MODEL_TEMPERATURE`, `MODEL_MAX_TOKENS`, e.g. `search/main.py:333-344`).

CDK sets one `MODEL_ID` for the whole fleet: `props.modelId ?? 'amazon.nova-pro-v1:0'`
(`infra/lib/agentcore-runtime-stack.ts:151`, env at `:448`), and `app.ts`
never passes `modelId` (`infra/bin/app.ts:209-232`) and has no context key for
it. **So the deployed supervisor runs Nova Pro while a local `agentcore dev`
supervisor runs Nova Lite** — the code default at `supervisor/main.py:54` is
dead in the cloud. Changing the model today means a CDK change and a runtime
redeploy (new runtime version for every agent).

Model ids are bare foundation-model ids everywhere except the online-eval
judge, which already uses the US cross-region inference profile
`us.amazon.nova-pro-v1:0` (`infra/lib/agentcore-telemetry-stack.ts:33`). The
runtime execution role grants `bedrock:InvokeModel`/`Converse*` on `*`
(`agentcore-runtime-stack.ts:220-232`), so inference profiles need no IAM
change. There is **no fallback model and no throttle handling** in any agent
(no `ThrottlingException` handling under `agents/`).

Outside the agents, the BFF has its own scattered ids: `DOC_LINKER_MODEL_ID`
(`middleware/src/providers/doc-linker.ts:31`), `SDLC_REVIEW_MODEL_ID`
(`lib/change-reviewer.ts:20`), `SURVEY_MODEL_ID` (`lib/site-survey.ts:34`), the
hard-coded judge `NOVA_PRO_MODEL_ID` (`lib/judge.ts:24`), the judge config
default (`lib/judge-config.ts:47`) and the canary prompts' pinned model
(`infra/lib/prompt-canary-stack.ts:47,81,119`).

Pricing is keyed by bare id (`middleware/src/lib/pricing.ts:19-22`);
`estimateCost` returns 0 for an unknown key (`pricing.ts:38-40`). Moving an
agent to `us.amazon.nova-pro-v1:0` without normalising that key would make its
runs look free — the exact failure `estimateCostOrNull` was written to stop.

## Change

**One registry document** in SSM Parameter Store, `/orgiq/models/registry`
(JSON, standard tier), written by CDK from a checked-in
`infra/config/model-registry.json`, so every change is a reviewed diff and
SSM's own parameter history gives each change a version number:

```json
{
  "schema": 1,
  "roles": {
    "supervisor":  { "primary": "us.amazon.nova-pro-v1:0", "fallbacks": ["us.amazon.nova-lite-v1:0"], "temperature": 0.0, "maxTokens": 4096 },
    "search":      { "primary": "us.amazon.nova-pro-v1:0", "fallbacks": ["amazon.nova-pro-v1:0"],   "temperature": 0.1, "maxTokens": 4096 },
    "eval-judge":  { "primary": "us.amazon.nova-pro-v1:0", "fallbacks": [] }
  },
  "allow": ["amazon.", "us.amazon.", "eu.amazon.", "apac.amazon."]
}
```

1. **Validator, in CDK synth and in the resolver.** Every id must match an
   `allow` prefix, so the AWS-native-only rule is mechanical. The devbox is
   outside the registry; its Claude inference profile stays in
   `infra/lib/devbox-stack.ts:11` as the one documented exception.
2. **`agents/_shared/model_registry.py`**, modelled on `prompt_source.py`:
   `resolve_model(role)` reads the parameter with a 60 s in-process cache,
   short boto timeouts, and falls back to `MODEL_ID`, then to the literal in
   code, so a registry outage never stops the fleet. The runtime env gets
   `MODEL_REGISTRY_PARAM` and an optional `MODEL_REGISTRY_VERSION` (an SSM
   parameter version number) so an agent can be pinned during a DE-5 gate.
   The model is chosen between invocations and never changes mid-request.
3. **Fallback on capacity errors only.** A per-invocation wrapper retries the
   turn on the next fallback when Bedrock returns throttling, model-not-ready
   or service-unavailable, never on validation or guardrail errors. Whether
   Strands' `BedrockModel` can switch `model_id` without rebuilding the
   `Agent` is unverified; if not, the wrapper rebuilds the agent the way
   `LiveAgent` already rebuilds on a prompt change (`prompt_source.py:335`).
   The two raw `converse` call sites use the same helper.
4. **Cross-region routing = choosing the `us.` profile id.** No separate
   router. The cross-region profile for each Nova model is assumed to exist in
   us-east-1 (unverified for Lite/Micro; Pro is already used by the telemetry
   stack).
5. **Provenance.** Spans get `orgiq.model_id` (the id actually served, after
   any fallback) and `orgiq.model_registry_version`, next to the existing
   `orgiq.prompt_version` (`agents/_shared/instrumentation.py:968`).
6. **Pricing normalisation.** `pricing.ts` strips a leading
   `us.|eu.|apac.` before lookup, with a unit test.
7. **CDK.** `MODEL_ID` stays in the runtime env as the cold fallback, sourced
   from the registry file's `primary` per agent instead of one fleet-wide
   string. A registry edit then rolls no runtime: the agents pick it up within
   60 s. That is why DE-5 must gate the parameter write, not the deploy.
8. **Mock floor.** Offline, the resolver reads the checked-in JSON and never
   calls SSM (same pattern as `judge-config.ts`'s offline branch).

## Decisions owed

- **Supervisor model.** Code says Nova Lite, the cloud runs Nova Pro.
  Proposal: register Pro (what users have actually been served) and treat Lite
  as its first fallback; changing it is then a DE-5-gated registry edit.
- **SSM or AppConfig.** Proposal: SSM. The repo already uses SSM JSON for
  live config (`/orgiq/canary/judge_config`, `/orgiq/canary/weight_b`), and
  AppConfig's staged deploys duplicate what DE-5 does.
- **BFF model ids in scope now or later.** Proposal: agents and the eval judge
  now; doc-linker, change-reviewer, site-survey and the canary prompts in a
  second pass through a `lib/model-registry.ts` reader.

## Done when

- `cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_model_registry`
  covers: cache TTL, SSM error falls back to `MODEL_ID`, a non-`amazon` id is
  rejected, a version pin is honoured, and fallback fires on a throttling
  error but not on a validation error.
- `rg -n 'os.environ.get\("MODEL_ID"' agents/*/main.py` returns nothing; every
  agent calls `resolve_model("<role>")`.
- `cd infra && npx cdk synth OrgIQ-AgentCoreRuntime --context deployRuntimes=true`
  emits `/orgiq/models/registry`, and synth fails on a registry file holding a
  non-AWS-native id.
- A jest test shows `estimateCostOrNull('us.amazon.nova-pro-v1:0', …)` equals
  the bare-id price.
- `golden_runner.py --mode structural` and `validate-mock-floor.sh` stay green.
