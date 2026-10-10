# admin — journey defects

## Open — 2026-10-08 re-walk (type scale; no cascade or gating defects)

Observed in this pass at 1680×940; the measured contract (`docs/journeys/contracts/type-scale.json`) records the same family. Page titles are 20/600 on every route; the cascade contract lists no violations for any of them.

1. `/pipelines/runs`, `/pipelines/artifacts`, `/pipelines/definitions`, `/pipelines/approvals` · type scale · 11/400 content text (contract offender); table column headers measure 10/600 (50-71 text nodes per table).
2. `/pipelines/runs/:id` · type scale · 10/400, 10/500, 10/600, 11/400, 11/500, 13/400, 18/400 and a 6/600 badge in the activity graph and discussion (contract: seven offenders).
3. `/pipelines/agents`, `/bots`, `/commands`, `/runbooks` · table headers 10/600 (the contract lists no offender here, so its scan does not count them; worth a ruling).
4. `/pipelines/runs/:id` · rail · the section rail collapses to a single "Runs" link on a run page, so Configuration is not reachable from it for pipeline-admin; by design as far as the cascade contract says, noted only.
