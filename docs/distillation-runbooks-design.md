# Distillation → Runbooks: design for review

**Status: DESIGN, 2026-10-14. Nothing here is built.** The definition of done
that follows from it is `docs/distillation-runbooks-goal.md` (also a draft).
Read-only investigation of the tree at `ff7ea609`; the evidence below was taken
by running the real mock provider in-process (`npx tsx`, `MOCK_AURORA=true`,
no server, no browser).

The ask, in the user's words: distillation "should be more like a procedural
memory run book that can be injected into sessions along with project context
when a computer boots and runs work. All of the procedural facts are not human
readable … recreate all of them and have e2e tests for them. I couldn't demo
these distillations to a human." Storage must be agnostic: the durable store is
DynamoDB-wire (`~/Projects/managed-nosql-store`), designed against the existing
provider and mock-fixture seam, not SQL.

---

## 1. What is wrong today

### 1.1 Nothing distillation produces ever reaches a run

This is the central defect; the readability problems below are secondary to it.

- **The only memory a session receives is raw L0.** The devbox image bakes one
  SessionStart hook, `lab recall` (`agents/devbox/managed-settings.json`), which
  prints the 20 newest `lab_experiences` rows for the repo as
  `- [kind] title — body` (`agents/devbox/lab:106-119`). No cluster, artifact,
  procedure or Library asset is ever injected.
- **That hook probably keys on the wrong repo.** `LAB_SESSION_ID/BOX_ID/REPO/INITIATIVE_ID`
  are read by the CLI but set by nothing (CDK sets only `LAB_API_BASE` and
  `LAB_CALLBACK_SECRET`, `infra/lib/devbox-stack.ts:257-258`; the invoke
  payload has no env), so `repo` falls back to `basename(pwd)` and Claude's cwd
  is `/mnt/workspace`. Inferred from code, not checked on a live box.
- **The local worker gets no memory at all.** `tools/local-compute-worker.mjs`
  runs `claude -p <prompt>` with no managed settings; the only addition is
  `frameLocalPrompt` (`middleware/src/lib/local-work.ts:197-210`), the
  non-interactive framing applied at claim.
- **Dispatched work gets a bare task.** `renderWorkItemPrompt`
  (`lib/bot-runner.ts:1106-1128`) is title + key + description + labels +
  `PIPELINE_CONTRACT`; `executeProjectRun` prefixes `Work in <checkout>.`;
  `job-dispatcher.ts:85` passes `payload.prompt` through untouched. There is no
  `buildContext`/`initiativeContext` anywhere in `middleware/src/lib`. Linked
  decisions (`PUT /api/graph/work-items/:id/decisions/:id`) never reach a
  prompt.
- **Nothing records what a run was told.** `agent_jobs.payload` is stored
  unframed; no run row names the memory it started with.
- **Procedure "applications" are hand-entered.** The only writer is
  `POST /api/distillation/procedures/:id/apply`, stamped `boxId: 'portal'`.
  No run reports which procedure it followed.

### 1.2 Four memory stores that never meet

The same idea — "a run learned something; turn it into reusable procedure" —
is implemented four times, each with its own fixture, and none reads another:

| Store | Fixture | Fed by | Read by |
|---|---|---|---|
| Lab run notes | `mock/lab.ts` `lab-experiences` | `lab remember` (real runs) | `lab recall` (the hook) |
| Distillation L0→L1→L2 | `mock/distillation.ts` (own 74 observations) | its own seed + simulated ingest | `/iq/distillation` only |
| Promotions ladder | `mock/promotions.ts` (16 candidates) | its own seed | `/iq/promotions` |
| Rediscovery | `providers/rediscovery.ts` (own corpus) | its own seed | "look before you spend" |

A `lab remember` from a real box never appears in Distillation (its L0 is a
separate fixture, and on Aurora "every other read … is still mock",
`docs/distillation.md`). So the pipeline the portal demos is fed by nothing
real and feeds nothing real. Session bundles (`providers/session-bundle.ts`)
are a fifth near-miss: a reviewed, versioned release surface for what a box is
configured with, which never carries runbooks.

### 1.3 The records are not readable

The domain stores a procedure as a set of `Fact` rows — `statement`,
`subject/predicate/object`, `ordinal`, evidence ids — and renders the steps
from them. Default corpus: 11 artifacts, 24 facts, 13 with no plain-language
text; 3 procedures; **2 of 11 contain any command, 2 any verification step,
1 any rollback.** The L1→L2 pass makes it worse: it orders steps by the
`created_at` of whatever observations share a repo chunk and uses each
observation's title as a step (`mintProcedureFacts`,
`providers/distillation.ts:1198-1243`). One "Compact L1 → L2" on the default
corpus mints 6 artifacts and 32 facts; 3 of the 6 are "procedures".

### 1.4 Ten procedural facts, verbatim, and what is wrong with each

Rows 1–7 were minted by one `compactNow('L1')` + `compactNow('L2')` on the
default corpus; 8–9 are seeded; 10 is the `large` scenario's generator.

**1. Step 1 of "Canary judge config lives in SSM, edited from the portal"**
```json
{"id":"fact-901","artifact_id":"art-901","statement":"Agents read their system prompt from Prompt Management on every invocation","plain":null,"subject":"Prompt Management resolves system prompts at runtime, no rebuild needed","predicate":"step_of","object":"art-901","evidence_observation_ids":["obs-043"],"confidence":0.88,"ordinal":1}
```
A description of system behaviour, not an action, and about a different
subject (Prompt Management) than the procedure's title (SSM judge config).
Three unrelated clusters in one repo were chunked into one "procedure".

**2. Step 5 of the same procedure**
```json
{"id":"fact-905","artifact_id":"art-901","statement":"Any Bedrock list API in this codebase must be paginated by convention, not by memory","plain":null,"subject":"ListPrompts truncates silently without a nextToken","predicate":"step_of","object":"art-901","evidence_observation_ids":["obs-048"],"confidence":0.9,"ordinal":5}
```
A coding rule placed as step 5 of a config procedure because of write order.
Following steps 1–5 in order is meaningless.

