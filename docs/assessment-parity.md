# Assessment tenant — source parity

Source: `~/projects/agentic-assessment-accelerator` (Astro + React islands +
Python `sdlcd/` backend). Port: `portal/src/pages/assessment/*` (React,
`@connorhoehnslalom/ui-components`) + `middleware/src/{routes,providers,mock}/assessment*.ts`
(Express + mock-Aurora).

`ported` = a person can do this in this app today. `out-of-scope` = a
one-line reason it deliberately isn't here. No `partial` rows — where a real
gap turned out small and inside middleware routes/providers/mock, it was
closed this slice (see "Fixed this slice" notes below); everything else is
called out honestly rather than glossed over.

## Source pages (`ui/src/pages/`, 20)

| feature | status | note |
|---|---|---|
| `index.astro` (landing, redirects signed-in users to `/teams` or `/docs`) | ported | `/assessment` index route redirects to `teams` (`App.tsx`); tenant entry/redirect is `SelectContextPage` + `RequireTenant`, shared across all three tenants rather than per-tenant. |
| `login.astro` (Okta / anonymous sign-in) | out-of-scope | One session system serves all three tenants (`middleware/src/lib/session.ts`, `portal/src/lib/auth.tsx`) — no per-tenant Astro/NextAuth login page exists or is needed. |
| `teams.astro` (dashboard island) | ported | `DashboardPage.tsx` — cohort landing → team list → scorecard, three-view flow matching source. |
| `workspace.astro` | ported | `WorkspacePage.tsx` (`KnowledgeExplorer mode="workspace"`), backed by `GET /api/assessment/workspace`. |
| `configuration.astro` | ported | `ConfigurationPage.tsx`, `GET`/`PUT /api/assessment/configuration`. |
| `confluence.astro` (legacy redirect shim to `/workspace`) | out-of-scope | Redirect-only shim for old bookmarks in the source app; no such old links exist here. |
| `documents.astro` (legacy `?doc=prompt:\|rule:\|ec:` redirect shim) | out-of-scope | Same — this app split Prompts/Rules/Enterprise into dedicated routes from day one, so there's no legacy unified `/documents` link to redirect from. |
| `enterprise-context.astro` | ported | `EnterprisePage.tsx` (`KnowledgeExplorer mode="enterprise"`). |
| `feedback.astro` | ported | `FeedbackPage.tsx` — list/filter, resolve, dismiss all wired to `/api/assessment/feedback*` (covered by `assessment-routes.test.ts` this slice). |
| `prompts.astro` | ported | `PromptsPage.tsx` (`KnowledgeExplorer mode="prompts"`, read-only). |
| `report.astro` (chrome-less, printable per-team report) | out-of-scope | No portal route renders a print-stylesheet single-team report yet. The data it needs (`GET /teams/:id`, `GET /rollup`) already exists — this is a portal page-authoring gap, outside this slice's file scope (middleware routes/providers/mock only). |
| `reports.astro` (portfolio rollup) | ported | `ReportsPage.tsx` — rollup, `WhereToStartCard`, publish. |
| `rules.astro` | ported | `RulesPage.tsx` (`KnowledgeExplorer mode="rules"`). |
| `runs.astro` | ported | `RunsPage.tsx` — launch, list, stop, all live against `/api/assessment/runs*`. See "Runs page reacts via polling, not SSE" below for a nuance. |
| `submissions/add.astro` (import wizard) | ported | The 4-step `Wizard` inside `SubmissionsPage.tsx` (`DropStep` → `PreviewStep` → `FetchLinksStep` → `RunPromptStep`), not a separate route. |
| `submissions/index.astro` (envelope list) | ported | `SubmissionsPage.tsx` list/detail view. |
| `health.ts` | out-of-scope | The app already has tenant-agnostic `GET /health` and `GET /api/health` (`middleware/src/index.ts:118-119`); assessment doesn't need its own. |
| `docs/index.astro` (static onboarding page: workflow steps, key-area links, live command list) | out-of-scope | No portal route for this yet. The one live data source it used (`GET /agent/commands`) already exists and is tested — authoring the page itself is portal work, outside this slice's file scope. |
| `api/auth/debug.ts` (NextAuth/Okta session debug) | out-of-scope | This app's session is a signed cookie with no Auth.js in the loop — there is no NextAuth session object to debug. |
| `api/auth/set-cookie.ts` (bridges a NextAuth access token into an httpOnly cookie) | out-of-scope | Superseded entirely by `mintSession` issuing the app's own cookie directly (`middleware/src/routes/session.ts`) — there is no second token to bridge. |

## Slash commands (`.claude/commands/`, 9)

