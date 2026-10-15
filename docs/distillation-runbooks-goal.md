# Goal (draft): runbooks a person can read and a booted box receives

**Status: DRAFT for review, 2026-10-14. Nothing here is built.** The design,
evidence and data shapes are in `docs/distillation-runbooks-design.md`; this
file is the definition of done once approved. When approved it replaces
`docs/distillation-goal.md`, and `scripts/validate-distillation-runbooks.sh`
(outlined below, not yet written) replaces `scripts/validate-distillation.sh`
as the only judge.

## The outcome in one paragraph

The fleet's procedural memory is a library of **runbooks**: markdown
procedures with a trigger, preconditions, numbered steps with commands,
verification, failure modes and rollback, an owner, a scope and a version
history. Runs propose new runbooks or edits as diffs; a person accepts,
rejects or merges them. When a box boots or a worker claims a job, the
middleware assembles a **session brief** (project context plus the selected
runbooks, under a token budget), freezes it on the run, and delivers exactly
that text; a person can open the run and read the same document. Every
existing procedural fact is recreated as a runbook by a deterministic
migration, and three roles' journeys plus the injection contract are
executable end-to-end tests.

## Rules that do not bend

- The judge is the script; a green claim it does not confirm is false.
- Storage-agnostic: every read and write goes through `RunbookStore`. The
  mock (`RowsRunbookStore` over registered fixtures) is the contract; the
  durable implementation is DynamoDB-wire (`DynamoRunbookStore`, run against
  managed-nosql-store locally). No SQL, no new Aurora schema.
- No model in the mock or in the migration. Production extraction, if any,
  uses `amazon.nova-pro-v1:0` (or `MODEL_ID`) only, and its output must pass
  the same linter a person's edit passes.
- The brief a box receives is byte-identical to the brief a person reads on
  the run (same sha256). It is assembled once, at claim, and frozen.
- ui-components composites only; a missing one is queued in
  `docs/ui-components-queue.md` and shipped upstream before the page uses it.
  No inline styles, no raw styled elements.
- No `npm install` in autonomous runs; no browser MCP tools in subagents
  (headless Playwright clones only).

## Phases

Each phase ends with its judge section green and a commit on main.

| Phase | Ships | Judge section |
|---|---|---|
| **R0 Model** | `lib/runbooks/` pure modules: `RunbookDoc` type, `renderRunbook()` (doc → canonical markdown), `parseRunbook()` (markdown → doc, round-trip exact), `lintRunbook()`, `similarity()`, `selectRunbooks()`, `assembleBrief()`, `estimateTokens()`. Unit tests only. | `model` |
| **R1 Store** | `RunbookStore` interface; `RowsRunbookStore` over five registered fixtures (`runbooks`, `runbook-versions`, `runbook-proposals`, `runbook-applications`, `session-briefs`) with `default`, `empty`, `large` scenarios; `DynamoRunbookStore` (single table, conditional writes) with a contract suite that runs the same tests against both (Dynamo leg skipped unless `RUNBOOK_DYNAMODB_ENDPOINT` is set). | `store` |
| **R2 Migration** | `scripts/runbooks/migrate-distillation.mjs`: reads the distillation fixtures (and, with `--from-store`, a live store), writes runbook seed rows + a migration report. Every published/draft procedure and runbook artifact becomes a runbook; insights/conventions/decisions become "Notes" sections attached to the runbook that cites them or are listed as not migrated with a reason. Hand-authored rewrites for the 11 seeded artifacts live in `mock/runbooks.seed.ts` and are what the migration emits for those ids. | `migration` |
| **R3 API** | `/api/runbooks` routes (list, read, versions, diff, proposals, accept/reject/merge, retire, applications) and `/api/runs/:ref/brief` (service-auth for boxes, session for people), `GET /api/work-items/:id/brief-preview`. Cedar actions `ReviewRunbook` and `ViewSessionBrief` added to `CAPABILITY_ACTIONS`. Wire snapshots in `mock/core/wire/snapshots`. | `api` |
| **R4 Injection** | Dispatcher and local-compute claim assemble and freeze the brief; devbox `lab brief` SessionStart hook replaces `lab recall`; local worker prepends the brief inside the existing non-interactive framing; `lab propose` and the run-end proposal path; application rows written when a run reports which runbook steps it followed. | `injection` |
| **R5 Portal** | `/iq/runbooks` (Library / Proposals / Briefs), the run's Brief tab, the work item's "Brief preview", all on library composites in the layout cascade. Old `/iq/distillation/*` routes redirect. | `portal`, `discipline`, `ia` |
| **R6 Journeys + demo** | Executable maps for author / reviewer / consumer and the injection contract; the demo scenario `runbooks-demo`; journey logs sealed. | `journeys`, `contracts`, `demo` |
| **R7 Deletion** | The distillation tier machinery and pages listed below are removed; `validate-distillation.sh` and its docs retired to `docs/history/`. | `deleted` |

