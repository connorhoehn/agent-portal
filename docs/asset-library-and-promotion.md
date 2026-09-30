# The asset library and the promotion ladder

How the fleet's instructions are stored, typed, discovered, gated and shipped —
and how session observations become reusable skills.

This replaces the older framing in which "prompt management" meant six agent
system prompts in a flat Bedrock namespace. That framing could not hold a
prompt a person runs with inputs, an evaluator a pipeline calls with no human
in it, or a skill the model discovers for itself, and those are most of the
real use cases.

## Org navigation and review

Build → **Distillation** contains observations (Run notes), patterns and guides.
Its **Review** area keeps knowledge verdicts separate from **Asset promotions**,
where candidates retain observations, approval, dry-run results and dismissed
history. Publishing a guide changes its knowledge lifecycle only; it does not
activate a skill or authorize an unattended run.

Build → **Agent library** is the reusable asset catalog, including manually
written assets, inputs, versions, evaluations and usage. `/iq/library` and
`/iq/library/:assetId` remain stable. Legacy `/iq/promotions` and
`/iq/promotions/:candidateId` redirect to `/iq/distillation/review?view=promotions`,
retaining filters, identifiers, extra query parameters and fragments.

`GET /api/distillation/relationships/:kind/:id` joins knowledge, library and
promotion records by existing identifiers. Publication links use
`library_item_id`; review links use sample/target IDs. Shared observation IDs
are labeled as shared evidence, never as proof that one asset published another.
Unlinked legacy promotion records stay explicitly unlinked. The existing
promotion provider remains fixture-backed; this consolidation does not invent
catalog records or activation state for it.

Design discussions, questions, approvals and decision records remain in Designs
on their initiatives. A linked approved design decision can be referenced as
evidence; the discussion is not copied into the knowledge catalog.

## Two declared properties

Every asset declares two things, and almost everything else follows from them.

**KIND — who invokes it.** Borrowed from MCP's own framing, because the answer
decides where the asset belongs and what its release looks like.

| Kind | Driver | Example |
|------|--------|---------|
| `system` | the agent it defines | `orgiq-supervisor-system-prompt` |
| `prompt` | a person, with inputs | "draft a stakeholder update email" |
| `evaluator` | a pipeline, no human | "does this diff weaken CSRF?" |
| `skill` | the model, on description match | "triage a flaky test" |
| `insight` | nothing — injected as fact | "Fargate tasks here are ARM64" |

**TIER — how far the blast radius reaches.** The tier, not a reviewer's memory,
decides the gates:

| Tier | What it means | Gate |
|------|---------------|------|
| `sandbox` | Studio only | none |
| `internal` | callable by the fleet | owner + eval ≥ 80% + complete contract |
| `endpoint` | reachable from outside | the above, plus a bound guardrail and 2 sign-offs |

A tier is a promise about blast radius, so the ceremony scales with it. An
evaluator nobody can reach answers to nobody; one behind `/v1/checks/csrf`
that reads attacker-supplied diffs answers to everyone.

## The contract, and why `source` is the important field

`middleware/src/lib/prompt-contract.ts` types every variable: `name`, `type`,
`required`, `default`, and **`source`**.

Source is the trust boundary expressed as data:

- `literal` — baked in. Trusted, rendered inline.
- `caller` — supplied by the calling system, validated against the contract.
  Trusted enough to render inline.
- `retrieved` — fetched content. **Fenced.**
- `untrusted` — end-user text. **Fenced.**

