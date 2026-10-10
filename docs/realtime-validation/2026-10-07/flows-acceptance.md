# Agentic flows and realtime parity acceptance — 2026-10-07

This is the local acceptance record for the flows migration (`docs/agentic-flows-migration.md`, slices 1–12), the activity/work graph in all four tenants (`docs/activity-graph-migration.md`, §1–§10) and the realtime-parity items that shipped beside them (`docs/audit-loop/realtime-parity.md`, §4 and §4a). It is a documentation record: it restates evidence the slice records already hold and was written without re-running any suite. Nothing here was deployed, committed, pushed to a sibling main or run against AWS (the default AWS identity still returns `InvalidClientTokenId`).

## What is claimed

Every flow below runs through `orgiq-*` agents on Nova (the model constraint in the migration doc is unchanged), keeps its prompt and validator, and writes nothing to a tenant until an explicit human act (Post, Save, Accept, Approve).

| Claim | Slice | Where it runs |
| --- | --- | --- |
| Review, run-report, initiative-status and Social decks: build, edit with CAS revisions, `.pptx` download, presence and Follow, Share to Social | 1, 3, 5, 6 | all four tenants |
| Agent Revise… on every deck kind, and on assessment evidence drafts | 3, 5, 6, 8 | all four tenants |
| `/deck` from the thread (Social, assessment scorecard composer, initiative Discussion, pipelines run thread) under one write rule, `deckWriteAuthority` | 5, 6 | four tenants |
| `/summarize`, `/diagram`, `/doc` as requester-private run cards with an explicit Post or Save | 2, 12 | Social and tenant discussions |
| Durable `FlowRunStore`, revision store, live run push over the gateway | 4 | shared layer |
| Call-recording transcripts as a source for `/summarize` and `/deck`, including room calls | 7 | Social |
| Assessment evidence summary and follow-up drafts, shared across assessors, CAS-decided | 8 | assessment |
| Whole-block suggestion accept/reject for agent document edits | 9 | assessment documents |
| `/agent` loop: Nova planner, Approve, ordered steps, durable resume that fails closed on a moved epoch; creation steps (`document:create`, `meeting:create`); HITL `approval` steps (durable pause, second approver where the tenant's rule names one, 24 h expiry) | 10, increments 1–3 plus approval | Social and tenant discussions |
| Work graph (initiative, sprints, decisions, agent jobs, own flow runs, person day) over the gateway stream, one projection path parameterised by tenant | 11, activity §4–§10 | orgiq, pipelines, assessment, Social |
| Realtime parity: typing and presence, edit/delete/forward, Files view, call log, unread divider, pre-join device check, in-call reactions, page huddles, assessment-canvas cursors | parity §4a items 1–8 | per the matrix |

## Library pins

Both consumers (`portal/package.json`, `middleware/package.json`) pin, by full SHA on release branches, with both sibling mains untouched:

- `@connorhoehnslalom/ui-components` **2.427.0**, `d92b4d9747b12ea3e437df2a36f09c6b9e5ddcdd` (`release/2.427.0-masterdetail-footer`).
- `@connorhoehnslalom/realtime-modules` **0.115.0**, `7fa168e4fa294d982b5a610556831e453e06f8e4` (`feat/orgiq-0115`, unmerged, untagged). The deck engine is `@connorhoehnslalom/realtime-modules/deck` since 0.112; `lib/deck-shared` keeps only the Express/AWS glue and `pptxgenjs` is a direct middleware dependency.

The portal's `useDeckPresence` is now the library's own (`doc-editor`), adopted in `components/decks/useDeckPresence.tsx`.

## Evidence

Counts are the ones recorded in the slice records and in `CLAUDE.md` "Current checkpoint"; they were not re-measured here.

**Whole-tree gate, frozen at 08:30 on 2026-10-07 after the last code lane:** middleware typecheck and 6,534 jest tests (17 skipped); portal typecheck, production build and 1,540 tests; 16 of 17 validators ALL PASS (agent-eval, assessment-decks, assessment-documents-parity, assessment-tenant, branding, component-discipline, distillation, honest-numbers, mock-floor, nav-parity, retired-tenant removal, orgiq-audit, pipelines, rail-parity, route-coverage, search-workspace).

**Last green audit:** `docs/audit-loop/runs/2026-10-07T0846/` — component-discipline and nav-parity both pass (`gates.log`), no new or fixed findings, five low findings unchanged (`sonnet.md`). The parity tally it reports is orgiq 20/38, assessment 21/38, social 17/38, pipelines 15/38 cells still partial or missing.

**Jest suites named in the slice records (counts as recorded):**

| Area | Suites |
| --- | --- |
| Decks | `social-deck.test.ts` (18, +5 revise), `social-deck-channel.test.ts` (6), `social-decks-aurora.test.ts` (4), `initiative-decks.test.ts` (15, +5 revise), `initiative-decks-aurora.test.ts` (6), `pipeline-decks.test.ts` and `pipeline-decks-aurora.test.ts`, `assessment-decks.test.ts`, `lib/deck-shared/__tests__/authority.test.ts` (4 tenants by writer, reader, outsider, forged subject), `tenant-channels.test.ts` (66) |
| Flow layer | `lib/flow-runs/__tests__/flow-runs.test.ts` (12), `flow-run-channel-adversarial.test.ts` (7), `social-summarize.test.ts` (14), `conversation-artifact-social.test.ts` and `-tenant.test.ts` (71 together after the document-save update) |
| Recordings | `social-recording-flows.test.ts` (13), `social-platform.test.ts` (+4 transcript cases) |
| Evidence drafts | `assessment-drafts.test.ts` (16), `document-proposals.test.ts` (+6 suggestion cases) |
| `/agent` | `agent-loop-tenant.test.ts` (22, +7 approval), `agent-loop-social.test.ts` (4, +2), `lib/agent-loop/__tests__/agent-loop.test.ts` (8), `agent-loop-restart.test.ts` (3), `agent-loop-approval.test.ts` (8), `agent-loop-create-social` (6), `agent-loop-create-tenant` (7) |
| Work graph | `lib/work-graph/__tests__` (`projection`, `assessment-projection`, `social-projection`, `live`, `social-live`, `stream`) and the route suites `work-graph`, `pipelines-work-graph`, `assessment-work-graph`, `social-work-graph`; all four freeze the mock clock at midnight |
| Page huddles | `realtime-gateway-page-huddles.test.ts` (11, real router) |

Drafter tests run in the synth venv: `test_evidence_commands.py` (7), `test_agent_plan.py` (7 plus the approval case), the `summarize-conversation` command tests (4). Portal `node:test` files cover the pure clients (for example `conversationAgent.test.ts`, `tenantDeck.test.ts`, `socialRecordingPicker.test.ts`, `socialRoomSummary.test.ts`, `documentSuggestionsModel.test.ts`, `lib/__tests__/workGraph.test.ts`).

**Playwright specs under `portal/e2e`**, run headless against the shared Tilt stack (:5183/:3001) unless a private stack is named; test counts are the `test(` entries in each file:

| Claim | Spec (tests) |
| --- | --- |
| Assessment decks, Share, presence, Revise | `assessment-decks-real.spec.ts` (7) |
| Pipelines run decks, `/deck` from the run thread | `pipelines-run-decks-real.spec.ts` (7) |
| Initiative status decks, Revise, `/deck` from the Discussion | `initiative-decks-real.spec.ts` (8) |
| Social `/deck`, one write rule, cited-page revise | `social-deck.spec.ts` (6) |
| `/summarize` in Social and in tenant discussions, pins | `social-summarize.spec.ts` (3), `conversation-summarize.spec.ts` (5) |
| `/diagram`, `/doc`, assessment document Save | `social-diagram-doc.spec.ts` (3), `assessment-doc-save.spec.ts` (1) |
| Recording summaries including room calls | `social-recording-flows.spec.ts` (4, private :5292/:3092 stack with the registered fixture) |
| Evidence drafts, shared and revised | `assessment-evidence-drafts.spec.ts` (5) |
| Suggestion accept/reject | `document-suggestions.spec.ts` (4, private stack) |
| `/agent` incl. creation and approval steps | `agent-loop.spec.ts` (7) |
| Work graph, per tenant | `orgiq-activity-graph.spec.ts` (7), `pipelines-activity-graph.spec.ts` (4), `assessment-activity-graph.spec.ts` (3), `social-activity-graph.spec.ts` (4) |
| Typing and presence in all four tenants | `realtime-typing-presence.spec.ts` (5) |
| Edit, delete, forward | `message-edit-delete.spec.ts` (1), `message-forward.spec.ts` (3) |
| Files view, unread divider | `conversation-files-view.spec.ts` (2), `unread-divider.spec.ts` (4) |
| Page huddles, call log, footer | `page-huddle-context.spec.ts` (6), `page-huddle-missed-call.spec.ts` (1), `page-calls-view.spec.ts` (1), `shell-footer-everywhere.spec.ts` (2) |
| Cursors on the assessment canvas | `document-cursors.spec.ts` (2) |

Pass counts per run are in the slice records (for example `agent-loop.spec.ts` 7 pass after the approval increment; `social-activity-graph.spec.ts` 4/4; `realtime-typing-presence.spec.ts` 4/4 at the time of gap 1).

**Mock floor and routes:** wire and write snapshots were recaptured from throwaway servers for each handler change; route coverage reported 730 routes with 0 untested at the approval increment; mock-floor budgets did not rise.

## Authority model the evidence rests on

- One deck write rule: whoever may run the tenant's agent on the subject (`RunAssessmentAgent`, `RunPipeline`, `DispatchAgentRun`, Social `PostMessage` plus current membership), asked fresh per request in `lib/deck-shared/authority.ts`. A Social member holding `PostMessage` may therefore save and revise a deck someone else built; the revision CAS still 409s a stale base.
- Flow runs are requester-private on `<tenant>:flowrun:<id>`; the tenant is fixed by the id prefix and every subscribe and delivered frame re-reads the session and the durable row.
- The drafter's tenant guard is per mode, not a wider tenant list (`agents/_shared/tenant_guard.py`, `narrative-modes.ts`). The three Revise modes and the orgiq and pipelines narrative modes serve one tenant each; every other mode serves assessment only.
- Work graphs follow each tenant's REST read gate per part, withhold with `authorization-unavailable` when Cedar fails, and carry content-free hints on default-deny families (`orgiq:workgraph`, `pipelines:workgraph`, `assessment:workgraph`, `social:workgraph`).

## Limits

- **Local only.** No Aurora SQL has run on a live cluster for `flow_runs` (including `pause`, `resumeWaiting`, `expireWaiting`, `listWaiting`, `requeueRevision` and the widened status CHECK), the deck, draft and relation tables, or the evidence-draft `listScope`. Mock and fixture stores prove behaviour, not the SQL.
- **Social `/deck` narrative (closed).** The build now asks its own `social-deck` mode (guard row, prompt, `lib/deck-shared/narrative-modes.ts`), so a live Social deck is no longer refused; a refusal or error still falls back to template prose. Not exercised against a real Bedrock drafter.
- **Box steps and live transcription are cloud-bound.** `/agent` has no devbox step kind and no re-planning after a failure; there is no live transcription.
- **Recordings.** Transcripts over 400 segments are cut at the first 400. Real platform-api transcripts were not exercised against the SFU. The four recordings journey logs stay `limited` because the Tilt stack's platform-api holds no recordings, which is the one red validator (social-tenant, S2); the recording specs pass on a private stack with the seeded fixture.
- **Browser coverage of `/agent`.** Playwright covers Social and the orgiq Discussion; assessment, pipelines and huddles are jest and pure-test only, as are the assessment-document and lobby creation steps. A created room does not invite the conversation's members, and a huddle step records a lobby without ringing anyone.
- **Approvals.** A second approver's later steps run as them, so the requester's card cannot follow those child runs.
- **Run visibility.** A deck revise run in pipelines is requester-private; a teammate's page shows the revision on its next load. Evidence-draft progress for teammates is by polling.
- **Work graph.** Delivery is per process; two-node delivery relies on the router's per-recipient authorize and was not exercised. Deltas are re-authorised snapshots, not watermarked replay; node detail panes and omitted-node paging are not built. Devbox terminals and chat nodes are not drawn. The orgiq pop-out has no day picker.
- **Parity.** Cursors are wired on the assessment canvas only; the orgiq, Social and pipelines canvases are not. Huddle chat and page sharing stay orgiq-only, so a team or run huddle has no Message-in-call pane. The bell item that indexes page-discussion threads is lost on a memory-inbox restart. The collaborative diagram board has no library composite. Unverified for lack of a second live participant or media: screen share, real file upload in assessment document chat, pipelines run status frames, DM typing between two browsers.
- **Audit loop staleness (closed).** `docs/audit-loop/latest.md`'s divergence list now matches the parity matrix (agent-loop cards and typing shipped, §4a items 1 and 7).
- **Journey logs.** Page edits made some journey-log digests stale (assessment dashboard and scorecard, Social); they were deliberately not sealed to clear a digest.
- **Capacity.** Not part of this record. The 100-call, 1,000-socket profile stays unaccepted and sizing is the owner's decision (`CLAUDE.md`, capacity section).
- **Rooms are Social-only by design;** other tenants have no rooms service.
