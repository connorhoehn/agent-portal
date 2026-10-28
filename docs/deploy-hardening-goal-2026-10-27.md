# Deploy hardening: fix what the specs found, locally (2026-10-27)

Definition of done for the fixes found while speccing
`docs/deployment-enhancements/` (DE-1..DE-53). Only work that can be finished
and proven **without AWS access** belongs here; anything needing the deployed
stack goes to "Owed from the deploy machine". Work in small batches, one
commit per fix, middleware/infra suites green before each push.

Rules for whoever continues (including an hourly loop):
- Read this file first; take the first row that is not `done`.
- No cloud apply, no shared mock reset, no business-data cleanup, no pattern
  pkill; stop only processes you started. Keep the single-gateway safeguard.
- Never decide an item's "Decisions owed"; implement the part that needs no
  decision and record the rest here.
- Run full suites alone (middleware jest, infra `npm test`); recapture the
  wire snapshots on a throwaway :3012 server when a response shape changes
  (docs/mock-floor.md § Regenerating the snapshots).
- Update this table and push after each batch.

| # | Fix | Spec | Done when | State |
|---|-----|------|-----------|-------|
| 1 | Chat memory is per user, never `?actorId=` / body actor | DE-8 | sessions + agents tests prove another user's actor is ignored; no session reads nothing | done (`16e28942`) |
| 2 | SDLC guard counts enabled policies | DE-43 | an all-disabled policy set routes to a person (sdlc-writes test) | done (`9cd6e89e`) |
| 3 | Clone runs server-side; token never reaches the browser | DE-44 row 12, DE-45 | route returns no `command`, scrubs git output, refuses an unreachable box; wire snapshot recaptured | done (`09ebcdef`); middleware 7,575 tests green |
| 4 | Devbox org access uses `orgiq_graph_reader`, not the master secret | DE-40 | synth test: master secret absent from the devbox stack | done (`9e759817`) |
| 5 | deploy.sh inference stops on a failed read | DE-16 | live_read test with a fake `aws` (bash 3.2) | done (`83f0b9dc`) |
| 6 | Shared scope check + bots create/patch/run, codebase link/runs | DE-44 rows 1–3, 10, 14 | `requireInitiativeScope` in lib/initiative-scope.ts; deny tests per route (attached-nowhere sme 403, steward pass, org-leader bypass) | open |
| 7 | SDLC decide/address/deliver, POST /work/jobs, internal task/shell-url | DE-44 rows 6, 16–18, 24–25 | same deny tests; internal routes check `requestedBy` reaches the box and stop auto-registering unknown sessions | open |
| 8 | Medium rows of DE-44 that need no decision | DE-44 rows 4, 7, 8, 11, 13, 15, 19, 22, 26 | deny tests | open |
| 9 | DE-44 matrix test: a new write route without a scope row fails | DE-44 | `routes/__tests__/initiative-scope-matrix.test.ts` | open |
| 10 | deploy.sh carries `deployDevbox`, lab values and `deployTurn` forward | DE-51, DE-52, DE-23 | inference test like #5 | open |
| 11 | `onlyAgents` cannot delete runtimes it leaves out on a live stack | DE-1 | synth guard + test | open |
| 12 | Guardrail editor reads the per-role ids the BFF actually sets | DE-12 | config test; deployed env has a usable id | open |
| 13 | Agent runtime session ids are scoped to the caller | finding while fixing DE-8 | a client-supplied sessionId cannot continue another user's runtime session; test | open |

## Owed from the deploy machine

- Rebuild and roll the middleware image (realtime-modules 0.140.0 call fix,
  rows 1–3 above), then `cloud-call-smoke` with `CLOUD_SEAT_SETTLE_MS=0`.
- Redeploy `OrgIQ-Devbox` if `devboxOrgAccess` is on (row 4).
- Existing chat transcripts live under the old shared `portal-default` actor
  and are no longer listed after row 1 ships; decide whether to migrate or
  drop them (they mix every user's turns).