A fenced value is wrapped in a labelled block and *defanged* — attempts to
close the fence from inside the value are neutralised, as is `{{…}}` syntax, so
an injected value cannot smuggle in a placeholder for a later pass to expand.
This is the OWASP rule ("never let untrusted text share a channel with the
instructions it could rewrite") enforced by the system rather than remembered
by whoever wrote the prompt.

**A variable the template uses but the contract does not declare is treated as
untrusted.** Nothing vouched for it, so it does not get to sit next to the
instructions. Above the sandbox tier an undeclared variable is a deploy
refusal, because rendering it as untrusted is safe but almost certainly not
what the author meant.

### Two render paths, one rule

- `prepareValues()` — for renderers that expand `{{…}}` themselves, notably
  Bedrock when a prompt ARN is the model. The template is not ours to wrap by
  then, so the fence goes on the **value** before it leaves us.
- `renderPrompt()` — full local substitution.

Contracts live on `observability.prompt_version_meta` (see
`schema/prompt_contract_schema.sql`) rather than in a new table: that row is
already keyed `(prompt_id, version)` and already holds the portal's view of a
Bedrock version.

### System prompts are deliberately not parameterised

`agents/_shared/prompt_source.py` does not substitute. An agent's identity is
not a template. If a resolved system prompt still contains `{{…}}` the resolver
logs it loudly rather than guessing a value — the parameterised part belongs in
a library asset with a contract.

## Discovery: one index, two consumers

`/api/library` is faceted by kind, tier and role, and searches the
**description**. That is deliberate: the description is what a model matches on
for progressive disclosure, so a human searching it is testing what the agent
will see. The skill browser is this list filtered to `kind=skill` — a skill and
a prompt differ in who invokes them, which is a facet, not a separate product.

## The promotion ladder

```
OBSERVATION            one thing that happened once  (lab_experiences)
   │  seen ≥3 times across ≥2 sessions
   ▼
PATTERN                a recurring shape
   │  repeatable trigger AND outcome?
   ├── no  ──▶ INSIGHT     a fact, injected, never run
   └── yes ──▶ RUNBOOK     ordered steps, decision points
                  │  human approved AND dry-run passes
                  ▼
               SKILL       SKILL.md the agent can invoke
                  │  drift detected
                  └──────▶ back to RUNBOOK
```

**The dry-run is a run (pipelines lane P2, 2026-09-30).** "Dry-run passes" is no
longer a boolean a reviewer asserts. Each RUNBOOK-rung candidate is a pipelines
definition `runbook:<candidate>` (`middleware/src/lib/pipeline-definitions.ts`);
`POST /api/pipelines/definitions/:id/dry-run` enqueues a `runbook:dry-run` job on
the existing queue behind dispatch-work's money brakes and records a
`pipeline_runs` row that the job's completion marks `completed`; and
`providers/promotions.ts` refuses RUNBOOK → SKILL unless the verdict cites a
completed run of that candidate's own definition (`dryRunRunId`). Judge:
`middleware/src/lib/__tests__/promotion-requires-run.test.ts`.

The bottom rung already exists and works: agents write typed observations
(`worked | failed | gotcha | decision | convention`) through the `lab` CLI into
`lab_experiences`, and every devbox session injects them at `SessionStart` via
a hook baked into `agents/devbox/managed-settings.json`. That is progressive
disclosure, in production, today.

What was missing is the middle — clustering, ranking and promotion — and the
top: a skill as a first-class, versioned, gated asset.

Every derived asset carries its provenance: the observations it stands on, how
many sessions they span, and each contributor's weight. A runbook standing on
nine observations across four sessions is a different claim from one standing
on three, and the ladder is only trustworthy if that is visible.

## Naming

Do **not** call the Aurora table `skills`. `skills` and `person_skills` in
`schema/orgiq_schema.sql` are the org graph's people-expertise concept — an
entirely different domain object that predates this. Use `agent_skills`.

---

## Short-circuiting rediscovery

> Look before you spend. Evaluate prior experience against the current
> environment instead of replaying it blind.

An agent is about to spend forty minutes and forty thousand tokens working out
why an ECS rollout is stuck. Somebody already did that — in August, on a
different project, on someone else's laptop. The knowledge exists. It is
indexed. Nothing in the system currently makes the agent look before it spends.

This is the payoff that pays for the rest of the infrastructure, so it is worth
being precise about why it did not happen and what changed.

**Built.** `middleware/src/lib/rediscovery.ts` (ranking + verdicts, pure),
`providers/rediscovery.ts` (corpus + outcome ledger), `POST
/api/rediscovery/check`, and the "Before you spend" panel inside the
assign-to-agent modal.

### Why today's recall would miss the August fix

`lab recall` runs at `SessionStart` and is real. But `listExperiences` filters
on **repo** or **initiative** — the two indexes on `lab_experiences` are
`(repo, created_at DESC)` and `(initiative_id, created_at DESC)`. The August
ECS lesson was learned on a *different project*, so a repo-scoped recall
cannot surface it. Recall is scoped to where the knowledge was WRITTEN rather
than to the problem it is ABOUT, which is exactly backwards for rediscovery.

So the retrieval key has to be the **problem shape** — symptoms, error
signatures, the tool sequence that led here — not the codebase.

### "Evaluate", not "replay"

The harder half is the verb. A matched experience is a *candidate*, not an
answer: the August fix may be stale (different CDK version, different account,
a custodian rule that has since changed). Injecting it blind trades a
forty-minute rediscovery for a confidently wrong path, which is worse.

So the match needs an applicability judgment, and that judgment is itself a
library asset — `kind: 'evaluator'`, tier `internal`:

> Given this prior experience and this current environment, does it still
> apply? Answer applies / partially / stale, with the evidence that decided it.

Which closes a nice loop: the thing that makes memory pay off is an evaluator,
governed by the same contract, tier and eval machinery as everything else, with
the environment description arriving as a `retrieved` (fenced) variable.

### Where it belongs in the console

Not a new page — a **pre-flight step at the moments where spend is already
authorised**:

1. **The assign-to-agent modal** (`portal/src/pages/work/AssignJobModal.tsx`)
   is the primary home. It already states the cost of the decision ("5 pts ·
   ~$5.33, runs on the first idle computer"). A "Before you spend" block
   listing the top-k applicable prior experiences — each with its verdict and
   its age — turns a confirmation into a look-before-you-spend moment, at the
   one instant a human is already paying attention.
2. **The dispatch brakes** (`lib/bot-runner.ts`) already gate on money in three
   places. Prior art is the same shape of check — a soft brake with a named
   confirm flag — for work that has probably already been done.
3. **Automate → Overview** carries the scoreboard. This is the feature that
   justifies the infrastructure, so it has to show that it did: short-circuits
   this month, and the spend that did not happen.

### Measuring it honestly

A saving can only be claimed against a counterfactual, so record the estimate
**at the moment of the short-circuit** (the same estimator the marketplace
already uses) and store it with the decision. "12 short-circuits, ~$340 and six
hours not spent" is defensible; a number derived after the fact is not.

The failure mode to watch for is the opposite one: an agent that trusts a stale
memory and takes a confidently wrong path. Track dismissals ("no, this is
different") as a first-class signal — a match that people keep dismissing is a
retrieval bug, and it is the metric that tells you before the memory does harm.

### What the matcher can and cannot do

Retrieval is **lexical**, not semantic: a weighted bag of tokens where
identifying ones (`HttpEndpointNotEnabledException`, `task_definition`,
`EXEC_FORMAT_ERROR`, status codes, paths) outweigh prose four to one, and two
problems only count as the *same* problem if they share at least one
identifying token. A purely prose overlap has to be substantial to survive at
all, and even then it is capped below the strong band — it can reach `partial`,
never `applies`.

That boundary is deliberate and it has a cost, worth stating plainly:

- **Works well** on the error-signature shape of rediscovery, which is the
  common and expensive case. Asked "why is our ECS rollout stuck?" from
  `orgiq-auth-service`, it returns the August lesson learned on
  `orgiq-stream-analytics` at 0.80 / `applies` — a cross-project hit that a
  repo-scoped recall structurally cannot reach.
- **Misses paraphrase.** Two accounts of the same conceptual bug written in
  different words — a session-rotation gotcha described once as `session_epoch`
  and once as `max-age` / `pre-switch` — share only ordinary words and score
  ~0.12. The matcher correctly refuses to guess, and correctly stays silent.
  Closing that gap needs embeddings over `lab_experiences`, not a tuned
  lexical threshold; tuning one to force such a pair through would buy the
  paraphrase case at the price of false positives everywhere else, and a false
  positive at a spend moment is what teaches people to ignore the panel.

So: ship the lexical matcher, keep the verdicts conservative, and let the
**dismissal rate** say when semantic retrieval has become worth building.
