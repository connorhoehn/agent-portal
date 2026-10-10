
## 2026-10-05 hygiene pass
- git rm docs/deployment-summary-2026-09-17.md: point-in-time session snapshot, resolved; current deploy state lives in CLAUDE.md gotchas and docs/deployment-upgrade-2026-09-19.md. Unreferenced.
- git rm docs/docker-ecr-connectivity-issue.md: incident marked resolved (Docker daemon restart); unreferenced.
- rm portal/hide.jpg, portal/tmp.jpg: untracked, unreferenced screenshots.
- .gitignore: portal/*.jpg, portal/*.png.
- Candidates left: docs/deployment-checklist.md (unreferenced, may overlap CLAUDE.md deploy flow), docs/handoff-2026-09-19.md and docs/document-workspace-handoff-2026-09-20.md (cross-referenced by other docs), docs/claude-code-handoff-2026-10-05.md (untracked, new).

## 2026-10-05 hygiene pass #2
- git rm docs/deployment-checklist.md: stale (16 stacks, manual ECR/buildx steps); superseded by CLAUDE.md "CDK vs AgentCore CLI", deploy gotchas (middleware empty-ECR, runtime phase 2, custodian) and docs/social-calls-deploy-plan.md; the only unique bit (colima start) is trivial. Unreferenced.
- git rm answer.py (repo root): a 1+1 print scratch script, unreferenced.
- No new .gitignore entries: test-results/, portal/test-results, e2e-*, .DS_Store, middleware/.data already ignored; no *.orig/*.rej, no stray root/portal/middleware screenshots.
- Candidates (unreferenced dated docs; not provably superseded): docs/empty-state-audit-2026-09-16.md, research-data-api-limits-2026-09-16.md, research-mock-total-semantics-2026-09-16.md, scale-audit-2026-09-16.md, table-density-audit-2026-09-16.md, url-state-audit-2026-09-16.md, write-path-audit-2026-09-16.md. Recommend delete after owner confirms findings were actioned.
- Cluster: research-agentcore / research-versions-spike / research-scale-limits / research-poller-lease reference only each other (poller-lease is cited from code comments, keep). Recommend deleting agentcore+versions-spike+scale-limits together if agentcore-preview-plan is retired.
- Cluster: handoff-2026-09-19, repository-audit-2026-09-19, dependency-audit-2026-09-19 (referenced by CLAUDE.md or each other); keep until CLAUDE.md drops the handoff link.
- Candidate: tracked outputs/cli/tune/tune-20260908-112932/ (CLI tuning run logs, self-referenced only); recommend git rm.
- Untracked empty dir middleware/src/lib/pipeline-deck/__tests__ left (code area, active edits).

## 2026-10-05 hygiene pass #3
- git rm docs/empty-state-audit-2026-09-16.md, url-state-audit-2026-09-16.md: findings fixed in code (UnavailableNotice branches; portal/src/lib/useUrlState.ts); the audits' resolutions live in journey logs. Unreferenced.
- git rm docs/research-data-api-limits-2026-09-16.md: absorbed by agents/_shared/result_size_guard.py (docstring carries the 1 MiB limit, AWS quotes and rationale) + test_result_size_guard.py.
- git rm docs/research-mock-total-semantics-2026-09-16.md: fix shipped; the rule is in docs/mock-floor.md and mock/core/contract.ts, pinned by scores-seed-agreement.test.ts.
- KEPT (each has a "Still open"/queued backlog section): scale-audit, table-density-audit, write-path-audit (2026-09-16). Delete once those items are done or ticketed.
- git rm -r outputs/ (mtplx MLX tuning logs, unrelated to the project, absolute paths from another machine); `outputs/` added to .gitignore.
- Sweep: no stray logs, scratch configs, screenshots or empty dirs outside protected paths (portal playwright configs are tracked; untracked portal files are source/e2e specs). Empty dirs left: middleware/src/lib/pipeline-deck/__tests__ (code), schema/synth/staged/_duplicates (gitignored scratch), .claude/worktrees (other sessions').
- Validators: component-discipline and nav-parity ALL CHECKS PASS; goal docs + validators count = 31.

## 2026-10-05 hygiene pass #4
- Sweep: no stray *.log/.tsbuildinfo/tmp configs/screenshots outside protected paths; test-results/ and portal/test-results/ already gitignored; only empty dir is middleware/src/lib/pipeline-deck/__tests__ (code, left). No .gitignore changes.
- New untracked docs today: docs/design/initiative-huddle-shell-plan.md + 3 mockup PNGs (one feature, kept together), realtime-capacity-100-calls-2026-10-01.md, claude-code-handoff-2026-10-05.md. No duplicates found among them; nothing to list.
- Audits scale / table-density / write-path (2026-09-16): each "Still open" item remains open (`large` mock scenario, fleet list view, workShared post() migration), so all three KEPT.
- Validators: component-discipline and nav-parity run; goal docs + validators count = 31.

## 2026-10-05 hygiene pass #5
- Sweep: untracked files are all source, tests, journey evidence or active docs (protected or in-flight); no junk to delete.
- git rm docs/scale-audit-2026-09-16.md: its only open item (`large` scenario) is done: `large` is implemented in bots, assessment, local-compute, distillation, org-findings, invocations, people, traces and work-items fixtures, with tests (work-items-large, bots-large, scenario-coverage).
- write-path-audit KEPT: `post()` no longer exists in portal/src/pages/work/workShared.tsx (migrated), but its other open items remain: ~20 inline fetch blocks, identity/session writes skipped in mock capture, restart-drops-pairings (only mitigated behind MOCK_PERSIST_PAIRINGS).
- table-density-audit unchanged (kept).
- Validators: goal docs + validators count = 31.

## 2026-10-06 hygiene pass #6
- Sweep: untracked files are source, tests, schemas, e2e specs, journey evidence (png/jpg under docs/*-journeys) or active docs; no logs, tmp configs, stray screenshots, s8/ or scratch dirs. Nothing deleted.
- docs/agentic-flows-migration.md (not edited): six per-slice status sections (2, 1, 3, 4a, 4 remainder, 8) appended out of order after Open questions. Not duplicative, but a tidy-up (reorder by slice, fold into Backlog) is warranted once slices settle.
- docs/design/initiative-huddle-shell-plan.md + 3 PNGs: components exist (HuddleChat, ShellCallHost, EmbeddedSocial, CallPageSharing) but the plan's own status says acceptance is still open and it is a live record. Not a candidate. Unreferenced by name elsewhere.
- Validators: component-discipline ALL CHECKS PASS; goal docs + validators count = 31.

## 2026-10-06 hygiene pass #7
- docs/agentic-flows-migration.md (untracked): folded the appended slice-status sections (1, 2, 3, 4a, 4 remainder, live push, 5, 6, 8, 9, summarize-everywhere) into a Backlog ordered by slice number, each with a "Status:" block; added an "Open decisions" list. 568 -> 505 lines, 41 -> 35 KB; facts, paths, gate results and limits kept. No script reads it.
- docs/audit-loop/: kept realtime-parity.md, cleanup-log.md, runs/, latest.md; also present and left (loop machinery): history.tsv, .state/fingerprint, latest-escalation.md. No stray files.
- Sweep: removed untracked root .DS_Store; other logs are under protected docs/realtime-validation. Nothing else.
- write-path-audit-2026-09-16.md KEPT: ~38 inline write fetch calls remain in portal/src/pages; identity/session mock-capture gap unchanged; MOCK_PERSIST_PAIRINGS still opt-in (=1).
- Validators: component-discipline and nav-parity run; goal docs + validators count = 31.

## 2026-10-06 hygiene pass #8
- Sweep: no stray logs, .DS_Store, tmp configs or screenshots outside protected paths; no *.tmp.spec.ts or scratch-*.spec.ts in portal/e2e (45 files). Untracked files are source, tests, docs or loop machinery. Nothing deleted.
- docs/audit-loop/runs/: 2 directories (2026-10-05T1949, 2026-10-05T1953-tick); kept.
- agentic-flows-migration.md (506 lines, +1 since #7) and realtime-parity.md (112 lines, no appended status sections): no duplicated status content found; not edited.
- Validators: component-discipline ALL CHECKS PASS; goal docs + validators count = 31.
