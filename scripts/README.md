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
| scripts/validate-newsroom-removal.sh | kept, stripped | Checks the retired tenant is gone from code; the docs, archive, journey and assessment-judge checks were removed. Passes with `--quick`. |
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
| merge-check.sh | new, 27 November | The check to run before merging a package: typecheck, portal tests, a snapshot recapture against its own mock server, the voice inventory and the full middleware suite. `--quick` skips the full suite. |
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

## Second pass (7 Nov 2026)

| File | Decision | Why |
|---|---|---|
| scripts/demos/ huddle storyboard tools (audit-huddle-artifacts, check-huddle-lip-sync, export-huddle-handoff, generate-huddle-preview, generate-huddle-speaking, generate-huddle-speech, prepare-huddle-media and its test, huddle-media-contract and its test, rehearse-huddle-speaking, validate-huddle-transcripts, sadtalker-mps.patch) | removed | Read `docs/demos/work-huddles/storyboard.json` and `completion-audit.json`, which were removed. Recoverable from git history (5b6b828c). |
| scripts/demos/observe-huddle-recordings.mjs, recording-pipeline-acceptance.mjs and its test | kept | Do not read the storyboard; the test passes (10 of 10). |
| scripts/demo-content/judge.mjs, xref.mts, prose.mts, fixtures.mts | removed | Judge for the removed demo-content goal and audit docs. |
| scripts/demo-content/rubric.mjs, merge-probe.mjs | kept | `portal/e2e/demo-content-probe.spec.ts` imports the rubric; the merge writes under `docs/demo-content`. |
| scripts/runbooks/brief-contract.mjs | removed | Re-records `docs/journeys/contracts/session-brief*`, which is gone. |
| scripts/journeys/work-journeys.mjs and the meeting-proof, assessment-profile and social-maps tests | removed | Read removed goal docs, removed judges or removed map files. |
| scripts/journeys/ runner (run-maps, walk, maps, journeys, seal, measure) | kept | Runbook mock bundles and `portal/e2e/realSession.ts` name it. The map and log trees it walks were removed, so it has nothing to walk until maps are written again. Its tests pass (maps 15, walk 17); two tests that needed the removed maps were dropped. |
| scripts/audit-loop/run.sh | fixed | Dropped the removed `docs/ui-components-queue.md` from the audited paths. Not run (it calls Claude). |
| `portal/e2e/user-search-probe.spec.ts`, `user-search-catalog.ts` | removed | Imported the user-search scripts deleted in the first pass. |

Everything else that mentions `docs/` only does so in a comment, or writes output under a `docs/` folder it creates (`docs/audit-loop`, `docs/demo-content`, `docs/journeys`). Those are left as they are.

## Added since the second pass

Tools written after 7 November. "Needs" says what must be running or configured; none of these were run when this table was written.