**3. Step 7 of the same procedure**
```json
{"id":"fact-907","artifact_id":"art-901","statement":"Online evaluation needs both enableEval and enableOnlineEvalConfig context flags","plain":null,"subject":"Canary judge config lives in SSM, edited from the portal","predicate":"step_of","object":"art-901","evidence_observation_ids":["obs-052"],"confidence":0.83,"ordinal":7}
```
The one step that implies a command (`cdk deploy --context …`) does not give
it. "Needs" is a fact; a step says what to run and what you should see.

**4. Step 1 of "Alert on error-budget burn rate, not raw error count"**
```json
{"id":"fact-913","artifact_id":"art-904","statement":"Gateway+agent OTel topology handles peak ingest at 2x headroom","plain":null,"subject":"Collector fleet gateway+agent topology rolls out without an ingest gap","predicate":"step_of","object":"art-904","evidence_observation_ids":["obs-001"],"confidence":0.91,"ordinal":1}
```
A load-test result as step 1 of an alerting procedure. The title comes from
one cluster, the steps from three.

**5. Step 5 of the same procedure**
```json
{"id":"fact-917","artifact_id":"art-904","statement":"Sampling decision waits for the whole trace, not the first span","plain":null,"subject":"Tail-sampling policy always keeps errors and p99 latency","predicate":"step_of","object":"art-904","evidence_observation_ids":["obs-005"],"confidence":0.88,"ordinal":5}
```
A property of tail sampling. Nothing to do, nothing to check, and it has
nothing to do with burn-rate alerts.

**6. A claim on the runbook "Cognito + BFF OIDC replaces the hosted-UI redirect (+1 more)"**
```json
{"id":"fact-912","artifact_id":"art-903","statement":"Per-tenant Cognito app clients keep each tenant’s callback allowlist short; A per-tenant Cognito client also isolates a misconfigured redirect to one tenant","plain":null,"subject":"Per-tenant Cognito app clients keep each tenant’s callback allowlist short (+1 more)","predicate":"supports","object":"art-903","evidence_observation_ids":["obs-071","obs-072"],"confidence":0.8,"ordinal":null}
```
Two observation titles joined with "; " (capital A mid-sentence), a subject
carrying the machine's "(+1 more)", and a title with the same suffix. This is
string concatenation shown to a person as knowledge.

**7. The claim on the decision "Tag every ad-hoc Bedrock eval run with the initiative footing the bill"**
```json
{"id":"fact-932","artifact_id":"art-906","statement":"Tag every ad-hoc Bedrock eval run with the initiative footing the bill; Cap eval-run concurrency per initiative so one team can’t starve the shared budget alarm","plain":null,"subject":"Tag every ad-hoc Bedrock eval run with the initiative footing the bill (+1 more)","predicate":"supports","object":"art-906","evidence_observation_ids":["obs-073","obs-074"],"confidence":0.8,"ordinal":null}
```
Two different decisions fused into one "fact"; neither says how to tag a run
(which tag key, where).

**8. Seeded fact on a retired insight**
```json
{"id":"fact-012","artifact_id":"art-008","statement":"Aurora Serverless v2 never scales below its 0.5 ACU floor, billing roughly $45/month even idle.","plain":null,"subject":"Aurora Serverless v2","predicate":"bills","object":"a 0.5 ACU floor (~$45/mo) even idle","evidence_observation_ids":["obs-063"],"confidence":0.96,"ordinal":null}
```
True and readable, but not procedural: the subject/predicate/object triple
restates the sentence in a worse form, and the fact lives on a *retired*
artifact that still shows in Knowledge. A reader cannot tell what to do.