## Judge outline: `scripts/validate-distillation-runbooks.sh`

Every line is mechanical. `--quick` skips the Playwright sections.

**model**
- `node --test` over `middleware/src/lib/runbooks/__tests__/*.test.ts` (or jest, per the middleware runner) passes.
- Round-trip: for every seed runbook, `parseRunbook(renderRunbook(doc))` deep-equals `doc`.
- Lint: every seed runbook passes `lintRunbook` with zero findings; a fixture of
  known-bad docs (the ten examples in the design doc, verbatim) each fails
  with the expected rule id.
- `selectRunbooks` and `assembleBrief` are pure: the test runs each twice on
  the same input and compares sha256.

**store**
- The shared contract suite passes against `RowsRunbookStore`.
- With `RUNBOOK_DYNAMODB_ENDPOINT` set, the same suite passes against
  `DynamoRunbookStore` (reported SKIP, not PASS, when unset).
- `grep` proves no file under `middleware/src/{lib,providers,routes}/runbook*`
  imports `aurora.js` or `client-rds-data`.
- Mock floor: `scripts/validate-mock-floor.sh` green; the five fixtures are
  registered and reset by `POST /api/__mock/reset`.

**migration**
- `node scripts/runbooks/migrate-distillation.mjs --check` exits 0: every
  distillation artifact id appears in the report as `migrated → rb-…` or
  `not-migrated: <reason>`; zero unaccounted.
- Every migrated runbook's `provenance.source_artifact_ids` names its source.
- No migrated runbook contains a string matching `(+\d+ more)`, `Load-corpus`,
  `; ` joining two sentences in a step, or a step without an imperative verb
  (lint rules R-joined, R-generated, R-imperative).