All nine are in `LAUNCHABLE_COMMANDS` (`routes/assessment.ts`), launchable via
`POST /api/assessment/runs`, and listed live via `GET /api/assessment/agent/commands`
with their tool allowlist — exercised in `assessment.test.ts`'s "agent commands
+ stop" suite.

| feature | status | note |
|---|---|---|
| `classify-transcript` | ported | Launchable; read-only tool floor enforced. |
| `develop-jira-story` | ported | Launchable, drafts only — see "Jira push" below for why the push verb is withheld, same as upstream. |
| `draft-confluence-page` | ported | Launchable. |
| `draw-diagram` | ported | Launchable (generates the drawio XML). Rendering that output inline is a separate gap — see "Confluence diagrams" below. |
| `extract-enterprise-context` | ported | Launchable. |
| `process-self-assessment` | ported | Launchable; scores a Forms submission envelope. |
| `score-dimensions` | ported | Launchable; duplicate-guarded per (command, team), capped at 3 concurrent. |
| `suggest-confluence-content` | ported | Launchable. |
| `validate-outputs` | ported | Launchable. |

## Workflow packages (`sdlcd/workflows/`, 6)

The source's Python backend is ported as Node/Express routes + a mock
provider, not file-for-file — each row names the routes that took over the
package's job.

| feature | status | note |
|---|---|---|
| `agent_runs` | ported | `/runs`, `/runs/:runId`, `/runs/:runId/stop`, `/agent/commands` (`launchRun`/`stopRun`/`listRuns` in `providers/assessment.ts`). |
| `confluence_sync` | ported | `/knowledge/pull`, `/knowledge/doc/publish`, `knowledge/tree`'s `synced` section — mock Confluence sync with `knowledge.pulled`/`knowledge.published` SSE events. |
| `document_processor` | ported | `/teams/:id/intake/text`, `/teams/:id/intake/image`, `/teams/:id/evidence` — the intake pipeline (mocked, deterministic). |
| `knowledge` | ported | `/knowledge/doc`, `/knowledge/doc/versions`, `/knowledge/doc/version`, `/knowledge/doc/restore`, `/knowledge/doc/comment`. |
| `submissions` | ported | `/submissions`, `/submissions/parse`, `/submissions/commit`, `/submissions/clear`, `/submissions/:team/:envelope`, `/submissions/:team/:envelope/links`. |
| `team_dashboard` | ported | `/teams*`, `/recommendations`, `/rollup`, `/configuration` — the read model this package served. |

## Scorecard tabs (`TeamScorecard.tsx`, 5)

| feature | status | note |
|---|---|---|
| Certification | ported | `StatStrip` + `WorkflowStepper` + `DimensionMasterDetail` list, driven by `GET /teams/:id`. |
| Improvement Plan | ported | `ImprovementPlan.tsx`, `GET /teams/:id/recommendations`. |
| Stories | ported | `StoriesPanel.tsx`, `GET /teams/:id/stories` + `/teams/:id/stories/:file`. |
| Evidence & Intake | ported | `EvidenceIntake.tsx` — touchpoint + document-drop intake (`POST /teams/:id/intake/text`) and the lineage ledger (`GET /teams/:id/provenance`). **Fixed this slice**: the ledger endpoint returned `{ provenance: Provenance[] }` (raw records) while the portal has always expected `{ team_id, items: IntakeItem[] }` (grouped capture events with name/evidence_count/dimensions_touched) — the panel silently showed "No evidence ingested yet" regardless of real data. `providers/assessment.ts#getProvenance` now builds the real ledger (grouping historical `MOCK_PROVENANCE` by capture event + counting linked scored evidence, plus one row per pending `MOCK_EVIDENCE_LOG` intake item), and `intakeText` now records the `source_type`/`title`/`captured_by` the intake forms already sent but the route silently dropped. Covered by two new tests in `assessment-routes.test.ts`. |
| Documents | out-of-scope | Source renders a real team-scoped `TeamDocuments` browser here; the port shows an `EmptyState` pointing at Workspace instead. Building an inline team-filtered `KnowledgeExplorer` is a portal component change, outside this slice's file scope — the backend data (`GET /knowledge/tree`, `GET /knowledge/doc`) already supports filtering by team if that view gets built. |

## Dimension-detail tabs (`DimensionMasterDetail.tsx`, 5)

| feature | status | note |
|---|---|---|
| Progress & follow-ups | ported | Renders `dimension.follow_up_questions` + `criteria_progress` from `GET /teams/:id`. |
| How it was assessed | ported | Renders confidence, `evidence_class`, `self_claimed_level`, `cap_applied` from the dimension's current state. Does not (yet) surface the separate per-run agent transcript — see "Scoring-logs raw agent pass view" below. |
| Evidence | ported | Renders `dimension.evidence[]`. |
| Definition & rubric | ported | Renders `dimension.definition` + `rubric_levels`. |
| History | ported | Renders `dimension.history[]`. |

