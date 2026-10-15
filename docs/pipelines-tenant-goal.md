# Goal: the `pipelines` tenant to its definition of done

`scripts/validate-pipelines-tenant.sh` is the only judge. Nothing in this
file is done until a line of that script says so; a check the script cannot
make is listed under "What the judge cannot see" rather than claimed.

Paste this as the `/goal`:

> Bring the `pipelines` tenant (`/pipelines/*`, `docs/social-tenant-design.md`
> §5) to its definition of done: `scripts/validate-pipelines-tenant.sh` exits
> 0. That script is the only judge. Work lane by lane — `--phase=P0`, then
> `P1`, `P2`, `E` — running it after every slice and treating each failing
> line as the next task. Use Opus subagents for slices that touch disjoint
> files (headless Playwright only, curl jars, no browser MCP); keep shared
> files (`session.ts`, `authz.ts`, `index.ts`, `App.tsx`, `Layout.tsx`,
> `portalCommands.ts`, `SelectContextPage.tsx`, `app.css`, the identity seed)
> to one owner at a time. No `npm install`. A primitive the library lacks is
> a row in `docs/ui-components-queue.md` and a library release first, never
> a hand-rolled page. Do not edit `portal/src` or `middleware/src` while a
> journey walker is running against the shared stack.

Sources, in the order they decide things: the user's words quoted in
[the design](social-tenant-design.md) §1; the design's decisions (§2 E1: a
tenant, `pipelines`, embedded later), §5 (the tenant), §6 (isolation), §7
(lanes P0 / P1 / P2 / E); [the research](social-tenant-and-pipelines-research-2026-09-29.md)
§A.4 (the 21 registration points, with file:line) and §D (D.1 the
run-shaped tables, D.3 the model and crosswalk, D.4 the phases and the first
slice). Where those left something open, this file decides it and says so
(marked **decided here**), so the judge has one reading to enforce.

## Running the judge

```bash
scripts/validate-pipelines-tenant.sh                 # the whole definition of done (P0 → E)
scripts/validate-pipelines-tenant.sh --phase=P0      # one lane; phases are cumulative
scripts/validate-pipelines-tenant.sh --quick         # skip jest, vite build, the venv test, neighbour judges
scripts/journeys/seal.sh docs/pipelines-journeys/<dir>  # seal journey logs — only after a real walk (docs/journeys.md)
scripts/validate-pipelines-tenant.sh --no-time       # skip the time gate (off unless PIPELINES_UNTIL=HH is set)
```

It prints every failing check, then `N CHECK(S) FAILING (judged through
phase X)`. `--quick` never turns a missing file green: a test that does not
exist fails in quick mode too; only the *running* of present suites is
skipped. Journey freshness and sealing follow docs/journeys.md (the
validator's `--seal` is retired; `scripts/journeys/seal.sh <dir>` seals one
directory after its walk, never to make a red freshness line go away).

## Cast (decided here)

Three seed users, one per role, holding a grant **only** in `pipelines`
(so the outbound isolation walks start from an identity with nothing
else), plus the existing cross-tenant operator. Ids chosen to collide with
neither the fourteen existing `app_users` nor the social cast.

| id | name | email | role |
|---|---|---|---|
| `u-ines` | Ines Moreau | `ines.moreau@orgiq.example` | `author` |
| `u-kofi` | Kofi Mensah | `kofi.mensah@orgiq.example` | `operator` |
| `u-dara` | Dara Whitfield | `dara.whitfield@orgiq.example` | `pipeline-admin` |
| `u-operator` | Platform Operator | (existing) | `admin` — gains `('u-operator', 'pipelines', 'admin')` |

The same three rows go in `schema/identity_schema.sql`, the
`providers/identity.ts` fallback (`grants: { pipelines: ['<role>'] }`), the
picker's `CURATED` list and the Cognito `seedUsers` in
`infra/lib/authentication-stack.ts`. The demo user gets no pipelines grant.

## P0 — registration + projection (lane P0)

### Registration: the 21 points of research §A.4

The judge greps the exact file each row names.