**9. Step 3 of the seeded procedure "Cut one tenant over from SAML to Cognito"**
```json
{"id":"fact-020","artifact_id":"art-010","statement":"Flip the tenant on its own schedule, never in one flag-day cutover","plain":"Switch one customer and verify sign-in.","subject":"Flip the tenant on its own schedule, never in one flag-day cutover","predicate":"step_of","object":"art-010","evidence_observation_ids":["obs-036"],"confidence":0.85,"ordinal":3}
```
The two texts disagree (`statement` is a policy, `plain` is an action with a
verification); neither says how to flip a tenant or how to verify sign-in.
The seeded run that failed here (`papp-006`: "flag flipped but the hosted-UI
redirect still resolved to the old domain") taught the missing step —
update the app-client callback list first — and the procedure never
changed: there is no way for a run's lesson to become an edit.

**10. Generated fact in the `large` scenario** (`mock/distillation.ts:1825`)
```ts
statement: `Load-corpus fact ${i + 1}: the generated cluster it cites is evidenced by its own observations.`,
subject: `cl-L${pad(clusterIndex + 1, 2)}`, predicate: 'supports', object: `art-L${artifactIndex + 1}`,
```
Twelve rows of filler text shown in the same list as real knowledge, so the
volume scenario demos as nonsense.

The common causes: the unit is a *fact*, not a procedure; steps come from
write order and repo grouping, not from a person or a run that did the steps;
no field holds a command, an expected result, a precondition or a rollback;
and there is no edit path, so a failed run can't fix the step it failed on.

### 1.5 The UI explains the machine instead of the knowledge

`/iq/distillation` (8.7k lines under `portal/src/pages/distillation/`) leads
with tiers (Run notes / Patterns / Guides = L0/L1/L2), compaction jobs, a tier
graph, sampling rates and lineage canvases. A person cannot answer "what does
a box know about cutting over a tenant, and would it get that?" because no
surface shows what a run receives. The demo (`docs/distillation-demo.md`) is a
three-minute animation of the pipeline itself; its finished procedure has 5
steps drawn from two different work items (a logout-cookie bug fix appears as
a step of a tenant cutover).

---

## 2. Target model: the Runbook

A runbook is a **markdown procedure a person would hand a new colleague**, and
the exact text a box receives. It is stored as a structured document and
rendered to one canonical markdown; editing the markdown parses back to the
same structure (round-trip exact, tested).

### 2.1 Shape

```ts
// lib/runbooks/types.ts — the stored document (one per version)
interface RunbookDoc {
  title: string;                       // imperative: "Cut one tenant over from SAML to Cognito"
  summary: string;                     // one sentence, ≤ 200 chars
  use_when: string[];                  // situations, in words ("Moving one customer's sign-in to Cognito")
  not_for: string[];                   // near-misses that need a different runbook
  triggers: {                          // machine-matchable selection hints (§3.2)
    work_item_labels: string[]; repos: string[]; tools: string[]; keywords: string[];
  };
  preconditions: string[];             // checkable statements, each a "- [ ]" line
  steps: Array<{
    do: string;                        // one imperative sentence
    command?: { lang: 'bash' | 'sql' | 'http' | 'text'; text: string };
    expect?: string;                   // what you should see
    why?: string;                      // optional, one sentence
  }>;
  verify: Array<{ check: string; command?: RunbookCommand }>;
  failure_modes: Array<{ symptom: string; cause: string; response: string }>;
  rollback: Array<{ do: string; command?: RunbookCommand }>;
  notes?: string;                      // free markdown for context that is not a step
}

// The runbook itself (one row; versions hang off it)
interface Runbook {
  id: string;                          // stable slug: rb-tenant-cutover
  scope: { kind: 'org' | 'initiative' | 'repo' | 'tool'; ref: string | null };
  owner_person_id: string;             // accountable human (p-…)
  status: 'draft' | 'published' | 'retired';
  current_version: number;
  retired?: { at: string; by: string; reason: string; superseded_by: string | null };
  created_at: string; updated_at: string;
}

interface RunbookVersion {
  runbook_id: string; version: number;
  doc: RunbookDoc;
  markdown: string;                    // renderRunbook(doc) — stored so a brief can cite bytes
  sha256: string;
  author: { kind: 'person' | 'run' | 'migration'; id: string };
  proposal_id: string | null;          // the proposal that produced it (null for v1 of a hand-authored one)
  accepted_by: string | null; accepted_at: string | null;
  provenance: {                        // what this version was distilled from
    run_refs: string[];                // agent_jobs / bot runs / devbox sessions
    session_ids: string[];
    lab_experience_ids: string[];      // raw run notes cited as evidence
    source_artifact_ids: string[];     // migration only: art-0xx it replaced
  };
}

interface RunbookApplication {          // a run that was GIVEN the runbook and reported on it
  id: string; runbook_id: string; version: number; run_ref: string; brief_id: string;
  outcome: 'followed' | 'followed_with_deviation' | 'failed' | 'not_used';
  failed_at_step: number | null; note: string | null; at: string;
}
```

Derived on read, never stored: **confidence / health** —
`procedureHealth` moved as-is from `providers/distillation.ts` to
`lib/runbooks/health.ts` (proven / drifting / unproven), now counted from
`RunbookApplication` rows that runs write themselves (§3.5), per version.
**Review state** is the open-proposal count plus `status`.

### 2.2 Canonical markdown (what a person reads and a box receives)

The rewrite of fact 9's procedure, as v2 after the demo's accepted edit:

````markdown
# Cut one tenant over from SAML to Cognito

> Runbook rb-tenant-cutover · v2 · Auth Migration · repo orgiq-auth-service ·
> owner Vera Green · proven on 3 of 4 runs (last 2026-10-14)

Move one customer tenant's sign-in from the legacy SAML shim to Cognito
without signing anyone out, with a five-minute way back.

**Use when** you are cutting over a single tenant on the Auth Migration
initiative. **Not for** deleting the SAML shim (do that only after the last
tenant; see the d-legacy-auth decision).

## Before you start
- [ ] The tenant's Cognito app client exists and you know its id (`$CLIENT_ID`).
- [ ] The SAML shim is still running behind the per-tenant flag.
- [ ] You know the tenant's portal origin (`$ORIGIN`).

## Steps
1. **Confirm sign-in works on the shim before you touch anything.**
   ```bash
   curl -s "$ORIGIN/api/auth/config" | jq .ssoEnabled
   ```
   Expect `false` (the tenant is still on the shim).
2. **Add the Cognito callback for this tenant's origin to its app client.**
   ```bash
   aws cognito-idp update-user-pool-client --user-pool-id "$POOL_ID" \
     --client-id "$CLIENT_ID" --callback-urls "$ORIGIN/api/auth/callback"
   ```
   Expect the response's `CallbackURLs` to list `$ORIGIN/api/auth/callback`.
   *Why: the second pilot run failed at the flip because the redirect still
   pointed at the old domain.*
3. **Flip only this tenant's flag.** Never several tenants in one change.
4. **Sign in as a test user of this tenant and check no live session was dropped.**
   Expect sign-in on the first try and zero forced logouts in the session log.

## Verify
- `GET $ORIGIN/api/auth/config` reports `ssoEnabled: true`.
- No `session_epoch` bump for this tenant's existing users.

## If it goes wrong
| Symptom | Likely cause | Do this |
|---|---|---|
| Sign-in bounces to the old service | Callback list not updated (step 2 skipped) | Roll back, then redo step 2 |
| Users signed out mid-day | Flag flipped for more than one tenant | Roll back every tenant flipped in that change |

## Roll back
1. Flip this tenant's flag back. The shim answers within one grants refresh (~2 min).

## Where this came from
Distilled from runs on wi-auth-e2-s2 (sess-auth-04, sess-auth-06, run
job-…). v2 added step 2 after run job-… failed at the flip. Migrated from
distillation artifact art-010.
````

The markdown is the product. The structure behind it exists so that the
linter, the selector and the diff can be mechanical.

### 2.3 Lint rules (mechanical, applied to every version from every author)

`lintRunbook(doc)` returns findings with stable rule ids; a version with any
`error` cannot be accepted. Each of the ten examples above fails at least one:

| Rule | Error when | Catches |
|---|---|---|
| R-imperative | a step's `do` does not start with a verb from an allowlist (or a lexical imperative check) | 1, 2, 4, 5, 8 |
| R-joined | a step or summary contains `; ` joining two sentences, or two sentence-final periods | 6, 7 |
| R-generated | text matches `\(\+\d+ more\)`, `Load-corpus`, `Uncompacted write` | 6, 7, 10 |
| R-commandless | a step mentions a flag, route, CLI or file path but has no `command` | 3 |
| R-verify | no `verify` entry, or no step has `expect` | 4, 5, 9 |
| R-rollback | a runbook whose steps change state (`command` present) has no `rollback` | 9 |
| R-single-subject | `similarity(step, title)` below threshold for more than half the steps | 1, 2, 4, 5 |
| R-command-real | a command calls `/api/...` not in `mock/core/wire/snapshots/routes.json`, or a repo script path that does not exist | invented commands |
| R-length | title > 80, summary > 200, step `do` > 160 chars | run-on text |
| R-secrets | command text matches the secret patterns the BFF already redacts | leaked tokens |

### 2.4 How runs propose runbooks and edits

```ts
interface RunbookProposal {
  id: string;                               // prop-…
  kind: 'new' | 'edit' | 'retire';
  runbook_id: string | null;                // null for kind 'new'
  base_version: number | null;              // the version the diff was taken against
  proposed: RunbookDoc | null;              // null for 'retire'
  rationale: string;                        // one paragraph, in words
  source: { kind: 'run' | 'person'; run_ref?: string; session_id?: string;
            work_item_id?: string; person_id?: string; lab_experience_ids: string[] };
  lint: LintFinding[];                      // stored at write time; re-run on read
  similar: Array<{ runbook_id: string; score: number; reason: string }>;
  status: 'open' | 'accepted' | 'rejected' | 'merged';
  decided_by: string | null; decided_at: string | null; note: string | null;
  merged_into: string | null;
  created_at: string;
}
```

- **From a run.** The devbox CLI gains `lab propose <runbook-id|new> <file.md>`
  (and the brief tells the agent it exists, §3.3). A run that deviated from a
  runbook it was given, or solved something no runbook covers, writes the
  edited markdown; the CLI posts it with the run's attribution to
  `POST /api/runbooks/proposals` (service auth, the same signed envelope as
  `lab remember`). The middleware parses it (`parseRunbook`) and lints it.
  A run also reports, at the end, which runbooks it followed
  (`lab applied <id> followed|failed --step n`), which writes the
  `RunbookApplication` rows health is counted from.
- **From the local worker.** Same API, called by the worker after `claude -p`
  exits when the transcript contains a fenced ```` ```runbook ```` block (the
  brief asks for one when relevant). No model on the worker.
- **From a person.** "Suggest an edit" on any runbook opens the markdown in
  the editor; saving creates a `person` proposal.
- **Production extraction (optional, later).** If runs don't write proposals
  reliably, a nightly job may ask `amazon.nova-pro-v1:0` to draft a proposal
  from a run's transcript and its `lab_experiences`. Its output goes through
  the same parser and linter and lands as an ordinary open proposal — never
  directly into a runbook. The mock never calls a model.

**Review.** A proposal shows the unified diff of canonical markdown (base →
proposed), the lint findings, the source run and its notes, and similar
runbooks. A person with `ReviewRunbook` can **Accept** (writes version
`base_version + 1`; 409 if `base_version` is no longer current — the reviewer
rebases), **Reject** (note required), or **Merge into…** another runbook
(re-targets it as an `edit` on that runbook, keeping the source). Accepting a
`new` proposal creates the runbook as `published`, owned by the reviewer
unless they name an owner.

**Dedupe.** `similarity()` is deterministic and explainable, the same choice
`providers/promotions.ts` made: normalised-token Jaccard over title +
use_when + triggers, plus scope match. On write, a `new` proposal with a
score ≥ 0.5 against a published runbook in an overlapping scope is shown
as "Looks like rb-x (0.62: shares *tenant, cutover, cognito*)" with Merge
as the default action. No embeddings in v1.

**Retirement.** A `retire` proposal (from a person, or suggested by the
system when a runbook is `drifting` with ≥ 2 failed applications on its
current version and no open edit) needs `ReviewRunbook` to accept. Retired
runbooks are never selected for a brief, keep their history, and name what
superseded them.

### 2.5 Storage: one interface, two implementations

```ts
interface RunbookStore {
  getRunbook(id): Promise<Runbook | null>;
  listRunbooks(q: { scope?: Scope; status?: Status[]; text?: string; cursor?: string; limit?: number }): Promise<Page<Runbook>>;
  getVersion(id, version): Promise<RunbookVersion | null>;
  listVersions(id): Promise<RunbookVersion[]>;
  /** Conditional: fails with VersionConflict unless current_version === expected. */
  putVersion(v: RunbookVersion, expectedCurrent: number | null): Promise<void>;
  putRunbook(r: Runbook, expectedUpdatedAt: string | null): Promise<void>;
  putProposal(p): Promise<void>; getProposal(id); listProposals(q);
  appendApplication(a): Promise<void>; listApplications(runbookId, version?);
  putBrief(b: SessionBrief): Promise<void>;          // write-once (conditional on absence)
  getBrief(runRef): Promise<SessionBrief | null>;
}
```

- `RowsRunbookStore` over five registered fixtures (`runbooks`,
  `runbook-versions`, `runbook-proposals`, `runbook-applications`,
  `session-briefs`), so `POST /api/__mock/reset` undoes every write and
  scenarios (`default`, `empty`, `large`, `runbooks-demo`) work like the rest
  of the mock floor. Timestamps from `mock/core/clock.ts`.
- `DynamoRunbookStore` on `@aws-sdk/client-dynamodb` (already a middleware
  dependency). Chosen the way `lib/social-chat.ts` chooses its chat store:
  `RUNBOOK_STORE=dynamo|memory`, or dynamo when `RUNBOOK_DYNAMODB_ENDPOINT` /
  `RUNBOOK_TABLE` is set. Pointing the endpoint at managed-nosql-store
  (`:8000`) is the local durable setup; AWS DynamoDB is the cloud one.
  Single table:

  | PK | SK | Item |
  |---|---|---|
  | `RB#<id>` | `META` | Runbook (GSI1PK `SCOPE#<kind>#<ref>`, GSI1SK `<status>#<updated_at>`) |
  | `RB#<id>` | `V#<0000n>` | RunbookVersion |
  | `RB#<id>` | `APP#<at>#<appId>` | RunbookApplication |
  | `PROP#<id>` | `META` | Proposal (GSI2PK `PROPSTATUS#<status>`, GSI2SK `<created_at>`) |
  | `BRIEF#<runRef>` | `META` | SessionBrief |

  Accept is one `TransactWriteItems`: put `V#n+1` with
  `attribute_not_exists(PK)`, update `META` with
  `current_version = :base`, update the proposal with `status = 'open'`.
  That condition is what makes concurrent accepts safe.
- A shared contract suite runs against both. Nothing under
  `lib/runbooks`, `providers/runbooks*` or `routes/runbooks*` imports
  `aurora.js` or the RDS client (judge check). The table goes into
  `OrgIQ-Foundation` when the cloud is reachable again; that is not in scope.

---

## 3. Session injection: the session brief

### 3.1 What a brief is

```ts
interface SessionBrief {
  id: string;                       // brief-…
  run_ref: string;                  // agent_jobs id | devbox session id | local work id
  work_item_id: string | null; initiative_id: string | null; repo: string | null;
  assembled_at: string; assembler_version: string;   // bump when the rules change
  budget_tokens: number; used_tokens: number;
  sections: Array<{
    kind: 'framing' | 'work_item' | 'initiative' | 'decisions' | 'runbook' | 'how_to_report';
    ref: string | null; version?: number; tokens: number; reason: string;
  }>;
  omitted: Array<{ runbook_id: string; reason: 'budget' | 'drifting_excluded' | 'scope' }>;
  markdown: string; sha256: string;
}
```

Assembled **once**, at the moment the run is bound to a box: dispatch for
devbox runs, claim for local compute (the chokepoint `frameLocalPrompt`'s
doc comment already names). Stored write-once on the store and its id and
sha written onto the run (`agent_jobs.payload.brief_id`/`brief_sha`, and
`bot_runs.outcome.brief_id` on the governed path). The box fetches the frozen
brief by run; it never re-assembles. That is what makes "what was this run
told?" answerable after the fact, even after a runbook has moved on.

### 3.2 Selection rule (deterministic, pure, tested)

1. **Candidates**: `published` runbooks whose scope matches the run —
   `repo` = the work item's repo; `initiative` = its initiative; `tool` named
   in the work item's labels/description; `org` always eligible. `draft` and
   `retired` never.
2. **Pinned first**: a runbook a person attached to the work item (a
   `runbook_ids` link on the work item, same pattern as linked decisions) is
   always included and ordered first.
3. **Score** the rest: scope specificity (repo 3, initiative 2, tool 2,
   org 1) + 2 × label overlap with `triggers.work_item_labels` + 3 × keyword
   Jaccard between the work item's title/description and
   `title + use_when + triggers.keywords`; health proven +1, unproven 0,
   drifting −1. Drop anything with keyword Jaccard 0 and no pin or label hit.
4. **Order**: pinned, then score descending, then id.
5. **Budget**: default 6,000 tokens (`BRIEF_BUDGET_TOKENS`), estimated with one
   function (`estimateTokens`, chars/4, deterministic). Framing + work item +
   initiative + decisions are capped at 1,800 together (decisions newest
   first, truncated by whole decision). Runbooks fill the rest **whole or
   not at all**; a runbook that doesn't fit is listed under "Also available"
   by title with `lab runbook <id>` to fetch it. Never more than 4 runbooks
   in full.
6. **Drifting** runbooks are included with a one-line warning above them
   ("Last run failed at step 2: sign-in still pointed to the old service —
   check that step before relying on it").

### 3.3 The brief document

The contract test pins this exact text (§6.2). For `wi-auth-e2-s2` on the
demo world it reads:

````markdown
# Session brief — wi-auth-e2-s2

> Assembled 2026-10-14 for run job-… · 4,212 of 6,000 tokens ·
> brief-… sha 3f9c…

You are running non-interactively. […the existing frameLocalPrompt text,
unchanged, for local runs; the PIPELINE_CONTRACT for governed runs…]

## Your task
**Tenant-by-tenant cutover runbook with rollback** (story, 5 pts, Auth Migration)
Cannot be written until the cutover order is settled — smallest tenant first
or riskiest first is still escalated.
Labels: decom, runbook, blocked.

## The project
**Auth Migration** — repo connorhoehnslalom/orgiq-auth-service. Parent epic:
Legacy SSO decommission ("The SAML shim serves zero tenants and is deleted,
not paused").

## Decisions that bind this work
- **Cutover order for legacy SSO tenants** — escalated to an org-leader 2 days
  ago; not decided. Do not choose an order; write the runbook so the order
  is a parameter.
- **Sunset legacy auth service** — resolved 2026-01-30: migrate remaining
  services off the v1 auth gateway before Q3 2026.

## Runbooks for this work
### 1. Cut one tenant over from SAML to Cognito (rb-tenant-cutover v1)
Included because: initiative Auth Migration, labels *runbook, decom*, keywords
*tenant, cutover*.
⚠ Last run failed at step 2 (the flip): sign-in still pointed to the old service.

[the runbook's canonical markdown, verbatim]

### 2. Bring SSO up on a new origin without breaking the picker (rb-sso-new-origin v1)
[…]

Also available (not included, budget): rb-idle-teardown-proposal — `lab runbook rb-idle-teardown-proposal`.

## How to report back
- When you finish, say which runbooks you followed: `lab applied rb-tenant-cutover followed`
  (or `failed --step 2 "why"`).
- If a runbook was wrong or missing a step, write the corrected markdown to a
  file and run `lab propose rb-tenant-cutover ./runbook.md`. A person reviews it.
- Record anything else you learned with `lab remember`.
````

### 3.4 Delivery, per path

| Path | Today | Change |
|---|---|---|
| Devbox (AgentCore) | SessionStart `lab recall` (raw notes, wrong repo likely) | SessionStart `lab brief` → `GET /api/runs/:ref/brief` (service auth) prints the frozen markdown. `main.py` `handle()` accepts `run_ref`, `repo`, `initiative_id`, `work_item_id` in the payload and sets `LAB_*` in `_subprocess_env`, fixing attribution for every `lab` call. `lab recall` stays as a manual command. |
| Governed dispatch (`dispatch-work` → `executeProjectRun`) | bare `renderWorkItemPrompt` | `dispatchWorkItem` assembles and freezes the brief before `dispatchGovernedRun`, passes `run_ref`; the prompt stays the task, the brief arrives via the hook. |
| Job dispatcher (`agent_jobs` → devbox) | `payload.prompt` verbatim | Same: assemble at dispatch if `brief_id` absent, pass `run_ref`. |
| Local compute claim | `frameLocalPrompt(task)` | `frameLocalPrompt` becomes the `framing` section; the claim returns the brief markdown as the prompt with the task inside "Your task". Stored payload stays unframed, as today. |

### 3.5 Shown to humans as the same document

- **Run → Brief tab** (on the existing run/job surfaces): the frozen markdown
  rendered with `MarkdownView`, the sha, and a sections table (kind, ref,
  version, tokens, why included) plus the omitted list. A "Compare with the
  previous run on this work item" toggle shows the diff between two briefs.
- **Work item → Brief preview**: `GET /api/work-items/:id/brief-preview`
  assembles without storing, so a person sees what a box *would* get before
  dispatching, and can pin or unpin a runbook there.
- **Runbook → Used in**: the briefs that included each version, and the
  applications those runs reported.

The judge proves the box's bytes equal the portal's bytes by sha.

---

## 4. The UI

One destination, **Runbooks** (`/iq/runbooks`), replacing Distillation in
the IQ rail. The house layout cascade: primary rail → section rail → flush
list rail → content with the full breadcrumb first; conversations stay in the
far-right pane. Every element is a ui-components composite; the ones named
are exported by the installed dist (2.456.1) and must be re-verified against
`node_modules/.../dist` when built.

| Section rail entry | List rail | Content |
|---|---|---|
| **Library** | `ListRailLayout` list grouped by scope (Org / initiative / repo / tool) with `SearchInput`, a status filter (`WorkListFilters`), health dot per row | `EditorShell` record: breadcrumb `Runbooks / Auth Migration / Cut one tenant over…`, `DetailHeader` (title, owner, version, health pill), tabs **Read** (`MarkdownView scale="lg"` of the canonical markdown, "Copy markdown", drifting `Banner`), **History** (`VersionHistoryPanel` + `DiffViewer` between any two versions), **Runs** (`ProcedureSteps` with step outcomes from applications, run list), **Used in** (briefs table, `DataTable`). `ContextColumn`: provenance (`SourceList` of runs, sessions and lab notes), scope, owner, "Suggest an edit". |
| **Proposals N** | `ChangeReviewList` of open proposals (category = New / Edit / Retire, author = run or person, runbook title) | `ChangeReviewCard` with `DiffViewer` (unified diff of canonical markdown), lint findings as a `Banner` list, source run link, "Looks like rb-x" similar list; `VerdictPanel`-style Accept / Reject (note) / Merge into… for `ReviewRunbook`, `AccessNotice` otherwise. |
| **Briefs** | runs, newest first, with work item and sha | the frozen brief (`MarkdownView`), sections `DataTable`, omitted list, diff vs previous brief for that work item. |

Plus the two embeds in other pages: the run's **Brief** tab and the work
item's **Brief preview** disclosure (`Disclosure` + `MarkdownView`).

No graph canvases, tier strips, compaction buttons or sampling rates. The
one live element is the Proposals count on the rail (the existing gateway
channel pattern, one channel `orgiq:runbooks:proposals`, with polling when
there is no gateway). Any composite found missing during build (a token-budget
meter is the likeliest) is queued in `docs/ui-components-queue.md` and shipped
upstream first.

---

## 5. Recreating the existing procedural knowledge

The goal is that every piece of knowledge a person could have read in
Distillation is either a good runbook or deliberately not migrated, with a
reason in a report.

### 5.1 The migration (deterministic, no model)

`scripts/runbooks/migrate-distillation.mjs` reads the distillation fixtures
(or, with `--from-store`, any live distillation rows) and writes runbook seed
rows plus `docs/runbooks-migration-report.md`. Rules:

1. **Seeded artifacts with a hand rewrite** (`mock/runbooks.seed.ts`, keyed by
   source artifact id) are emitted from the rewrite. The rewrite is written by
   a person (or an Opus lane reviewed by a person) as a `RunbookDoc`, must
   lint clean, and keeps the source's owner, scope, review and run history as
   provenance and as applications on v1.
2. **Machine-minted artifacts** (`art-9xx` from compaction, `art-Lx` from the
   `large` generator) are **not migrated**: there is no human text to keep.
   Their cited `lab_experiences` remain evidence a future proposal can cite.
3. **Insights, conventions and decisions** become a runbook only when there is
   a procedure in them; otherwise they are reported as "not a procedure" and,
   where they bind work, re-homed as a decision on the initiative so they
   reach briefs through "Decisions that bind this work".
4. **Retired artifacts** are not migrated.
5. **Procedure applications** carry over as `RunbookApplication` rows on v1
   (`outcome` mapped succeeded→followed, failed→failed, abandoned→not_used),
   so health survives the move. A rewrite that renumbers steps carries an
   explicit `step_map` (source ordinal → new step): art-010's four facts
   become rb-tenant-cutover v1's three steps (confirm the shim answers; flip
   only this tenant's flag; sign in and check no session dropped), and
   `papp-006`'s failure at fact-020 (ordinal 3) lands on v1 step 2, the flip.
   v2 (the demo's accepted edit, §2.2) inserts the callback step as step 2.

The default corpus's 11 artifacts map as follows:

| Source | Runbook | Scope | Status |
|---|---|---|---|
| art-001 Rerun-and-diff triage | rb-flaky-test-rerun-diff "Tell a flaky test from a real regression" | repo orgiq-observability | published |
| art-002 Cold Aurora Data API | rb-aurora-cold-start-retry "Recover the first Data API call after idle" | tool aurora-data-api | published |
| art-003 Fargate tasks are ARM64 (insight) | rb-fargate-arm64-image "Deploy a Mac-built image to Fargate" | tool fargate | published |
| art-004 CSRF evaluator gate (decision) | rb-auth-pr-csrf-gate "Get an auth-service PR through the CSRF check" | repo orgiq-auth-service | published |
| art-005 PII scan before ingest (convention) | rb-ingest-pii-scan "Ingest a document into the knowledge base" | repo orgiq-llm-platform | published |
| art-006 StatsD decommission | rb-statsd-decommission "Move one service's metrics off StatsD" | repo orgiq-observability | draft (open review) |
| art-007 session_epoch (convention) | not migrated → decision on p-auth-migration | — | — |
| art-008 Serverless floors (retired) | not migrated (retired, superseded) | — | — |
| art-009 SSO on a new origin | rb-sso-new-origin | initiative p-auth-migration | published, proven |
| art-010 Tenant cutover | rb-tenant-cutover v1 (the demo's v2 adds the callback step) | initiative p-auth-migration | published, drifting |
| art-011 Idle-capacity teardown | rb-idle-teardown-proposal | initiative p-cost-opt | published, unproven |

Nine runbooks, two reported as not migrated, zero unaccounted. Commands in the
rewrites must pass R-command-real: they call routes in the wire snapshot,
scripts in the tree, or named AWS CLI commands.

### 5.2 Seeds for the other scenarios

- `empty`: no runbooks, so the Library shows its empty state and a brief has
  no runbook section ("No runbooks matched this work").
- `large`: 60 runbooks generated from a small table of real-sounding
  templates (task × tool × repo), each lint-clean; no filler strings.
- `runbooks-demo`: `default` plus the director's beats (§7).

---

## 6. End-to-end coverage

### 6.1 Executable journey maps

Family `runbooks`, maps under `docs/journeys/maps/runbooks/`, logs under
`docs/runbooks-journeys/`, a `PROFILES.runbooks` entry in
`scripts/journeys/maps.mjs`, routes added to `portal/e2e/route-inventory.ts`.
Walked by `run-maps.mjs` with `openAsClone` identities and a
`withMockScope` scenario so walks never touch shared state.

| Map | Persona | Steps it proves |
|---|---|---|
| `author/propose` | Nora DaSilva (u-nora, sme) | open rb-tenant-cutover → Suggest an edit → change step 2 → lint error shown for a step with no verb → fix → submit → proposal visible in Proposals with her name |
| `author/from-run` | API steps as the box (service auth) + u-nora | `POST /api/runbooks/proposals` with a run ref → proposal shows the run, its session and lab notes as provenance |
| `reviewer/accept` | Vera Green (u-vera, org-leader) | Proposals → open → diff shows the inserted step → Accept → History shows v2 by Vera from the proposal → Read shows v2 |
| `reviewer/reject-merge` | u-vera | reject with a note (note required); a near-duplicate `new` proposal shows "Looks like rb-x" and Merge re-targets it |
| `reviewer/stale-base` | u-vera | accept a proposal whose base moved → 409 rendered as "This runbook changed since the proposal; review the new diff" |
| `consumer/read` | Theo (u-theo, member) | Library → read a runbook start to finish; no review controls (`AccessNotice`); Copy markdown |
| `consumer/brief-preview` | u-theo | work item wi-auth-e2-s2 → Brief preview lists the two runbooks with reasons and the token count |
| `consumer/run-brief` | u-nora | dispatch wi-auth-e2-s2 → the run's Brief tab sha equals the preview's sha |
| `box/brief` | API only (service auth) | `GET /api/runs/:ref/brief` → bytes whose sha matches the run row; unsigned request → 401; another tenant's run → 404 |

Each surface map also records the usual fields (console errors 0, layout,
keyboard, empty state, dom-audit).

### 6.2 The injection contract

`docs/journeys/contracts/session-brief.json`:

```json
{
  "assembler_version": "1",
  "clock": "2026-10-14T09:00:00Z",
  "budget_tokens": 6000,
  "cases": {
    "wi-auth-e2-s2": {
      "sections": [
        {"kind": "framing"}, {"kind": "work_item", "ref": "wi-auth-e2-s2"},
        {"kind": "initiative", "ref": "p-auth-migration"},
        {"kind": "decisions", "ref": "d-cognito-cutover,d-legacy-auth"},
        {"kind": "runbook", "ref": "rb-tenant-cutover", "version": 1},
        {"kind": "runbook", "ref": "rb-sso-new-origin", "version": 1},
        {"kind": "how_to_report"}
      ],
      "omitted": [{"runbook_id": "rb-idle-teardown-proposal", "reason": "budget"}],
      "used_tokens": 4212,
      "sha256": "…"
    },
    "wi-auth-e2-b3": { "…": "the logout-cookie bug: rb-sso-new-origin only" },
    "wi-obs-e2-b4": { "…": "observability: rb-flaky-test-rerun-diff" },
    "wi-empty-scenario": { "…": "no runbook section" }
  }
}
```

A jest test assembles each case under `freezeClock` against the `default`
scenario and compares; a mismatch prints the unified diff of the markdown so a
reviewer sees what changed in words. The sha is re-recorded only by an
explicit `--update` that also writes the new markdown to
`docs/journeys/contracts/session-brief/<case>.md` — so the exact brief a box
receives for a work item is a reviewed file in the repo.

Plus unit tests for: round-trip render/parse on every seed; lint rule
coverage against the ten examples (as fixtures, verbatim); selection order
and budget edges (a runbook exactly at the boundary; pinned beyond budget);
accept's version condition on both stores.

---

## 7. Three-minute demo (a human can follow it)

`POST /api/__mock/scenario {"scenario":"runbooks-demo"}`, Tilt stack, signed
in as Nora DaSilva (u-nora) in one window and Vera Green (u-vera) in another
(or let the director decide for Vera after N beats, as the Computer Lab demo
does).

| Time | Where | What the viewer sees |
|---|---|---|
| 0:00 | Runbooks → Library | Nine runbooks grouped by scope. Open "Cut one tenant over from SAML to Cognito": it reads like a document — when to use it, checks, three steps with commands and expected results, what to do if it fails, how to roll back. A yellow banner: last run failed at step 2, the flip. |
| 0:30 | Work item wi-auth-e2-s2 → Brief preview | "This is exactly what a computer will be told." Task, project, the escalated cutover-order decision, the two runbooks with why each was picked, 4,212 of 6,000 tokens. |
| 0:50 | Computer Lab | Nora dispatches the item; Basil's computer boots. Open the run → Brief tab: same document, same sha. |
| 1:20 | Computer Lab | Basil works, hits the redirect problem at the flip, fixes it by updating the callback list first, reports `failed --step 2`, then proposes an edit. Proposals 1 appears on the rail. |
| 1:50 | Runbooks → Proposals (Vera) | The diff: a new step 2 with the `aws cognito-idp update-user-pool-client` command, a new failure-mode row. Provenance: Basil's run, its notes. Vera clicks Accept. History: v2, accepted by Vera, from Basil's run. |
| 2:20 | Computer Lab | The director dispatches the next tenant's cutover. Its Brief tab now carries v2; "Compare with previous brief" highlights the new step. |
| 2:45 | Runbook → Runs | The new run reports "followed v2"; the banner turns green: proven on the latest version. |
| 3:00 | — | Done. `POST /api/__mock/reset` puts everything back. |

The director signs in as real seed users and goes through the real routes,
like `mock/demo-director.ts`; it never writes a runbook row directly.

---

## 8. Build plan, lanes and deletions

The phased goal, judge outline, lane-by-model split and the full deletion
list are in `docs/distillation-runbooks-goal.md`. In short:

- **Opus**: the canonical model, linter and selection rule (lane A); the
  rewrites of the nine runbooks, because their prose is the demo (lane C);
  injection across dispatch, claim, the devbox hook and service auth
  (lane E); the injection contract test.
- **Sonnet**: the two stores and contract suite, the migration script, API
  routes (with an Opus review of the Cedar diff), the portal pages, the
  journey maps and demo director, and the deletion.
- **Deleted at the end**: the whole `/iq/distillation` portal module, the
  L0→L1→L2 compaction provider and its queue/realtime/replica plumbing, the
  distillation fixtures and demo, `schema/distillation*_schema.sql`, and the
  distillation docs (moved to `docs/history/`). `lab remember` and
  `lab_experiences` stay as evidence; `procedureHealth` moves; the
  promotions RUNBOOK rung becomes "proposal → runbook" while the SKILL rung
  stays in the Library.

## 9. Decisions owed by the user

1. **Who accepts.** Proposed: `ReviewRunbook` for `sme`, `program-owner`,
   `org-leader` in orgiq; the runbook's owner is suggested as reviewer but
   not required. Alternative: owner-only.
2. **Brief budget.** 6,000 tokens and at most 4 runbooks in full — is that
   the right weight for a Claude Code session start?
3. **Runbook vs Library skill.** Proposed: a runbook is the readable,
   reviewable procedure; a Library *skill* remains the invocable asset, and a
   skill may cite the runbook it implements. Alternative: make runbooks a
   sixth Library asset kind and drop the separate destination.
4. **Session bundles.** Proposed: the bundle keeps hooks and skills and gains
   `lab brief` as its SessionStart hook; briefs themselves are per-run, not
   per-bundle. Publishing that hook change goes through the bundle's existing
   dry-run + approver gate.
5. **Nova extraction.** Off until runs demonstrably fail to propose on their
   own? Proposed: off in v1.

### Decisions taken (user, 2026-10-14)

1. **Who accepts:** the runbook's owner or an SME on its initiative accepts
   (`ReviewRunbook`, scoped to the runbook's initiative); `org-leader` and
   `admin` can override. A proposer never accepts their own proposal.
2. **Brief budget:** 6,000 tokens, whole runbooks only.
3. **Runbook vs Library skill:** a runbook is its own destination; a Library
   skill may cite the runbook it implements (default taken by the coordinator).
4. **Session bundles:** the session brief replaces bundles as the one thing a
   box receives — the bundle's instruction content folds into the brief, and
   the `lab brief` SessionStart hook is the delivery mechanism.
5. **Nova extraction:** off for v1; runs and people propose explicitly.
