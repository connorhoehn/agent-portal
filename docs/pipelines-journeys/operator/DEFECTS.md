# operator — pipelines journey defects

## Open

None open.

## Closed

1. **Configuration is in the rail for every pipelines role** — closed in lane E
   (2026-09-30). Decision: author and operator see **nothing** — no rail row,
   no palette row, and `/pipelines/configuration` redirects them home
   (`RequireRole roles={['pipeline-admin']}` in `App.tsx`; `requireRoles:
   ['pipeline-admin', 'admin']` in `Layout.tsx`; `roles: ['pipeline-admin']`
   in `portalCommands.ts`; `validate-nav-parity.sh` green). The one fact of
   the setting their work depends on — who approves a step by default — is
   already on every Definition and Approval ("Operator (default)"), so hiding
   the page hides no information from them. pipeline-admin (and admin) get the
   real page: the default approver role with Save (`PUT
   /api/pipelines/configuration`, `ManagePipelineConfig`). Re-walked in the
   configuration logs.

2. **The run page's Events section carried no history, and the header lagged the live frame** — found 2026-10-06 in the run-detail re-walk; resolved 2026-10-06.
   (a) `RunDetailPage` now passes the run's stored record (`recordedRunActivity(run, steps)`,
   `pages/pipelines/recordedEvents.ts`) to `ChannelActivity`, which merges it under the
   gateway's live rows (a live row replaces its recorded twin) and shows eight rows at a
   time instead of the ticker's three. (b) `PipelineRunLive` re-reads the run whenever the
   record disagrees with the live phase (`recordBehind`), including for the first frame
   seen, which the old phase-changed check ignored. Evidence: a finished run re-opened as
   all four roles lists six rows oldest first; `e2e/pipelines-run-events.spec.ts` passes
   (seeded run shows its events; a started dry-run's header leaves "pending" and agrees
   with the stored record without a reload); 7 new node:test cases pass. Re-walked in the
   four `run-detail.md` logs.

## Open — 2026-10-08 re-walk (type scale; no cascade or gating defects)

Observed in this pass at 1680×940; the measured contract (`docs/journeys/contracts/type-scale.json`) records the same family. Page titles are 20/600 on every route; the cascade contract lists no violations for any of them.

1. `/pipelines/runs`, `/pipelines/artifacts`, `/pipelines/definitions`, `/pipelines/approvals` · type scale · 11/400 content text (contract offender); table column headers measure 10/600 (50-71 text nodes per table).
2. `/pipelines/runs/:id` · type scale · 10/400, 10/500, 10/600, 11/400, 11/500, 13/400, 18/400 and a 6/600 badge in the activity graph and discussion (contract: seven offenders).
3. `/pipelines/agents`, `/bots`, `/commands`, `/runbooks` · table headers 10/600 (the contract lists no offender here, so its scan does not count them; worth a ruling).
4. `/pipelines/runs/:id` · rail · the section rail collapses to a single "Runs" link on a run page, so Configuration is not reachable from it for pipeline-admin; by design as far as the cascade contract says, noted only.