| # | File | Required |
|---|---|---|
| 1 | `middleware/src/lib/session.ts` | `'pipelines'` in `TENANTS`; `pipelines: ['author', 'operator', 'pipeline-admin']` in `ROLES_BY_TENANT`; the three in the `Role` union; a `ROLE_RANK` entry each |
| 2 | `middleware/seeds/roles/pipelines/{author,operator,pipeline-admin}.cedar` | each permit conditioned `principal.role == "<role>" && principal has tenant && principal.tenant == "pipelines"`; the forbids below; no orgiq/assessment Cedar file names a pipelines action |
| 3 | `middleware/seeds/schema.json` | `ViewPipelines`, `AuthorDefinition`, `RunPipeline`, `ApproveStep`, `CancelRun`, `ManagePipelineConfig` |
| 4 | `middleware/src/lib/authz.ts` `CAPABILITY_ACTIONS` | all six (an unlisted action hides its control for every role — CLAUDE.md) |
| 5 | `middleware/src/lib/role-registry.ts` `PRESENTATION` | `author`, `operator`, `'pipeline-admin'` |
| 6 | `schema/identity_schema.sql` | `('pipelines', 'Pipelines')`; the cast's three `app_users` rows and grants; `u-operator`'s admin grant |
| 7 | `middleware/src/providers/identity.ts` | `FALLBACK_TENANTS` + `FALLBACK_USERS` mirror 6 |
| 8 | `middleware/src/index.ts` | `app.use('/api/pipelines', requireTenant('pipelines'), …)` — at the mount, since the tenant has no machine callback of its own |
| 9 | `routes/agents.ts` `agentTenant()`, `tenant_guard.py` | **n/a** — the tenant owns no agents; it *records* the other tenants' agents (P1). The judge prints this row as n/a |
| 10 | `middleware/src/mock/core/parity/entities.ts` | `tenants` still pinned (it reads `listTenants()`, so it now covers `pipelines`); a new entity `name: 'pipeline runs'` whose mock rows are `lib/pipeline-runs.ts` over the fixtures and whose seed rows are the same projection over the SQL seed — "mock and Aurora" from the design's P0 judge |
| 11 | `portal/src/lib/auth.tsx:9`, `components/shell/Layout.tsx:64`, `components/shell/portalCommands.ts:23` | `'pipelines'` in all three `Tenant` unions |
| 12 | `portal/src/lib/tenantHome.ts` | `pipelines: '/pipelines/runs'`; any `pipelines.*` localStorage key a page adds is cleared by `tenantCaches.ts` |
| 13 | `portal/src/lib/features.ts`, `App.tsx` | `PIPELINES_ENABLED` from `VITE_ENABLE_PIPELINES`, honoured by the route tree |
| 14 | `Layout.tsx` | `NAV_ITEMS` rows `tenant: 'pipelines'` in groups Catalog, Runs, Sources, System; `TENANT_LABELS.pipelines = 'Pipelines'` |
| 15 | `portalCommands.ts` | `GROUP_ORDER_BY_TENANT.pipelines = ['Catalog', 'Runs', 'Sources', 'System']`; ≥10 palette rows, covering `/pipelines/{definitions,runbooks,runs,approvals,artifacts,agents,bots,commands,configuration}` |
| 16 | `portal/src/App.tsx` | `path="pipelines"` under `RequireTenant tenant="pipelines"` |
| 17 | `portal/src/pages/SelectContextPage.tsx` | `TENANT_META.pipelines`, `ROLE_META` for the three roles, the cast in `CURATED`, a `tenant === 'pipelines'` glyph in `TenantMark` |
| 18 | `portal/src/app.css` | `[data-tenant="pipelines"]` light block and `html[data-theme="dark"][data-tenant="pipelines"]` dark block |
| 19 | `infra/lib/authentication-stack.ts` | the cast's three emails in `seedUsers` |
| 20 | `scripts/validate-newsroom-removal.sh` | no longer pins the exact two-tenant list (`TENANTS = ['orgiq', 'assessment']`, `Tenant = 'orgiq' \| 'assessment'`) — re-pointed at "no newsroom" (research §A.3); this goal doc exists |
| 21 | `CLAUDE.md`, `docs/assessment-tenant.md` | CLAUDE.md names `` `pipelines` `` with `` `author` `` / `` `operator` `` / `` `pipeline-admin` ``; its docs map has a row `pipelines-tenant-goal.md` → `validate-pipelines-tenant.sh`; its "(N validators)" equals `ls scripts/validate-*.sh`; `assessment-tenant.md`'s header stops calling it "the second tenant" |

Nine pages (row 15) are owed as routes in P0 even though Definitions,
Runbooks and Approvals only get data in P2: a route in the palette that
404s fails `validate-nav-parity.sh`. Until P2 they are honest empty states.

