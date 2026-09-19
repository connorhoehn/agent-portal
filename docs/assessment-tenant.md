# Assessment tenant — reverse-engineering `agentic-assessment-accelerator`

The second tenant (it was the third until the newsroom tenant was removed —
see `docs/newsroom-removal.md`). Source repo: `~/Projects/agentic-assessment-accelerator`
(SDLC Assessment Dashboard). This doc is the contract every piece of the port
builds against — the domain model, the two layouts worth keeping, the Cedar
roles, the mock-route surface, and the agentic seam. Read this before touching
`middleware/src/{routes,providers,mock}/assessment*` or `portal/src/pages/assessment/`.

## What the source app is

An **assessment team's cockpit** for engineering-maturity assessments. Teams are
scored against a **17-dimension × 6-level (0–5)** rubric using self-assessment
surveys, interview transcripts and documents as evidence, with full provenance.
Enterprise teams never touch it — they interact through Forms, Teams meetings
and Confluence; the cockpit is where the assessment team ingests, scores,
publishes and drafts follow-ups.

Two planes, one boundary:

- **All LLM work is slash commands** (`.claude/commands/*.md`, run via
  `claude -p` headless). Nine commands: `classify-transcript`,
  `score-dimensions`, `extract-enterprise-context`, `validate-outputs`,
  `process-self-assessment`, `develop-jira-story`, `draft-confluence-page`,
  `suggest-confluence-content`, `draw-diagram`.
- **All Python is deterministic** — file I/O, validation, persistence. A command
  never persists scored state; it writes JSON to a temp file and a
  deterministic *verb* (`assess apply-scores` …) validates and applies it.
- **The filesystem is the store**: `workspace/teams/<TEAM-ID>/`, `workspace/runs/`,
  `roster.json`, all git-tracked.

The scoring stance is the part that gives the product its character and MUST
survive the port verbatim:

- **Two-track certification, never one number**: `claimed_level` (what the
  team's self-rating implies) vs `verified_level` (what evidence establishes).
  A gap ≥2 is normal and is reported as `claim_open`, never "capped".
- **Confidence is computed from evidence class, not vibes**: Attested (0.3) /
  Documented (0.5) / Observed (0.9); +0.1 when independent classes agree, −0.2
  when they conflict; bands <0.40 low · 0.40–0.69 moderate · 0.70+ high.
- **Levels 4–5 are exceptional**: L4 needs Observed evidence; L5 needs Observed
  sustained over time. A self-rating alone caps at 3.
- **N/A is never self-granting**: exceptions come from an archetype registry
  and need human approval.
- **Recommendations are computed, never re-derived by an agent**, and come in
  three kinds: *close the claim* (evidence ask), *advance the practice* (real
  work), *answer the question* (unassessable yet). Never promise a level, never
  estimate human effort.

## Domain model (the mock must mirror this exactly)

```
Team           TEAM-0NN · name · cohort (white_glove|self_service|general) · status
               · workflow_step (1–6) · assessment_lead · contacts[] · repos[]
               · archetype · exceptions[] · certification (rollup)
Assessment     team_id · rubric_version · dimensions{ "1".."17" → DimensionScore }
DimensionScore current_level 0–5|null · is_na · confidence low|moderate|high
               · self_claimed_level · evidence_class · cap_applied
               · evidence[] · follow_up_questions[] · history[]
Evidence       EV-xxxx · source_type (survey|transcript|document|artifact)
               · excerpt (VERBATIM) · supports_level · source_ref → Provenance
Provenance     PROV-xxxx · source_uri · captured_by · captured_at
FollowUp       Q-xxxx · text · status OPEN|ANSWERED|DROPPED
Submission     sub-<stamp>-form<Id>-<submitter>[-rN].json  (Forms envelope)
Run            run-<stamp>-<command>-<hex> · status running|completed|failed
               · command · team_id · started_at · finished_at · owner/worker pids
Recommendation kind close_claim|advance|answer · dimension · rank · rationale
Story          drafted from one recommendation; status pushed|blocked|ready
Knowledge      sections[] (local|synced) → nodes[] (dir/doc/page) → doc markdown
```

The 17 dimensions, by id:

| id | title | id | title |
|---|---|---|---|
| 1 | Continuous Integration (CI) | 10 | Monitoring, Observability & Runtime Security |
| 2 | Continuous Delivery (CD) | 11 | Environment Management |
| 3 | Automation | 12 | Release Management & Operational Reliability |
| 4 | Source Control & Traceability | 13 | Platform Reusability & Patterns |
| 5 | Testing & QE – Automated Testing | 14 | Software Development Mindset & Automation Culture |
| 6 | Testing & QE – Security Testing | 15 | Agile Planning & Backlog Management |
| 7 | Testing & QE – Performance & Reliability Testing | 16 | Design Standards & Technical Decision Process |
| 8 | Security Control SDLC & Code Review Practices | 17 | Engineering Metrics & Continuous Improvement |
| 9 | Engineering Governance | | |

Levels: 0 Below Baseline · 1 Initial · 2 Developing · 3 Defined · 4 Measured · 5 Optimizing.
Workflow steps (6): Intake → Classify → Score → Review → Publish → Follow-up.

## The two layouts worth keeping

These are why the user wants this ported. Reproduce the *structure*; re-skin
with `@connorhoehnslalom/ui-components` — no MUI, no hand-rolled divs.

### Assessment page (`/teams`) — three views in one URL

```
cohort landing  ──▶  team list (per cohort or all)  ──▶  team scorecard
   ?                     ?cohort=<key>                    ?team=<id>&tab=<tab>
```

Sticky breadcrumb `Assessment › <Cohort> › TEAM-002 › <Dimension>` — the
dimension crumb is *live*: clicking it collapses the master-detail selection
via an imperative handle, so the crumb reflects state it doesn't own.

**Team scorecard** = slim header bar (cohort kicker · team name · status/lead/
updated · certification headline + subline · `N/17 assessed` · `N open
follow-ups` · Report · + Add evidence · actions menu) → tab strip
(Certification · Improvement Plan · Stories · Evidence & Intake · Documents)
with **all panes kept mounted** (`hidden`) so selection/form state survives
tab round-trips → Certification pane = compact **workflow stepper strip** +
**DimensionMasterDetail**.

**DimensionMasterDetail** is the centrepiece:

```
┌─ rail (340px, collapsible to 72px, persisted) ─┬─ detail pane ──────────────┐
│ 17 DIMENSIONS                        [‹]        │ compact header             │
│ 01  Continuous Integration    low   [L3]        │ tabs: Progress & follow-ups│
│ 02  Continuous Delivery       mod   [L2]        │       How it was assessed  │
│ 03  Automation                —     [N/A]       │       Evidence             │
│ …   (border-l-4 selection, two-digit index,     │       Definition & rubric  │
│      confidence label hidden <lg, LevelBadge)   │       History              │
└─────────────────────────────────────────────────┴────────────────────────────┘
```

Port to ui-components: `RailLayout`/`RailSection` for the shell, a new
`MasterDetail` primitive if none fits (rail + pane with collapsible rail),
`Tabs`/`TabPanel` inside the pane, `Chip` for LevelBadge, `Breadcrumbs`.

### Workspace page (`/workspace`) — three-pane document explorer

```
┌─ left rail 300px ─┬─ main pane (flex-1, paper bg) ─────────┬─ activity bar (xl+) ─┐
│ SectionRail ×N    │ Home › Workspace › <doc title>          │ per-page activity    │
│  ├ tree rows      │ [published banner]                      │ (only for synced     │
│  ├ Views block    │ DocView | PageView | CommentsTable |     │  Confluence pages)   │
│  │  · All comments│ ActivityStrip                           │                      │
│  │  · Activity    │                                          │                      │
│  └ + New page     │ empty: "Select a document…"             │                      │
└───────────────────┴──────────────────────────────────────────┴──────────────────────┘
```

Sections are `local` (enterprise context, rules, prompts — editable via
`PUT /knowledge/doc`, versioned) or `synced` (Confluence spaces — pull-only,
publish is explicit). Rows: `border-l-2` selection, 20px leading slot,
trailing count chip on view rows. Below `xl` the activity bar stacks under the
page rather than crushing the content column.

Port: `RailLayout` + a tree primitive (`KnowledgeTree` if ui-components has
one, else add it) + `DocView` on the library's markdown renderer + the
existing `ActivityFeed`.

### Everything else in the nav (port as secondary, mock-backed)

Assess: Dashboard, Submissions (wizard: Drop → Preview → Fetch links → Run
prompt) · Analyze: Reports, Feedback (open follow-ups across teams) ·
Informatics: Enterprise, Workspace, Prompts, Rules · System: Activity (runs),
Configuration (motions/cohorts, target level).

## Tenant wiring in THIS app

Follow the same pattern as the `orgiq` tenant wiring — the proven shape for a
second tenant.

| Concern | Where | Change |
|---|---|---|
| Tenant id | `middleware/src/lib/session.ts` `TENANTS` | add `'assessment'` |
| Roles per tenant | same file `ROLES_BY_TENANT` + `Role` type | `assessment: ['assessor', 'lead-assessor', 'program-lead']` |
| Cedar policies | `middleware/seeds/roles/assessment/*.cedar` | one file per role, condition on `principal.tenant == "assessment"` |
| Cedar actions | `middleware/seeds/schema.json` | add `ViewAssessment`, `ScoreAssessment`, `ApproveException`, `PublishReport`, `ManageSubmissions`, `RunAssessmentAgent`, `ManageKnowledge`, `ManageAssessmentConfig` |
| Role labels | `middleware/src/lib/role-registry.ts` `PRESENTATION` | three entries |
| Mock identity | `middleware/src/providers/identity.ts` `FALLBACK_USERS` + tenants list | tenant row + 3 users |
| Routes | `middleware/src/index.ts` | `app.use('/api/assessment', requireTenant('assessment'), …)` |
| Portal tenant | `portal/src/lib/auth.tsx` `Tenant`, `Layout.tsx` NAV_ITEMS + tenant label, `features.ts` `ASSESSMENT_ENABLED` | own feature flag |
| Route tree | `portal/src/App.tsx` | `/assessment/*` under an `AssessmentLayout` (SubNavLayout) |
| Context picker | `portal/src/pages/SelectContextPage.tsx` | second workspace tile |
| Agents | `agents/assessment-*` + `agents/_shared` | in-agent tenant floor (`tenant_guard.py`); nova-pro |

### Roles (Cedar)

| role | grants | forbids |
|---|---|---|
| `assessor` | ViewAssessment, ScoreAssessment, ManageSubmissions, RunAssessmentAgent, Search, LabelFeedback | ApproveException, PublishReport |
| `lead-assessor` | everything an assessor has + ApproveException, PublishReport, ManageKnowledge, ViewObservability | ManageAssessmentConfig |
| `program-lead` | everything + ManageAssessmentConfig, ManageUsers-scoped | — |
| `admin` (cross-tenant) | `*` | — |

Separation of duties mirrors the source: an assessor *drafts* stories and
*proposes* N/A exceptions; approving either is a lead's call. Publishing a
report is a lead's call. Changing the rubric target level is program-lead only.

### Mock routes (`/api/assessment/*`, MOCK_AURORA path is the one that must work)

Mirror the source API 1:1 where the portal needs it. Shapes come from
`ui/src/components/assessment/types.ts` and `knowledge/types.ts` in the
source repo — copy them into `portal/src/pages/assessment/types.ts`.

```
GET  /teams                                   TeamSummary[]
POST /teams                                   create (deterministic id TEAM-0NN)
GET  /teams/:id                               TeamDetailResponse {team, workflow_steps, dimensions[17]}
PATCH/DELETE /teams/:id
POST /teams/:id/reset-assessment
GET  /teams/:id/recommendations               ranked plan (three kinds)
GET  /teams/:id/stories · /stories/:file
GET  /teams/:id/evidence · POST (upload)
GET  /teams/:id/exceptions · PATCH /:dimensionId   (approve/deny — lead only)
GET  /teams/:id/provenance
GET  /teams/:id/scoring-logs · /:stamp
POST /teams/:id/intake/text · /intake/image
GET  /recommendations                         cross-team
GET  /feedback · /:taskId · POST resolve|dismiss
GET  /runs · /:runId · POST /runs             (agent launcher — see below)
GET  /rollup                                  program-wide numbers
GET/PUT /configuration                        motions, target level
GET  /submissions · /:team/:envelope · POST parse|commit|clear
GET  /knowledge/tree · /doc · PUT /doc · versions · restore
GET  /workspace                               (alias of knowledge tree, workspace mode)
```

Seed: **7 teams** across the 3 cohorts, 2 fully assessed (all 17 dims with
evidence + follow-ups + history), 3 partially, 2 new. At least one
`claim_open` gap ≥2, one approved N/A, one requested N/A, one L4 with Observed
evidence, ~12 runs across statuses, 3 submissions, a knowledge tree with
enterprise-context + rules + one synced section.

### Agentic support

The source runs `claude -p` subprocesses. Here, agents are **Strands agents on
AgentCore** (nova-pro, `agents/_shared`), dispatched through the existing
fleet pipeline. Map the commands that matter onto agents:

| source command | agent | what it does | guarded by |
|---|---|---|---|
| `classify-transcript` + `score-dimensions` | `orgiq-assessment-scorer` | reads evidence for a team, emits `{classification, scores}` JSON obeying the scoring stance | `RunAssessmentAgent`; writes go through a deterministic `apply-scores` in the provider, never directly |
| `process-self-assessment` | same agent, `mode=survey` | scores a Forms envelope | same |
| `develop-jira-story` | `orgiq-assessment-drafter` | turns ONE recommendation into a story draft | `RunAssessmentAgent`; push is human |
| `extract-enterprise-context` | `orgiq-assessment-drafter`, `mode=context` | governance facts → knowledge docs | `ManageKnowledge` |

The deployed Strands agents expose `classify_evidence`/`score_dimension`
or `check_story_draft`/`validate_facts`. The registry lists those actual
capabilities, not the source CLI's Read/Bash tool names. Agents never persist
scores; the BFF validates and applies their returned envelope. All nine
commands now have execution paths. Document commands consume explicit source
material and return unpublished drafts in the run ledger. The safe diagram
format is uncompressed draw.io XML without external resources or HTML labels.

`POST /api/assessment/runs` returns `202 {run_id}` after atomically reserving
one of three ledger slots and persisting the exact input snapshot. Duplicate
(command, team) checks and the cap share a database table lock. The worker
claims queued records atomically, invokes the appropriate AgentCore runtime
with structured evidence/mode/tenant fields, and completes through the same
deterministic provider seam as callbacks. Inputs survive a BFF restart;
interrupted claims fail after twenty minutes rather than replay score writes.
Invocations have a fifteen-minute transport deadline. A stopped run cannot
later apply scores; this does not promise immediate remote model cancellation.

Completion and stop serialize on the run row. Scoring logs, score/evidence
writes and the terminal status share one transaction. Score application also locks
the team before child inserts, serializing human edits and different commands for
the same team; unique log stamps preserve concurrent run provenance. SSE publishes after
commit. The selected submission is fixed at launch, never chosen again at
callback time. Apply `schema/assessment_schema.sql` before deploying this
worker: it adds private `dispatch_payload` and `dispatch_claimed_at` columns.
Live dispatch refuses mixed real-Aurora/mock-AgentCore or offline settings.
Missing required source material returns 400 before a slot is reserved.

Under mock, timers advance the fixture and write clearly labelled synthetic
results. The Runs launcher collects source text, a committed submission or an
existing recommendation as required by the chosen command.

## Tenants are separate products on a shared BFF

The operating assumption is a single-org SCIM setup: a person is provisioned
into ONE tenant with a role and the app is scoped to that work. Tenants
therefore share the session/BFF and nothing else — not navigation, not
journeys, not chrome. Concretely (each is a validator check now):

- the rail shows only the session tenant's groups; orgiq *platform* items are
  gated on the orgiq tenant, not on the admin/hr-admin role;
- the `/assessment/*` route tree is wrapped in `RequireTenant`
  (client half) and mounted behind `requireTenant()` (server half);
- the command palette is filtered by tenant AND lists the tenant's own pages;
- orgiq-only chrome (`DevboxQuickSwitch`, `ComputeDock`) mounts only for orgiq;
- assessment pages contain no `/iq/` or `/admin/` paths — a
  person's name in this tenant is a name with a card, not a link into the
  org graph;
- the cookie-less demo identity BECOMES the role it picks (`demoScopedGrants`),
  so "demo as SME" holds an SME's grants and sees an SME's app — but a switch
  is validated against what the persona may still become (`switchableGrants`,
  the permissive set for `demo-user`, the cookie's grants for everyone else).
  The picker POSTs `/tenant` then `/role`; the first call narrows the cookie
  to the tenant's fallback role, and without that split the second call 403'd
  for every role except each tenant's lowest (`routes/__tests__/
  demo-picker-switch.test.ts`). `/me` exposes that set as `switchable`, and
  the picker (`SelectContextPage`) builds its tiles from it — so a demo
  narrowed to SME still sees every persona on `/select` and can move on
  without signing out, while the session it holds is exactly an SME's
  (`docs/assessment-journeys/isolation/demo-user.md`).
- **all three** product trees are guarded, not just the "other" two: `/iq/*`
  and `/admin/*` wear `RequireTenant tenant="orgiq"` too. Before that an
  assessor typing `/iq/projects` got the assessment shell wrapped around an
  orgiq page dying with "403 Forbidden" — the server was sealed, the route
  was not. The cross-tenant `admin` role passes every `RequireTenant`.
- the rail and the ⌘K palette share one group order per tenant
  (`GROUP_ORDER_BY_TENANT` / `groupRank` in `portalCommands.ts`), so the
  palette lists pages in rail order instead of leading with Settings.

The audit trail for all of this is `docs/assessment-journeys/isolation/`:
one log per outside role (member, sme, program-owner, org-leader, hr-admin —
signed in as the real seed user, never Demo User) recording
tile / rail / direct-route / API-status, and one `-outbound` log per
assessment role against orgiq. The validator reads the fields. (Two isolation
logs for a role pair that no longer exists were archived under
`docs/assessment-journeys/isolation/archived-newsroom/` — see
`docs/newsroom-removal.md` for the history.)

## Navigation: the tenant's hierarchy IS the shell rail

The first cut rendered one "Assessment" entry in the shell rail and a
`SubNavLayout` with Assess / Analyze / Informatics / System *inside* the page —
two navs for one product. The user's call: "the whole assessment app should be
its own tenant with a different nav hierarchy." So the tenant's groups are
shell-rail groups (`Layout.tsx` `NAV_ITEMS`, `tenant: 'assessment'`, `group:`
Assess|Analyze|Informatics|System), group order is per tenant
(`GROUP_ORDER_BY_TENANT` — the SDLC arc is orgiq's map, not everyone's),
`AssessmentLayout` is a bare `<Outlet/>`, `/assessment` is NOT in the
full-bleed list (no nested rail → it wants the shell padding), and
`Breadcrumbs.tsx` reads `Assess › Dashboard › TEAM-002` from the same map.
Configuration carries `requireRoles: ['program-lead', 'admin']` so the rail
hides it for the roles the Cedar forbid would 403 anyway.

## Two authz gotchas the port exposed (both fixed, both generic)

1. **`CAPABILITY_ACTIONS` in `middleware/src/lib/authz.ts` must list every new
   action.** `GET /api/session/capabilities` evaluates only that list, so the
   eight assessment actions read `undefined` in the portal's `can()` and every
   assessment control hid for every role — including ones Cedar permitted.
   Adding a `requireAction('X')` gate without registering `X` there produces
   a UI that silently has no controls.
2. **Open-mode authz never honoured the admin wildcard.** `admin.cedar` is an
   unconstrained permit, which `role-registry` records as `['*']`; the
   seed-matrix decision did `set.has(action)`, so with no `POLICY_STORE_ID`
   admin was DENIED on every plain `requireAction` gate while passing the read
   gates that special-case the role by name. The orgiq pages hid it; all of
   the assessment gates are plain, so admin got "HTTP 403" on Submissions.
   `seedPolicyDecision` now treats `*` as every action (regression test:
   `lib/__tests__/authz-open-mode.test.ts`).

## What the code review of the port found (all fixed, all tested)

- **`is_na` was self-granting.** `applyScores` honoured `is_na: true` from the
  ScoreAssessment payload and marked a dimension not-applicable with no
  exception record — an assessor could grant the N/A that `assessor.cedar`
  forbids them approving. It is now a *claim*: it opens (or reuses) a
  `requested` exception, records `na_claimed` in the history, and scores the
  dimension normally until a lead approves. `suggested_level` must be an
  integer in range.
- **`ManageUsers` "within the assessment tenant" was not scoped.** The grants
  write path accepted any tenant key, so a program-lead could mint themselves
  orgiq hr-admin (Masquerade included). Non-admin callers may
  now write grants only for their own session tenant, merged onto the target's
  other-tenant grants rather than rewriting them (`identity-grants-scope.test.ts`).
- **Caller-supplied ids indexed `{}` literals** (`envelope_ids: ['__proto__']`
  set `Object.prototype.status` process-wide). Every such lookup goes through
  `ownEntry` (`Object.hasOwn`).
- **Unvalidated writes**: PATCH /teams/:id (a bogus cohort made `/rollup`
  throw for everyone), PUT /configuration `motions`, and every array body
  whose elements were never checked (parse rows, clear targets, score
  entries) — all 400 with the field named instead of 500.
- **`virtual-*` feedback tasks** (synthesized from OPEN follow-up questions)
  could never be resolved: the handlers only searched stored tasks. They now
  answer/drop the underlying question.
- **The portal read `task.id`** where the wire sends `task_id`, so every
  Resolve/Dismiss POSTed to `/feedback/undefined/…`. Fixed on the portal
  side (`feedbackActionPath`) — the mock is the contract.

## The Aurora path (no longer mock-only)

`schema/assessment_schema.sql` is the tenant's DDL (registered in
`schema/load_schema.py`; standalone, no FK into the org graph). The provider
now branches on `config.mock.aurora`: `providers/assessment-aurora.ts` holds
the SQL + row mapping (parameterized Data API statements via `lib/aurora`'s
`exec`, JSONB for the document-shaped columns), and the pure pieces shared by
both paths — `computeScoreEntry` (the applyScores validator with N/A-as-claim),
`teamSummaryFromDims`, `assembleTeamDetail`, `buildProvenanceLedger`,
`computeRollup`, `computeTeamPlan` (recommendations are DERIVED from scores
and open follow-ups, never stored), `buildSubmissionListing`,
`parseFormsRecords` — take plain data so the two paths cannot drift. Every
provider function now has an Aurora branch (`notMocked` is gone); the one
thing that stays in memory on both paths is the wizard's 30-minute
parse→commit staging map, which is scratch, not state. Knowledge comments
persist to `assessment_knowledge_comments` and publish versions to
`assessment_knowledge_nodes.version` (both added for the Aurora path). Runs on
Aurora carry `launched_by` from the session sub (never the body). ⚠️ None of
this SQL has run against a live cluster yet — no database is reachable from
the offline dev loop; correctness rests on `tsc`, the stubbed-Data-API tests
(`providers/__tests__/assessment-aurora.test.ts`) and mirroring the
conventions of `providers/aurora.ts` / `providers/budgets.ts`. First live
run: apply `schema/load_schema.py`, deploy the matching assessment agent
images, then exercise the ledger through actual Aurora and AgentCore. Admission
and completion transaction tests use a stubbed Data API and do not establish
live database/agent behavior. The old separate duplicate-check/insert race is
closed by the transaction and lock described above.

## Realtime: what needs the gateway and what the BFF does alone

`portal/.env.example` documents two modes: `VITE_GATEWAY_URL=http://localhost:8080`
(websocket-gateway up — Tilt forwards it to host 18080) gives the knowledge
pages presence, chat/comments and CRDT co-editing through realtime-modules'
`useChannel`; `VITE_GATEWAY_URL=http://localhost:3001` ("no gateway") pointed
the same hooks at the middleware's `/ws`, which accepted the socket and did
nothing — so `ConnectionPill` said "Connected" and a second tab saw no
presence, no edits and no comments (`docs/assessment-journeys/stretch/realtime.md`).
The tenant now carries its collaboration signal on the BFF's own SSE broker
(`GET /api/assessment/events`): document saves refetch the open doc in every
other tab, comments render from `knowledge.comment.created`, and viewers are
tracked by `POST /knowledge/presence` heartbeats with a 45s TTL — with the
gateway's channel merged in when it is actually connected (dedupe: comments
by content+time window, presence by `metadata.sub`; two tabs of one user
collapse to one avatar "×2"), and durable comments/reactions stored by the BFF. The middleware no longer
accepts a dummy `/ws` connection: upgrades receive HTTP 404, because accepting
an unauthenticated socket without implementing collaboration falsely reported
connectivity. Full CRDT co-editing still needs the external gateway. Its
identity and channel-membership enforcement must be configured at that gateway;
this BFF cannot vouch for an unauthenticated external socket. The library's
provider currently has no disabled option and retries unavailable endpoints;
that integration gap is recorded in `ui-components-queue.md`.


The external gateway source inspected during the 2026-09-19 audit rejects
missing JWTs before upgrading (`realtime-examples/src/server.ts`,
`src/middleware/auth-middleware.ts`) and authorizes private channels from
verified `channels` / `orgId` claims (`authz-middleware.ts`). That source is
read-only context, not evidence of a deployed configuration. This portal does
not pass a gateway token: its BFF deliberately keeps Cognito tokens out of the
browser and issues a different signed cookie keyed to the local user id.
Consequently secure external gateways refuse this integration until an identity
exchange is implemented. `SKIP_AUTH=true` in the external gateway's local
example assigns admin access and must not be used to enable production
collaboration. A session cookie or a shared service secret is not a substitute
for the missing user-and-channel authorization contract.

Two restart lessons from the two-tab proofs, both fixed: (1) SSE frame ids
were a bare per-process counter, so a tab that lived through a middleware
restart deduped every later event against ids it had already seen and went
silently stale — ids are now `<boot-epoch>-<seq>` and a `Last-Event-ID` from
another epoch means full replay; (2) a Vite-proxied tab never sees the
upstream die (no `onerror`), so the heartbeat is a NAMED `heartbeat` event
(not an ignored comment) and `useAssessmentEvents` runs a 60s stall watchdog
that drops the pill off Live and reopens the stream itself.

## Agent callback: run completion

`POST /api/assessment/runs/:runId/complete` is how a real agent run reports
back (`{ status: 'completed'|'failed', summary?, error?, files_written?,
scoring_log?: ScoringLogEntry[] }`). It is a MACHINE route: no session,
guarded by `requireRunCompleteAuth` — constant-time check of the
`x-assessment-run-auth` header against `ASSESSMENT_RUN_COMPLETE_SECRET`,
open when the secret is unset (dev). Set the secret in any deployed
environment. Because of this exemption the tenant gate lives inside
`assessmentRouter` rather than at the `index.ts` mount (per-route, not
blanket — CLAUDE.md's "not every route is human-facing"), and
`assessment-router-own-gate.test.ts` proves outside roles are still refused
on the bare router. A completed `score-dimensions` run's `scoring_log` is
applied through the same `applyScores` seam as the UI, N/A-as-claim
included; on the mock path the 8s fake completion still runs when no
callback arrives.

## Contract discipline: build pages to the middleware's shape

Three of the ten pages shipped against **invented** response keys
(`rollup.assessed_coverage`, `cmd.tool_allowlist`, `config.certification_target_level`)
and white-screened on first load. The mock IS the contract; the source app's
types are the vocabulary. When a page needs a field the mock lacks, add it to
the mock and the provider — never guess a key on the client. And guard on
SHAPE, not presence: a failed fetch still resolves to a body.

## Primitives the library lacks (ship to ui-components FIRST)

Audit of `@connorhoehnslalom/ui-components` 2.130.1: it has `RailLayout`,
`SubNavLayout`, `Tabs`/`TabPanel`, `Breadcrumbs`, `ActivityFeed`, `DataTable`,
`Drawer`, `CollapsibleSection`, `FileUploadDrop`, `ProgressBar`, `Chip`. It is
missing five things the two layouts need. Their APIs are fixed here so the
library work and the page work can proceed in parallel against one contract.

```ts
// shared/MasterDetail — rail + pane, collapsible rail, persisted mode
interface MasterDetailProps<T> {
  items: T[]; keyOf: (t: T) => string;
  selectedKey: string | null; onSelect: (key: string) => void;
  renderRow: (t: T, i: number, selected: boolean) => ReactNode;      // expanded rail row
  renderCompactRow?: (t: T, i: number, selected: boolean) => ReactNode; // 72px rail row
  renderDetail: (t: T, i: number) => ReactNode;
  railTitle?: ReactNode; railWidth?: number /* 340 */; compactWidth?: number /* 72 */;
  storageKey?: string;  // persists compact/expanded
  emptyDetail?: ReactNode;
}
// shared/TreeView — nested rows, border-l-2 selection, 20px leading slot, caret
interface TreeNode { id: string; title: string; parentId: string | null; isDir?: boolean;
  badge?: ReactNode; meta?: string; disabled?: boolean }
interface TreeViewProps { nodes: TreeNode[]; selectedId: string | null;
  onSelect: (id: string) => void; defaultExpanded?: string[]; onReorder?: …;
  renderTrailing?: (n: TreeNode) => ReactNode }
// shared/WorkflowStepper — the 6-step strip: done / active / todo, compact, overflow-x
interface WorkflowStep { step: number; label: string; done: boolean; active: boolean }
interface WorkflowStepperProps { steps: WorkflowStep[]; size?: 'sm' | 'md' }
// shared/Wizard — numbered steps with a rail, Next/Back, per-step validity
interface WizardStep { key: string; label: string; content: ReactNode; canAdvance?: boolean }
interface WizardProps { steps: WizardStep[]; activeKey: string; onStep: (k: string) => void;
  onFinish?: () => void; finishLabel?: string }
// shared/MarkdownView — read-only markdown on tokens (code fences, tables, links)
interface MarkdownViewProps { markdown: string; className?: string }
```

Also add `LevelBadge`-style support via `Chip tone` + a `Tooltip` primitive if
none exists (InlinePopover exists; a hover tooltip does not).

## Library TODOs the port left behind

- `RailLayout` renders its rail on the right only; the Workspace explorer is
  tree-left and composes `Inline`+`Stack` instead. Add `railSide` upstream.
- `@connorhoehnslalom/ui-components/integrations/realtime-modules` hard-imports
  `@tiptap/react` through `CanvasDocumentView`; without the optional tiptap
  peers every wrapped component breaks `vite build`. The explorer uses the
  plain `social`/`shared` primitives with the wrappers' adapter logic
  reproduced as tested pure functions in `knowledgeFormat.ts`.

## Document comments — what is wired, and what the wire cannot carry

`DocPane`'s comments drawer is the library's `ChatPanel` (from `social`, NOT
the `doc-editor` subpath that is unbuildable here — see the Tiptap note in
docs/ui-components-queue.md). Wired as of 2026-09-18: the message list,
sending, `currentUserId` for ownership, and an `emptyState` that names the
document instead of the library's bare "No messages yet".

`ChatPanel` also offers `onReply` (threading), `reactionsFor` /
`onToggleReaction`, `onEditMessage` and `onDeleteMessage` — each documented as
"presence of this enables the control". None are wired, and NOT because the
component is missing them: `POST /api/assessment/knowledge/doc/comment` takes
`{ id, body }` and nothing else. There is no `parentId`, so a reply has
nowhere to point; no reaction table; no comment id to address for an edit or a
delete. Wiring any of those controls today would put an affordance on screen
that the API cannot honour.

So the order is backend first — a comment needs an id, a parent and a
mutation route — and the panel's props then light the controls up with no new
component work. That is the cheap half; it is worth not faking it in the
meantime.

## Build order

1. Tenant plumbing (session, Cedar, schema, registry, identity, features,
   Layout nav, App route stub, SelectContext tile) — small, unblocks everything.
2. Mock data + `/api/assessment/*` routes + tests (parity with source shapes).
3. Portal: AssessmentLayout + Dashboard (cohort → list → scorecard with
   DimensionMasterDetail). ui-components primitives first if missing.
4. Portal: Workspace (three-pane explorer) + Enterprise + Rules + Prompts.
5. Portal: Submissions wizard, Feedback, Reports, Runs/Activity, Configuration.
6. Agents: scorer + drafter, run launcher route, apply-scores provider step.
7. Journey audit with screenshots per role.