| File | Decision | Why |
|---|---|---|
| validate-interviews.sh and validate-interviews.d/ | new | Judge for the Candidates tenant (`docs/interviews-tenant-plan.md`). `--quick` is static checks only; the full run starts its own mock stack and walks the journey in a browser. |
| validate-learning-loop.sh | new | Judge for the learning loop (`docs/learning-loop-design.md`). Runs the learning-loop journeys through `journeys/run-demo-moments.mjs`, which starts its own mock stack. |
| validate-ui.sh | new | Definition of done for a change under `portal/src`: the ui-components lint, the component-discipline judge, then the packaged DOM audit on each route you name with `--route`. The audit step needs a running stack. |
| audit-ui-inheritance.cjs and its test | new | Reports composition drift as well as raw HTML under `portal/`; `--check` enforces only the documented contracts. Static; run after `npm ci` in `portal`. |
| count-hitl-modals.py | new | Counts human-in-the-loop decisions asked in a modal instead of the composer deck; used as a ratchet by `validate-component-discipline.sh`. Static. |
| count-raw-typography.py | new | Counts raw `text-` and `font-` utilities on bare elements in `portal/src`; used as a ratchet by `validate-component-discipline.sh`. Static. |
| gen-tenants.mjs | new | Writes the TypeScript and SQL that every consumer of `tenants/manifest.json` imports; `check-tenant-manifest.mjs` verifies them. Static. |
| install-committed-library.mjs | new | Installs tracked release artifacts without re-preparing unchanged Git dependency graphs. Needs network and GitHub access; run `npm install` first after a dependency change. |
| profile-portal-bundle.mjs | new | Builds a throwaway production bundle and reports which modules make it up. No server. |
| document-workspace.mjs | new | Starts isolated local document services from the owning project's Compose stack. Needs Docker. |
| docker/ | new | Build and push scripts for the middleware and document-workspace images and a locked install. Need Docker; the push scripts need registry credentials. |
| avatars/ | new | Generates and backfills seed portraits. Generation and hosted checks need external services. |
| dev/ | new | `social-sim.mjs` logs in seeded Social users and holds them online so the local demo looks populated; needs a running mock middleware. `native-speech-cli.py` is a local speech helper. |
| lib/ | new | Shared shell and Node helpers for the judges and journeys. Not run directly. |
| loadtest/ | new | Compose files and a driver for realtime call and chat load tests; see its own README. Needs Docker. |
| research/ | new | One-off probes of the document canvas, toolkit and container store. Not part of any judge; most need a running document stack. |
| learning-loop/ | new | `debrief-e2e.mjs` and `local-report-e2e.mjs` prove acceptance items 13 and 10 on a test stack of their own with a stub `claude`; no paid model calls. |
| voice/inventory.mjs | new | Derives what the application can do and what the voice catalogue covers, and writes `docs/voice-tool-inventory.json`. Static. |
| voice/sessions-to-replay.mjs | new | Turns the middleware's voice session logs into the replay fixture described in `docs/voice/replay.md`. Reads local logs only. |
| voice/probe-realtime.mjs, voice/probe-voices.mjs, voice/probe-middleware-body.mjs | new | Probes of the OpenAI Live API: the handshake and tools, the voices on offer, and the exact session body the middleware mints. Need an OpenAI key and spend money. |
| voice-harness/ | new | Feeds recorded scenario speech into a Live session or the hands-free gate and scores it. `gate.mts --driver fake` needs no key; `--driver direct` needs an OpenAI key and audio clips. Run from `middleware/`. |
| milo-judge/ | new | The Milo judge and the model bake-off for the Decide call, run with `npm run milo-judge` from `middleware/`. The scripted and perfect rigs need no key; the `owner` rig and the bake-off call OpenAI. |
| milo-probe/probe.mts | new | Measures latency and tool choice for the Milo rebuild design in text, speech and live modes. Needs an OpenAI key. |
| meeting-assistant/ | new | Scenario suite for the meeting assistant (`scenarios.mjs`), a stand-in for the media server's audio taps (`tap-sim.mjs`), the decision watcher's one paid check (`watcher-check.mjs`, prints the request without `--yes`) and the end-to-end run with real audio (`live-e2e.mjs`, `--dry` uses a fake provider). |
| journeys/demo-moments.mjs, journeys/run-demo-moments.mjs | new | The five demo moments of `docs/demo-script.md`; the runner starts its own mock middleware and portal, runs the journey and stops them. See `docs/journeys.md`. |
| journeys/learning-loop*.mjs, voice-coverage.mjs, meeting-assistant.mjs, interviews.mjs, call-chat-unread.mjs, budgets-audit.mjs, budgets-selection.mjs, leftovers2-walk.mjs | new | Browser journeys for single features, run through the same runner on the mock world. The learning-loop, voice-coverage and meeting-assistant ones use no model; `leftovers2-walk.mjs` takes `PORTAL_URL`, `MIDDLEWARE_URL` and `OUT_DIR` for a stack that is already running. |
| journeys/desktop-audit.mjs, journeys/gateway-refusal.mjs, journeys/clone-dm.mjs | new | Audit helpers on the journey stack: the desktop-width contract audit, a read-only tenant isolation proof against the realtime gateway, and a rule that DM journeys post only between fresh clones. Need a running stack. |
| journeys/measure.sh, journeys/seal.sh, journeys/journey-vite.mjs, journeys/journey-map.ts | new | Measure each route's rendered contract on a shared stack, seal a journey log directory after a walk, and the Vite and map helpers the runner uses. Need a running stack; the log trees they write to were removed. |
| journeys/maps.mjs, journeys/walk.mjs, journeys/run-maps.mjs | new | The journey-map runner: load and validate maps, walk one in a browser, command-line entry. Nothing to walk until maps are written again (see the second-pass table). |
| demo/ | new | Demo films. `assistant-meeting-film.mjs` records Milo in a call on the mock world (`--live` uses a real model); `interviews-call-film.mjs` and `interviews-board-film.mjs` record a coding round and a whiteboard round; the `.py` files compose, voice and review the cuts. They start their own stacks and need ffmpeg, a browser and, for voices, local text-to-speech. |