### Cedar: separation of duties (decided here)

The design names what each role *does*; the forbids follow the shape of
`assessment/assessor.cedar` (a role is forbidden the decision it must not
make about its own work):

| role | permit | forbid |
|---|---|---|
| `author` | `ViewPipelines`, `AuthorDefinition`, `RunPipeline` (the dry-run) | `ApproveStep`, `CancelRun`, `ManagePipelineConfig` — never approves a step of a definition they wrote |
| `operator` | `ViewPipelines`, `RunPipeline`, `ApproveStep`, `CancelRun` | `AuthorDefinition`, `ManagePipelineConfig` — never writes the definition they approve |
| `pipeline-admin` | operator's four + `ManagePipelineConfig`, `ManageUsers` ("configuration and tenant users", design §5.1) | none on `ManagePipelineConfig` — top of the ladder, like `program-lead` |

### The projection: `middleware/src/lib/pipeline-runs.ts`

Pure (no express, no route, no Aurora import): rows in, `Run`s out, using
the research's D.3 model verbatim. `status` is pipeline-runtime's nine
(`pending running awaiting_approval paused_at_breakpoint completed rejected
failed cancelled stuck`); the crosswalk is D.3's (`queued→pending`,
`claimed|running→running`, `awaiting_review→awaiting_approval`,
`done|succeeded|completed→completed`, `skipped→cancelled`,
`blocked→rejected`, `failed→failed`, `cancelled→cancelled`). The original
status survives as `context.sourceStatus` (D.4's risk: a skipped bot run is
not a cancellation in intent).

**"Once" (decided here).** D.3 folds some rows into another row's run: a
`bot_runs` row with a `job_id` is that job's *trigger record*, and one with
a `run_id` is the trigger of that `agent_project_runs` run. So "every seed
row appears exactly once" means: every row of the five sources is named in
exactly one Run's `context.sources[]` (`{ table, id, status }`), the Run is
keyed on its primary row, and `context.sourceStatus` is the primary row's
status. A bot run with neither id is a Run of its own.

**The property test** is `middleware/src/lib/__tests__/pipeline-runs.projection.test.ts`.
It imports the registered fixtures — `agentJobs` (`mock/agent-jobs.ts`),
`botRuns` (`mock/bots.ts`), `agentProjectRuns` (`mock/agent-project-runs.ts`),
`runsFixture` (`mock/assessment.ts`, the `assessment_runs` rows) and the
seeded invocation traces (`mock/observability.ts`; the compaction history
left with the distillation tier machinery in R7) — runs
the projection, and asserts: each `(table, id)` occurs in exactly one Run;
every Run's status is one of the nine; every `context.sourceStatus` equals
the source row's own status; every Run carries `context.tenant` (`orgiq` for
the four orgiq tables, `assessment` for `assessment_runs`). The judge runs it
in non-quick mode and checks it names all five fixtures and `sourceStatus`.

### Routes: `middleware/src/routes/pipelines.ts`

Mounted at `/api/pipelines` under `requireTenant('pipelines')`, reads gated
on `requireAction('ViewPipelines')`:

- `GET /runs` — list (filters: `status`, `kind`, `contextTenant`)
- `GET /runs/:id` — one Run with `context`
- `GET /runs/:id/steps` — its Steps
- `GET /runs/:id/events` — SSE (`text/event-stream`), frames named from
  event-catalog (`pipeline:run:*`, `pipeline:step:*`), folding
  `/api/work/events` and the box tail as D.4 says

Tests in `middleware/src/routes/__tests__/pipelines.test.ts`: every route in
the router is called (the judge's route↔test parity, same method as the
assessment judge); an outside role (`member`, `assessor`) gets 403; the
events route answers `text/event-stream`.

### The vertical slice (research D.4)

*A maintenance bot's cron firing, rendered Run → Steps → Artifact → Events
on the bot detail page* (`portal/src/pages/bots/BotDetailPage.tsx`, which
already mounts `RunTimeline`): `bot_runs` as the trigger record,
`agent_jobs` as the run, `agent_change_requests` as the `change` artifact,
the work events as the stream.