## Cross-cutting features

| feature | status | note |
|---|---|---|
| `RunAgentPanel` (pick command + team + args, launch, watch status) | ported | `RunsPage.tsx`'s inline launcher against `POST /api/assessment/runs`. |
| `TeamActionsMenu` (rename, reassign lead, reset assessment, delete) | ported | Wired on the scorecard header (`dashboard/TeamActionsMenu.tsx`): change lead (`PATCH /teams/:id`), reset (`POST .../reset-assessment`, confirm), delete (`DELETE /teams/:id`, confirm → dashboard); the whole menu is absent from the DOM without `ScoreAssessment`. Verified in the lead-assessor, program-lead and admin journey logs. |
| `CohortActionsMenu` (create-team modal from the cohort landing) | ported | "+ New team" on the dashboard (`dashboard/NewTeamModal.tsx`, `POST /teams`, name + cohort + lead, deterministic `TEAM-0NN`). Verified in all four role journey logs. |
| `ExceptionsModal` (N/A exception approve/deny, read-only for an assessor) | ported | `dashboard/ExceptionsModal.tsx` on the scorecard: `GET /teams/:id/exceptions`; Approve/Deny rendered only with `ApproveException` (lead-assessor/program-lead/admin), read-only rows for an assessor. Widened to 960px after the lead-assessor audit caught clipped buttons. |
| `WorkflowStepper` | ported | `@connorhoehnslalom/ui-components` primitive, used in `TeamScorecard.tsx`. |
| `WhereToStartCard` | ported | Reimplemented locally in `ReportsPage.tsx` on the real rollup numbers. |
| `ActivityBar` | ported | `portal/src/pages/assessment/knowledge/ActivityBar.tsx`, driven by SSE (`knowledge.pulled`, run events). |
| Confluence publish | ported | `DocPane.tsx` → `POST /knowledge/doc/publish`, waits for `knowledge.published` over SSE before clearing its pending state. |
| Confluence pull | ported | `KnowledgeExplorer.tsx` → `POST /knowledge/pull`, waits for `knowledge.pulled`. |
| Confluence comments | ported | Per-doc comments drawer on `DocPane.tsx`, echoed server-side via `POST /knowledge/doc/comment` so off-channel viewers see them via `GET /events`. |
| Confluence diagrams (drawio blocks embedded in a page's markdown) | out-of-scope | The `draw-diagram` command itself is launchable (ported, see commands table), but `DocPane`'s markdown renderer has no `DrawioBlock`-equivalent fence handler — a fenced diagram would render as a plain code block, not an interactive diagram. Portal rendering work, outside this slice's file scope. |
| Confluence move (drag-and-drop page reorder / reparent) | out-of-scope | Not implemented on either side — no `POST .../move` route exists, and the tree has no drag-and-drop. Adding just the backend endpoint wouldn't make this "ported" (nothing could call it), so it stays a paired backend+frontend gap rather than a partial backend stub. |
| Jira push (`jira push-story` tool, pushing a drafted story to a real Jira issue) | out-of-scope | Deliberately withheld in both apps — `develop-jira-story` drafts only; pushing is a human decision (`providers/assessment.ts`'s command registry comment, pinned by the `agent commands + stop` test's assertion that no command's allowlist includes `jira push-story`). Not a gap, a shared design choice. |
| PII scrub (participant names → role labels when a transcript/touchpoint is processed) | out-of-scope | A real feature server-side in the source's `classify-transcript`/`process-self-assessment` agent tools, run against real Bedrock. This tenant's local dev path is mock-only end to end (no agent ever actually reads the touchpoint text) — there is no real transcript text to scrub in that path. The intake form's copy describing scrubbing is accurate for a real agent run, just not exercised by the mock. |
| Scoring-logs raw agent pass view (`GET /teams/:id/scoring-logs`, backing "How it was assessed") | ported | `dashboard/ScoringLogsDrawer.tsx` behind the scorecard's "How it was assessed" control: list → per-stamp detail. A completed `score-dimensions` run writes the log it shows. |
| Runs page reacts to runs live | ported | `RunsPage.tsx` folds `run.started` / `run.progress` / `run.completed` / `run.failed` from `GET /events` (shared `useAssessmentEvents`, pure `applyRunEvent` reducer) onto the ledger; the 5s poll is gone. Every role's runs journey log saw a launched run appear, tick and complete with no reload. |
