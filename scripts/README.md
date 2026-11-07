# scripts/

The goal documents, journey logs and CLAUDE.md that the old judges read were removed in the hand-over sweep (they are in git history up to commit 5b6b828c). This table records what happened to each file that referenced them. "Kept" scripts start and run without `docs/`; some report real, pre-existing debt in the code, noted below.

## Judges (validate-*.sh)

| File | Decision | Why |
|---|---|---|
| validate-agent-eval.sh | kept | Structural golden-set grading; passes. The goal-doc check was dropped. Needs `.venv-synth`. |
| validate-component-discipline.sh | kept | Raw-element and layout-drift ratchets over `portal/src`. The optional `docs/ui-components-queue.md` is treated as absent. Currently fails on real budget overruns. |
| validate-deploy-bug-classes.sh | kept | Secret ARN, uuid-bind and bundle-singleton lint. Comment fixed. Not run here (it runs jest and a vite build). |
| validate-honest-numbers.sh | kept | Static scanners; passes with `--quick`. |
| validate-mock-floor.sh | kept | Mock data floor checks; the docs section was dropped. With `--static --quick` it fails because the snapshots are stale against current middleware sources. |
| validate-nav-parity.sh | kept | Palette versus route parity; passes with `--quick`. |
| validate-newsroom-removal.sh | kept, stripped | Checks the retired tenant is gone from code; the docs, archive, journey and assessment-judge checks were removed. Passes with `--quick`. |
| validate-route-coverage.sh | kept | Route-to-test parity ratchet. Currently fails: 11 untested routes against a budget of 0. |
| validate-access-tenant.sh | removed | Checks the goal doc, design doc and CLAUDE.md map. |
| validate-assessment-decks.sh | removed | Goal doc and queue doc checks plus journey walk. |
| validate-assessment-documents-parity.sh | removed | Goal doc, screenshots under `docs/design`, journey walk. |
| validate-assessment-tenant.sh | removed | Journey logs under `docs/assessment-journeys`. |
| validate-branding.sh | removed | Journey logs and goal doc. |
| validate-communication-plane.sh | removed | Journey logs and design docs. |
| validate-demo-content.sh | removed | Goal and audit docs, journey maps and logs. |
| validate-distillation-runbooks.sh | removed | Goal and design docs, CLAUDE.md map, retired migration. |
| validate-meeting-rooms-app.sh | removed | Goal doc, CLAUDE.md pins line, recorded proof under `docs/realtime-validation`. |
| validate-orgiq-audit.sh | removed | Journey logs only. |
| validate-pipelines-tenant.sh | removed | Goal doc and journey logs. |
| validate-rail-parity.sh | removed | Goal doc and layout-cascade doc. |
| validate-search-workspace.sh | removed | Goal doc and journey logs. |
| validate-social-tenant.sh | removed | Goal and design docs, journey logs. |
| validate-upstream-refinement.sh | removed | Goal and plan docs, recorded capacity and soak results. |
| validate-user-search.sh | removed | Probe results and journey logs under `docs/`. |
| validate-work-journeys.sh | removed | Journey logs only. |

## Helpers

| File | Decision | Why |
|---|---|---|
| build.sh | kept | Image build and push. Pointer to a removed doc deleted. |
| portal-publish.mjs | kept | S3 and CloudFront publish; `--dry-run` prints the plan. Comment fixed. |
| check-tenant-manifest.mjs | kept | Now checks seeds, mounts, route trees, labels and generated files; the CLAUDE.md role check was dropped. Passes. |
| tenant-manifest.test.mjs | kept | The CLAUDE.md fixture was removed; 8 of 8 tests pass. |
| check-uuid-binds.mjs | kept | Comment fixed; passes. |
| check-search-writers.mjs | kept | Comment fixed. Fails on 2 real writers in `middleware/src` (`updateRoom`, `setBotEssential`) that lack a search hook. |
| social-documents.mjs | kept | Local gateway helper; doc pointers removed. |
| audit-ui-dom.cjs | kept | Resolves the audit skill from the installed ui-components package; error message updated. |
| count-layout-drift.py | kept | Used by validate-component-discipline.sh; doc pointer removed. |
| layout-drift-burndown.tsv | kept | Per-file budget read by validate-component-discipline.sh. |
| meeting-rooms-proof.mjs | removed | Only reads journey logs and dated audit proofs under `docs/`. |
| user-search-catalog.mts, user-search-clone-parity.mts | removed | Read and write `docs/user-search-probe-results.json`. |
| user-search-freshness.mjs, user-search-report.mjs, user-search-results.mjs, user-search-results.test.mjs | removed | Probe-results bookkeeping for the removed judge. |
| user-search-floors.tsv, work-journeys-floors.tsv | removed | Floors for the removed judges. |

## Left alone, now orphaned

`scripts/journeys/`, `scripts/lib/journeys.sh`, `scripts/demo-content/`, `scripts/lib/rail-parity-measure.mjs` and the `*-budget.txt` files for removed judges are no longer called by any kept script (`portal/e2e/user-search-probe.spec.ts` still names the removed user-search files). They were outside this pass; delete or revive them next.