**Decided here — where the bot page reads from.** The bot page is an orgiq
page; an orgiq session is refused at `/api/pipelines/*` by design. So the
slice reads through a context-filtered **façade**, `GET /api/runs` (same
four sub-routes) mounted under `requireTenant('orgiq')` and returning only
runs whose `context.tenant` is `orgiq` — the "binding, read through
`requireTenant`" of design §5.1, landed early for this one page. Its test is
`middleware/src/routes/__tests__/runs-facade.test.ts` (orgiq sees only
orgiq-context runs; an assessment or pipelines role gets 403). The page
renders `data-testid` `pipeline-run`, `pipeline-steps`, `pipeline-artifacts`,
`pipeline-events`. The walk is logged at `docs/pipelines-journeys/slice/bot-detail.md`
as `u-nora` (sme) with `run-rendered: yes`, `steps-rendered: <n ≥ 3>`,
`artifact-rendered: yes`, `events-streamed: yes`, plus the usual `verdict`,
`console errors: 0`, `screenshot`, `pages:`.

### Pages: `portal/src/pages/pipelines/`

P0 owes `RunsPage.tsx` (a `DataTable`), `RunDetailPage.tsx`
(`RunTimeline` from `components/runs/RunTimeline.tsx` with the same four
test ids) and `ArtifactsPage.tsx` (a `DataTable`), plus empty-state pages for
the other routes, and at least one node test under `__tests__/`.
Composition rules (the judge's zeros): no raw styled element by the
assessment judge's line regex **and** by `validate-component-discipline.sh`'s
brace-aware walker (the line regex cannot see past `=>`); no raw `<button>`;
no `style={{}}`; no `/iq`, `/admin`, `/assessment` or `/social` path; no
`integrations/realtime-modules` import. The only exemption is a
`Composed locally in \`portal/src/pages/pipelines/…\`` row in
`docs/ui-components-queue.md`. The design's composites are the library's
pipelines domain (`PipelinesListView`, the run-draft composites,
`usePipelineCatalog` in the installed client) — no new domain types.

### Journeys and isolation

`docs/pipelines-journeys/PROTOCOL.md` is the walk (adapted from the
assessment protocol: same log fields, same `pages:` freshness rule, same
two console-measurement traps). Logs `docs/pipelines-journeys/<role>/<surface>.md`
+ screenshot for roles `author operator pipeline-admin admin`:

- P0 surfaces: `runs run-detail artifacts agents bots commands configuration`
  (28 logs)
- P2 surfaces: `definitions runbooks approvals` (12 logs)

Isolation (`docs/pipelines-journeys/isolation/`):

- **Inbound** — `<role>.md` for each orgiq role (`member sme program-owner
  org-leader hr-admin`), each assessment role (`assessor lead-assessor
  program-lead`) and, once `social` is in `TENANTS`, each social role
  (`participant moderator community-admin`): `pipelines-tile-visible: no`,
  `pipelines-nav-visible: no`, `direct-route-result: not-found|redirect`,
  `api-status: 403`, `events-status: 403` (the SSE route is its own door),
  `verdict: pass`, `screenshot:`.
- **Outbound** — `<role>-outbound.md` for `author operator pipeline-admin`:
  `other-nav-visible: no`, `iq-route-result`, `iq-api-status: 403`,
  `assessment-route-result`, `assessment-api-status: 403`, and once social
  exists `social-route-result`, `social-api-status: 403`.

The social half is gated on `social` appearing in `session.ts` `TENANTS`,
because lane S0 is running in parallel and a walk into a tenant that does
not exist proves nothing. The judge says which case it is on every run.

Every log is held to its walked routes' rendered contract as sealed in
`docs/pipelines-journeys/.contract-sha` (docs/journeys.md; written only by
`scripts/journeys/seal.sh`).

### Neighbour judges (non-quick)

`validate-newsroom-removal.sh --quick`, `validate-nav-parity.sh --quick`,
`validate-route-coverage.sh`, `validate-mock-floor.sh --quick` must exit 0.
A third tenant is exactly the change that turns them red for reasons
outside this file.

## P1 — the agent half (lane P1): every fleet invocation is a run

Rule 2 of design §5.2. The AG-UI run id rides the trace bundle; `STEP_*`
are its steps, `TOOL_CALL_*` attempts on them, the trace its artifact.

- `agents/_shared/instrumentation.py` puts `runId` (from `RUN_STARTED`) in
  the bundle; `agents/tests/test_trace_run_id.py` pins it (run in
  `.venv-synth`).
- `schema/observability_schema.sql`: `observability.invocation_traces` gains
  `agui_run_id` (not `run_id` — that name is `test_runs`' primary key in the
  same file). `middleware/src/lib/trace-sink.ts` reads `runId`.
- `lib/pipeline-runs.ts` projects invocations as `kind: 'agent'` runs with
  steps from `STEP_STARTED/FINISHED`, attempts from `TOOL_CALL_*`, and a
  `'trace'` artifact.
- `middleware/src/lib/__tests__/pipeline-runs.agent.test.ts`: a bundle with
  a `runId` becomes exactly one agent Run with its steps and one trace
  artifact; a bundle without one is **counted as unlinked, not dropped**.
- The harness suites (`harness-mock.test.ts`,
  `harness-runner-service-auth.test.ts`) and `validate-agent-eval.sh`
  (golden runner, structural) stay green.

## P2 — definitions (lane P2): a RUNBOOK needs a run to become a SKILL

Rule 1 of design §5.2.

- `schema/pipeline_schema.sql`: `pipeline_definitions`, `pipeline_runs`,
  `pipeline_steps`, `pipeline_artifacts` (`CREATE TABLE IF NOT EXISTS`);
  a status CHECK with the nine statuses, a definition `kind` CHECK with
  `runbook agent bot assessment-command compaction`, an artifact `kind`
  CHECK with `change document scores trace transcript image`, and
  `context_tenant` on runs. A parity entity `pipeline_definitions` in
  `entities.ts`; a registered fixture `middleware/src/mock/pipeline-definitions.ts`.
- `providers/promotions.ts` carries `dryRunRunId` (the run, not a bare
  `dryRunPassed` boolean). `middleware/src/lib/__tests__/promotion-requires-run.test.ts`
  covers four cases: no run → refused; a run not `completed` → refused; a
  completed run of *another* definition → refused; a completed run of its
  own definition → promoted.
- Routes `/api/pipelines/definitions` and `/approvals`; writes gated on
  `AuthorDefinition`, approval decisions on `ApproveStep`, cancel on
  `CancelRun`, configuration on `ManagePipelineConfig`.
- `DefinitionsPage`, `RunbooksPage`, `ApprovalsPage` read `/api/pipelines/*`;
  the P2 journey logs pass.

## E — embedding (lane E)

- orgiq: a `Runs` rail entry at `/iq/runs` in group **Operate** and in the
  palette, reading the `/api/runs` façade from P0.
- assessment: the existing Activity page (`/assessment/runs`) is re-fed from
  `GET /api/assessment/pipeline-runs` — **decided here**: that name, because
  `/api/assessment/runs` is already the `assessment_runs` ledger. The
  façade test asserts the context-tenant filter.
- No orgiq or assessment page calls `/api/pipelines/*`.
- `validate-assessment-tenant.sh --quick --no-time`,
  `validate-orgiq-audit.sh --quick` and `validate-rail-parity.sh --quick`
  exit 0 — design §6's "every existing walk stays green".

## What the judge cannot see

Said plainly so nobody reads a green run as more than it is:

- **Aurora, live.** The projection is judged over fixtures and the SQL seed
  (the parity entity); no check runs SQL against a cluster. The design's
  "mock and Aurora" is satisfied only as far as the parity harness is.
- **Execution.** Design §5.4: the tenant records, it does not execute. No
  check starts a real cron firing; the slice log is the evidence it rendered.
- **Whether a forbid is the *right* forbid.** The judge greps that the
  separation-of-duties forbids exist; that they match the user's intent is
  the table above, which is this file's reading of design §5.1.
- **"`LabelFeedback` unblocked"** (lane P1's note) has no mechanical
  definition beyond the run id reaching the bundle; it is not judged.
- **Who approves a step when a definition names no role** is undecided in
  the design (§8, proposal `operator`); the judge only requires
  `ApproveStep` to be gated.
- **PipelineBridge / DAG definitions** (research D.4 phase 3, design §5.4
  "last phase") have no lane in design §7 and so no check here.
- **Brand hue.** The design proposes none for pipelines; the judge requires
  the two token blocks, not a colour. `validate-branding.sh` owns contrast.
- **The social cast collides with an existing id.** Design §4.1 names the
  social moderator `u-theo` (Theo Lindgren); `u-theo` is already Theo Chang,
  the orgiq member. Not this tenant's defect, but the social inbound
  isolation logs here assume whatever id lane S0 settles on.