**api**
- Jest suites for every route under `/api/runbooks` and `/api/runs/:ref/brief`
  (the validator lists mounted routes without a test, as today's does).
- `ReviewRunbook` and `ViewSessionBrief` are in `CAPABILITY_ACTIONS` and in
  the orgiq Cedar seeds for the roles in the design doc.
- Accepting a proposal whose `base_version` is not current returns 409.

**injection**
- Contract: `docs/journeys/contracts/session-brief.json` holds, per seeded work
  item (at least `wi-auth-e2-s2`, `wi-auth-e2-b3`, `wi-obs-e2-b4`), the
  expected section list (kind, ref, version), the token count and the sha256
  of the markdown. A jest test assembles each under `freezeClock` and compares;
  any drift fails with a unified diff of the markdown.
- The dispatcher test proves a dispatched job row carries `brief_id` + `brief_sha`
  and that `GET /api/runs/:ref/brief` returns bytes with that sha.
- `agents/devbox/managed-settings.json` SessionStart runs `lab brief`, not
  `lab recall`; `agents/devbox/lab` has `brief` and `propose` subcommands;
  the local worker's prompt builder test shows the brief inside the framing.
- No brief exceeds its budget; no runbook in a brief is cut mid-step.

**portal / discipline / ia**
- `portal` tsc, `node --test` over `pages/runbooks/__tests__`, vite build.
- Component discipline: 0 raw styled elements, 0 `style={{` under
  `portal/src/pages/runbooks`.
- Routes `/iq/runbooks`, `/iq/runbooks/:id`, `/iq/runbooks/proposals`,
  `/iq/runbooks/briefs` exist in `App.tsx` and `route-inventory.ts`; every
  `/iq/distillation/*` path redirects (tested model).
- Rail/cascade/type-scale contracts measured for the new routes.

**journeys / contracts / demo**
- `node scripts/journeys/run-maps.mjs check runbooks` passes; `walk` passes
  for author, reviewer, consumer and the `box` API map.
- Logs under `docs/runbooks-journeys/{author,reviewer,consumer}/` are sealed
  and fresh (`jr_freshness`).
- `POST /api/__mock/scenario {"scenario":"runbooks-demo"}` reaches `done`
  under `DEMO_PACE_MS=200` in a jest test, and the brief the demo's second
  dispatch receives contains the version the demo's review accepted.

**deleted**
- The files listed under "Deleted" below are absent, and no source file
  imports them.

## Lanes

| Lane | Work | Model | Why |
|---|---|---|---|
| A — model | R0 pure modules + tests; lint rules from the ten bad examples | **Opus** | Defines the canonical format, the selection rule and the brief; every later lane builds to it |
| B — store | R1 interface, Rows + Dynamo stores, contract suite, fixtures | Sonnet | Mechanical against an agreed interface; the `social-chat.ts` store split is the template |
| C — migration + seed | R2 script; hand rewrites of the 11 seeded artifacts into runbooks (prose quality matters) | **Opus** for the rewrites, Sonnet for the script | The rewrites are the demo; the script is plumbing |
| D — API + authz | R3 routes, Cedar actions, wire snapshots | Sonnet, Opus review of the authz diff | Authz is a security boundary |
| E — injection | R4 dispatcher/claim freeze, `lab brief`/`lab propose`, worker framing, service-auth on brief fetch | **Opus** | Crosses service auth, the claim path and every running box |
| F — portal | R5 pages on library composites; queue any missing composite upstream first | Sonnet (one per destination) | Composites exist for most of it (`MarkdownView`, `ProcedureSteps`, `DiffViewer`, `ChangeReviewCard`, `VersionHistoryPanel`, `ExplorerLayout`, `EditorShell`) |
| G — journeys + demo | R6 maps, contract file, demo director, logs | Sonnet; Opus for the injection contract test | Contract test is the proof the user asked for |
| H — deletion | R7 | Sonnet | After G is green |

Order: A → (B ∥ C-script) → D → (E ∥ F ∥ C-rewrites) → G → H.

## Deleted when R7 lands

- Portal: `portal/src/pages/distillation/` entirely (Knowledge/Review/Activity,
  tier graph, run inspector, Sources lineage canvas, Explain composer, demo
  panel, eight models and their tests), `hooks/useDistillationChannel.ts`,
  the distillation entries in `portalCommands.ts` / `Layout.tsx`
  (replaced by Runbooks), `pages/library/DistillationProvenance.tsx`
  (replaced by "Runbook ↗" on the library asset when one exists).
- Middleware: `providers/distillation.ts` (L0→L1→L2 compaction, clusters,
  facts, tier health, sampling), `providers/distillation-store.ts`,
  `mock/distillation.ts`, `mock/distillation-demo*.ts`,
  `mock/distillation-queue.ts`, `lib/distillation-{queue,realtime,channels,events,replica}.ts`,
  the `orgiq:distill:*` channels, `routes/distillation.ts` (kept only as
  410/redirect shims for one release), their tests.
- Schema: `schema/distillation_schema.sql`, `schema/distillation_ops_schema.sql`
  (never the store of record for runbooks; unregister from `load_schema.py`).
- Overlapping memory stores folded in: `providers/promotions.ts`'s RUNBOOK rung
  becomes "proposal → runbook" (the SKILL rung stays in the Library);
  `providers/rediscovery.ts` keeps its ledger but searches runbooks.
- Docs to `docs/history/`: `distillation.md`, `distillation-goal.md`,
  `distillation-demo.md`, `distillation-redesign-spec.md`,
  `distillation-guide-record-*`, `distillation-concept-audit-2026-09-16.md`,
  `docs/distillation-journeys/`, `docs/journeys/maps/distillation/`.
- CLAUDE.md docs-map row for distillation → runbooks; validator count stays
  correct.

Kept: `lab remember` and `lab_experiences` as the raw run notes a proposal
cites (they are evidence, not memory that is injected); `procedureHealth`'s
proven/drifting/unproven rule, moved to `lib/runbooks/health.ts`.
