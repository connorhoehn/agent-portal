# Agentic flows migration — realtime-examples to the four tenants

Status: all twelve slices are shipped locally and judged on the dev:mock stack;
the evidence and its limits are collected in
`realtime-validation/2026-10-07/flows-acceptance.md`. Slice 1 (assessment review
decks) is specified in `assessment-deck-goal.md`. This document is the single
record of everything after it. Sources read: `realtime-examples/frontend/src/chat`,
`.../components/doc-editor`, `platform-api/src/{chat,documents,deck,pipeline,recordings,loop}`
and `src/routes`. Library exports were checked in `portal/node_modules`
(ui-components 2.410.0, realtime-modules 0.107.0).

## Model constraint

Every platform-api model path goes through `LLMClient`: `AnthropicLLMClient`,
`BedrockLLMClient` (which sends the Anthropic payload with
`anthropic_version`, and maps to `us.anthropic.claude-*` ids), or
`ClaudeCodeLLMClient` / `ClaudeCodeAgentClient` (the Claude CLI). The "light
model" in comments is Haiku. None of these may be called here. Each flow below is
ported by keeping its prompt and validator and moving the call to Nova through
`orgiq-*` agents (the deck slice already does this with `orgiq-assessment-drafter`).

## Inventory

| Flow | Trigger and shape | Inputs and artifacts | Models in source | Library pieces |
|---|---|---|---|---|
| `/deck` (`deck-generate`) | chat command; read-history, read-sources, draft, render | `#` documents, `--from transcript` recording id, `--preview`. Writes a presentation document revision (`.pptx` plus SVG per slide plus `DeckSpec`). | Haiku (Anthropic) | `ChatCommandProvider`, `PresentationEditor`, `PresentationView` (ui-components `/doc-editor`) |
| `presentation-deck` | run draft from a document composer, sources attached | many source docs, one grounded deck, each slide cites a source | Anthropic | `useRunDraft` (realtime-modules client documents) |
| `deck-revise` | composer edit: load, propose, check, write | spec, slide or bullet target, `baseRevisionId`; CAS revision or `revision-conflict` | Anthropic | `useDeckReviseStatus`, `ContextComposer`, `PresentationEditor` |
| `/summarize` | chat command; read-history, plan, apply, publish | thread (up to 200 messages); a page with an action-items checklist; private run card until posted | Haiku | `ChatCommand`, `AgentRunCard` |
| `/doc` (`document-agent-edit`) | chat or comment; plan, approve (big model), apply | writes tracked-change suggestions into the Y.Doc as collaborator `agent:haiku` | Haiku plus a larger approved model | `SuggestionCard`, `ProposalCard`, `useCRDT` |
| `/transform` | chat; source page to a known document type | new page of the chosen type | Anthropic | `DocTypeProposalRow`, `useDocTypeProposals` |
| `/diagram` | chat; description to drawio/diagram doc | new diagram document | Anthropic | diagram export |
| `document-summary`, `document-action-list` | "Create from this" menu; check, read, plan, review, approve, apply | one source doc to a new page; check step enforces read on source and edit on target | Anthropic | `useRunDraft` |
| Comment agent, review requests, automations | comment mention or rule; resolver then edit run | `commentAgentRequests`, `documentAutomations`, `documentReviewRequests` | Anthropic | comment threads in `/doc-editor` |
| `/agent` loop (`agentLoopPlanner`) | plan 1-6 steps with acceptance, run in a cloud box | budget, steps, devbox lab, `meeting:create`, `deck`, `document:create` step kinds | Claude CLI only | `AgentRunCard`, `useChatCommands` |
| `call-transcription` / `recording-finalize` | LVS webhook; transcribe, summarize, store, publish | recording id; speaker-tagged transcript; meeting-notes summary row | local speech engine plus Anthropic summary | `useVideoHangout`, call dock |
| Judges (`pipeline/judge`) and approvals | step gate; `approvalNode`, `routes/approvals` | score aggregates; approved / rejected / changes_requested log | Anthropic | `pipelines` client exports |
| Image/vision pipeline previews | pipeline step previews | image fetch, adjust layer, OCR | Anthropic vision | out of scope for tenants |

Cross-cutting pieces worth keeping: `modelSlots.ts` (per-purpose concurrency
pools and a wait-in-line signal), `modelGate` (breaker), run cards with
`runCardMetadata`, and the rule "the model never decides what is true"
(citation validator, `deckConstraints`).

## What already exists here

- Deck engine from `@connorhoehnslalom/realtime-modules/deck` (formerly vendored); assessment deck routes in
  `routes/assessment-decks.ts`; portal `pages/assessment/decks/` (DeckPage,
  CreateDeckDialog, ShareToSocialAction, `useDeckRun`).
- `agents/assessment-drafter` command modes (`document_commands.py`:
  `draft-confluence-page`, `suggest-confluence-content`, `validate-outputs`,
  `draw-diagram`, plus `draft-review-deck` / `revise-review-deck`) with
  source-span validation. Output contracts are already "drafts in the run ledger".
- `assessment_runs`, `launchRun`, `lib/assessment-dispatcher.ts`, Runs page.
- Pipelines tenant: `routes/pipelines.ts`, `lib/pipeline-runs.ts` run projection,
  `runReadHandlers` facade at `/api/runs` (orgiq) and `/api/assessment/pipeline-runs`;
  portal `RunsPage`, `RunDetailPage`, `PipelineRunLive`.
- Bots and `agent_jobs` dispatcher (`job-dispatcher.ts`, `bot-runner.ts`) for orgiq.
- AG-UI agents through `routes/agents.ts`; distillation store; call pages and
  call chat (`routes/call-pages.ts`, `routes/call-chat.ts`); Social gateway chat
  and uploads for sharing bytes.
- Not present: any `/deck`-style chat command registry in the BFF, a recording
  transcript summarizer, a shared revision store, collaborative deck presence.

## Tenant mapping

| Tenant | Flows to bring | Why |
|---|---|---|
| assessment | review deck (slice 1), evidence summary page, follow-up drafting (`document-summary` / `action-list` on a claim), `/doc` suggestions already proposed | Closest to done: drafter, runs and evidence spans exist. Follow-ups feed the existing recommendations. |
| social | `/deck`, `/summarize`, `/agent` later; call recording summary card; deck editor presence | Chat is where the commands live; `ConversationRail` and `ChatCommandProvider` are in the installed library. Private-until-posted cards fit channels and DMs. |
| orgiq | initiative status deck (work items, budgets, sprints, maintenance floor), huddle transcript to summary, distillation digest deck | Numbers come from `providers/work-items` and `program` data, so deterministic facts plus Nova prose is the same pattern as slice 1. |
| pipelines | run report deck (steps, cost, failures), run summary on the run detail page | Run projection already exists; a report is a read of it. Gives operators a shareable artifact. |

## Generalization: a tenant-agnostic agentic flow layer

Slice 1 hardcodes decks to assessment. The shared shape, to extract after a
second tenant needs it (not before):

- **Flow definition** (code registry, `middleware/src/lib/flows/`): `id`,
  `tenant`, `artifactKind` (`deck` | `page` | `report`), `requires` (Cedar
  action), `gatherFacts(session, params)` returning deterministic facts and
  citable sources, `command` (drafter mode name), `validate(response, facts)`,
  `assemble(facts, narrative)`. Facts are filled by code; the model writes prose
  only, and spans must be verbatim.
- **Run record**: reuse the tenant's existing run store through one
  `FlowRunStore` interface (assessment: `assessment_runs`; pipelines/orgiq:
  `agent_jobs` plus the run projection; social: projection only). Fields:
  `flowId`, `artifactId`, `requestedBy`, `status`, `progress`, `producedRevisionId`.
- **Drafter**: one Nova agent entry point per tenant (`orgiq-<tenant>-drafter`)
  speaking the same envelope as `document_commands.py`
  (`{summary, content, source_spans}`), with `MOCK_AGENTCORE` returning a
  deterministic narrative.
- **Artifact revisions**: generic `flow_artifacts` + `flow_artifact_revisions`
  (append-only, `baseRevisionId` CAS, `producedBy` run id, locked slides),
  with a registered mock fixture. Assessment decks migrate onto it last.
- **Share**: the explicit-act upload path from the deck goal, decision 6,
  extracted as `shareArtifactToConversation`. Bytes, never references.
- **Portal**: a `FlowRunProgress` plus `useFlowRun`, extracted from
  `useDeckRun` / `DeckRunProgress`; editors stay the library's
  (`PresentationEditor`, `EditorShell`).

## Backlog (by slice number)

Sizes: S under a day, M one to three days, L more. Every shipped slice is local
and mock only: no AWS, and no Aurora SQL has run on a live cluster.

### 1. Deck page collaboration (M) — DONE 2026-10-05

Goal: two people on one deck see each other and follow the slide, as in
`PresentationEditorPage.tsx:527-575`.

Status: `/assessment/decks/:id` joins presence `assessment:deck:<id>` (new
presence-only family in `tenant-channels.ts`, ViewAssessment) and publishes
`deckSlide` metadata; `slideViewers` feed the filmstrip, `EditorShell` shows
avatars with Follow, `FollowModeBar` plus `selectSlideRequest` follows a
person's slide. The footer is a `ContextComposer` (agent mode) calling the
existing revise route. Editor `sources` come from the spec's slide citations.
Without a gateway the editor works and presence is hidden. Tests: `decksPresence`
node:test cases; e2e case (g) in `assessment-decks-real.spec.ts` (6/6 on a
private stack). Spec (d) lost a stale `details-summary` click (not in
ui-components 2.410.0). `useDeckPresence` is now the library's own (`doc-editor`), adopted in `components/decks/useDeckPresence.tsx`.

### 2. Social `/summarize` in channels and DMs (M) — DONE 2026-10-05

Goal: a private run card that writes a summary of the thread, then "Post to
conversation". Reference: realtime-examples `summarizeCommand.ts`,
`MessagesPage.tsx:2115`; platform-api `chatCommands.ts:76` (member check) and
`conversationSummarizePipeline.ts:37` (200 messages).

Status:
- Agent: `orgiq-assessment-drafter`, new document command `summarize-conversation`
  in `document_commands.py` (reuses the verbatim-`source_spans` validator; spans
  must be single-message quotes; 4 synth-venv tests; no `main.py` change).
- BFF: `routes/social-summarize.ts` at `/api/chat/commands` (`POST /summarize/run`,
  `GET /summarize/runs/:id`, `POST /summarize/runs/:id/post`),
  `lib/social-summarize.ts`, `lib/social-summarize-range.ts`, fixture
  `mock/social-summarize-runs.ts`. Reading uses `chatAccess` (exported from
  `chat-pins.ts`: grants + live membership) and `messageVisible` (history floor,
  deletions). Runs are requester-private and durable (slice 4a). `/post` needs
  PostMessage, returns the server-built message once, and the portal sends it
  over the gateway; nothing posts without that act. No new Cedar action.
  `MOCK_AGENTCORE` returns a deterministic digest through the same validator; an
  invalid or failed agent answer falls back to it (`fallback: true`).
- Portal: `ChatCommandProvider` in `SocialConversation.tsx`, `socialSummarize.ts`,
  `SocialSummaryCard.tsx` (library `AgentRunCard`, `MarkdownView`).
  `WrappedChatPanel` has no `localMessages`, so the private card sits above the
  thread, not inside it.
- Tests: jest `social-summarize.test.ts` (14), portal node:test (6), Playwright
  `e2e/social-summarize.spec.ts` (3, private :3071/:5271 stack).
- Open: no document sources (recorded calls: slice 7).
- Beyond Social (2026-10-06): shared core `lib/conversation-summarize.ts`
  (transcript, digest, verbatim-quote check, durable run on `lib/flow-runs`, post
  message) with `defineSummarizeFlow({ tenant, kind, idPrefix, agentAuth })`.
  Social is one flow on it (wire and drafter call unchanged); new flows
  `orgiq.summarize` (`osm-`), `assessment.summarize` (`asm-`), `pipelines.summarize`
  (`psm-`). Route `routes/conversation-summarize.ts` at
  `/api/conversations/summarize` (`POST /run`, `GET /runs/:id`, `POST /runs/:id/post`);
  the channel names the conversation: a chat-bearing family
  (`orgiq:initiative|work|session|invoke`, `assessment:doc`, `pipelines:run|def`) or a
  huddle `orgiq:huddle:<callId>`; Social, presence-only families and anything else
  are 400. Authority (`live-principal.ts authorizeConversationChat`), fresh per
  request, no cache: families ask `authorizeLiveGatewayChannel` on the bare chat
  name (subscribe to read, publish to post), then the chat store's membership rows,
  then a second directory reload; huddles ask `CallChatRuntime.assertMember` (actual
  seat, active floor, Social ViewSocial/PostMessage), then a reload. `/run` re-asks
  after reading the transcript, so a revocation mid-read stores nothing. History
  floors and deletions are honoured. Ownership is asked first, so an unknown or
  someone else's run is one 404. Push: `osm-`/`asm-`/`psm-` map to
  `<tenant>:flowrun:<id>`; `authorizeFlowRunChannel` decides these kinds by the
  run's conversation authority plus requester, never the tenant's broader grant;
  an unknown kind is refused; portal `isLiveFlowRunId` follows. Nova: the drafter
  is called with `auth: { tenant }`; its guard serves only `assessment` and was
  NOT widened, so orgiq and pipelines runs fall back to the deterministic digest
  with `unavailable` naming the refusal, shown on the card. Portal:
  `components/chat/conversationSummarize.ts` (pure; Social's `socialSummarize.ts`
  is its binding), `ConversationSummaryCard.tsx`, `useConversationSummarize.tsx`,
  `SummarizableChatPanel.tsx`, wired into pipelines run/definition discussion, the
  assessment document Chat panel, orgiq session chat (flag-gated) and the huddle
  panel; huddle posts carry no `summaryOf` metadata, so a later summary can quote
  an earlier one. Tests: jest `conversation-summarize.test.ts` (47, per family:
  reader, membership-row and policy non-reader, cross-tenant, revocation during
  policy/membership/transcript read, history floor, privacy, post authority,
  drafter refusal fallback, run channel, huddle seat/floor/PostMessage/leave),
  node:test `conversationSummarize.test.ts` (3) and `flowRunFollower` ids,
  Playwright `conversation-summarize.spec.ts` (2) and `social-summarize.spec.ts`
  (3) on a private :3093/:5293 stack. Wire snapshots recaptured; new writes
  refused by `conversation-private-run`. Update 2026-10-06: orgiq initiative/work families now have a chat UI
  (`ScopeDiscussion.tsx` on the initiative overview and the work item's Discussion tab, via
  `SummarizableChatPanel`); Playwright `orgiq-scope-discussion.spec.ts` (2) covers the private
  card for the requester only. Open: no browser pass of the assessment, session or huddle surfaces.

### 3. Pipelines run report deck (M) — DONE 2026-10-05

Status: from a run detail page (`RunReportDecks`, on the pipelines tenant's own
door only), a `RunPipeline` holder builds a deck from the run projection; every
number (steps by status, duration, cost, approvals pending, artifacts, step
durations chart) is read in `lib/pipeline-deck/facts.ts`. Optional Nova narrative
reuses the drafter's `draft-review-deck` (its `teamId` carries the run id; the
agent checks only slideId/facts/evidence), merged by the assessment deck's
`mergeDraft`, so a non-verbatim span or invented number keeps template text;
`MOCK_AGENTCORE` returns the offline narrative and an unreachable agent reports
`unavailable` and falls back. Routes `/api/pipelines/runs/:id/decks`, `/decks`,
`/decks/:id`, revisions (CAS 409), preview, `.pptx` file; gates `ViewPipelines`
(read, preview, download) and `RunPipeline` (generate, edit); no new Cedar action.
Storage `schema/pipeline_deck_schema.sql` (registered in both loaders) and the
`pipelines.decks` / `pipelines.deck-revisions` fixtures. Portal:
`/pipelines/decks/:deckId` (library `PresentationEditor`), Share to Social via
the assessment `ShareToSocialAction` (new optional `fileUrl`) and `useDeckPreview`
(new optional render fn). Agent revise landed 2026-10-06 (below).
Collaboration (2026-10-05): presence avatars, filmstrip `slideViewers` and Follow.
Channel `pipelines:deck:<id>` is a presence-only family in `tenant-channels.ts`
(pipelines session + `ViewPipelines`, no lobby, default-deny intact; 5 new test
cases). Shared code in `portal/src/components/decks/`: `useDeckDocument(deckId,
api)` (load, spec fetch, save, 409, reload-latest), `useDeckCollaboration`,
`DeckConflictBanner`, pure `deckDocumentModel` (node:test); both deck pages use it;
`DeckPresenceSource` takes a `tenant` prop. This was the second consumer slice 4
needed.
Evidence: jest `pipeline-decks.test.ts`, `pipeline-decks-aurora.test.ts`, node:test
`pages/pipelines/decks/__tests__`, Playwright `pipelines-run-decks-real.spec.ts`
(4 pass on :5261/:3061; with `assessment-decks-real`, 11 passed, 1 skipped).
Known limits: the pipelines cast (u-ines, u-kofi, u-dara) holds no social grant,
so Share is offered only to holders of one (u-operator is admin everywhere); decks
are not in the nav (reached from the run page); a run's approvals are the pending
ones only. Wire/write snapshots for these routes needed a recapture.

Agent revise (2026-10-06): `POST /api/pipelines/decks/:id/revise` (gate `RunPipeline`;
body `{ instruction, slideId?, baseRevisionId }`) answers 202 `{ runId }`. A stale
`baseRevisionId` is 409 `{ error, activeRevisionId }`, a locked slide 409 without it, a
fourth concurrent run 429. The run is a durable flow run (`lib/flow-runs`, kind
`pipelines.deck-revise`, id prefix `pdr-`, scope = deck id, private to the requester;
only ids and the instruction are stored, the facts are rebuilt when it executes).
`providers/pipeline-decks.ts` `reviseExecutor` builds `buildReviseInput` from the run
projection, asks `revise-review-deck`, and merges with the shared `mergeRevise`
(facts re-applied everywhere, locked and out-of-scope slides kept, measurable
constraints in the instruction checked), then appends one revision with `producedBy` =
the run id through the same revision store (CAS again on append). A refused or
unchanged edit completes with `revisionId: null`. `GET /decks/:id/runs/:runId`
(`ViewPipelines`, requester-only, 404 for anyone else, another deck or another kind) is
the record behind the push. Push: `pdr` joins `FLOW_RUN_ID_TENANT` (`pipelines`) and
`authorizeFlowRunChannel` admits `pipelines:flowrun:<id>` to the requester only,
re-asking active tenant + `ViewPipelines` + the durable row per subscribe and per frame
(7 adversarial cases in `flow-run-channel-adversarial.test.ts`).
The reviser is `revise-pipeline-run-deck` (the per-mode drafter guard; see Open decisions), reached
through `shared.reviseWithAgent('pipelines', ...)`; a refusal, error or empty answer falls back to the
deterministic reviser (the offline drafter's `mockReviseResult`, same merge) and the run result reports
`engine: 'fallback'` (`'offline'` under `MOCK_AGENTCORE`, `'agent'` when the drafter answers). Portal: the
composer and run banners moved to `components/decks/` (`DeckComposer`, `DeckRunProgress`)
with one shared `useDeckAgentRun` hook that assessment's `DeckPage` and
`PipelineDeckPage` both use through `DeckEditorPage`'s `useExtras`; the run is followed
with `useFlowRun` (`pdr` is a live id). Evidence: jest `pipeline-decks.test.ts` (10 new:
authz, CAS, validation, locks, requester privacy, cap, agent unavailable, bad merge,
invented number), node:test `pipelineDecksApi.test.ts` (3 new) and the live-id case,
Playwright `pipelines-run-decks-real.spec.ts` (f) instruct -> new revision (6 pass on a
private stack; the assessment instruct case still passes). Write policy refuses
replaying the route (the executor writes after the response). Known limits: the run is
requester-private, so a reload mid-run or a teammate's page does not show it (the deck
detail has no `pendingRun`; the revision appears on the next load); the deterministic
reviser can only reword, shorten or add a note, and "tighten" on a slide with no prose
bullet changes nothing the constraint check accepts, so that run fails visibly.

### 4. Extract the flow layer (L) — DONE 2026-10-05/06

Pulled `FlowRunStore`, the revision store and `useFlowRun` out of the deck slice
using slices 2 and 3 as consumers. Assessment deck judge still passes unchanged.

Status, 4a durable `FlowRunStore` (2026-10-05):
- Store `middleware/src/lib/flow-runs/` (`store.ts`, `dispatcher.ts`); Aurora table
  `flow_runs` in `schema/flow_runs_schema.sql` (additive; registered in
  `load_schema.py` and `apply_all_seed.py`); mock fixture `flows.runs`
  (`mock/flow-runs.ts`, clock from `mock/core/clock.ts`, cleared by
  `/api/__mock/reset`). Fields: id, tenant, kind, requester, scope, status
  (queued/running/completed/failed), progress steps, input, result, meta, error,
  attempts, lease owner/expiry, timestamps.
- Single executor: `claim()` is one `UPDATE ... FOR UPDATE SKIP LOCKED`; progress
  and finish are fenced on the lease owner; a heartbeat extends the lease.
  `expireLeases` (startup and every 5 s via `startFlowRunDispatcher` in `index.ts`)
  re-queues a lapsed run while attempts remain, else fails it visibly. Finishing
  clears the run's private input.
- `/summarize` (kind `social.summarize`, 2 attempts) stores the readable transcript
  lines as input so any node can run it. Reads are requester-only (`getFor` filters
  tenant and requester) after the `chatAccess` re-check. "Post" is an atomic
  once-only claim (`setMetaOnce`).
- Tests: `lib/flow-runs/__tests__/flow-runs.test.ts` (12: restart durability,
  single-executor race, lease fencing, expiry re-queue and exhaustion,
  requester-only reads, SQL shape); `social-summarize.test.ts` unchanged (14).
- Follow-ups: move assessment `assessment_runs` and pipeline decks onto
  `FlowRunStore`; prune only on creation of a new `/summarize` run; add
  retry-with-backoff if a kind needs it.

Status, revision store and `useFlowRun` (2026-10-06):
- `lib/flow-artifacts/store.ts`, `createArtifactRevisionStore({ tenant,
  subjectKind, idPrefix, revisionPrefix, artifactTable, revisionTable, mock })`:
  append-only revisions, CAS on `baseRevisionId` in one Aurora statement (head
  UPDATE + INSERT), identical mock path, `conflictDetails(head)` for the 409 body,
  `revisionLabel(seq)` = `v<seq>`, id minting by prefix. Both deck providers
  delegate to it (`deckRevisions`, `pipelineDeckRevisions`); routes, wire shapes and
  `deckStore`/`pipelineDeckStore` method names unchanged.
- Schema: runs on each tenant's EXISTING tables (`assessment_decks`/
  `assessment_deck_revisions`, `pipeline_run_decks`/`pipeline_run_deck_revisions`);
  no new generic table, nothing moved, dropped or renamed. Per-subject columns
  (`team_id`, `run_id`, `audience`, `last_run_id`) stay on the artifact row. A
  generic `flow_artifacts` table can be added for a third tenant later.
- Portal: `hooks/useFlowRun.ts` over pure, node-tested `hooks/flowRunPoll.ts`
  (superseded by `flowRunFollower.ts`, below): polls the durable record, pauses
  while hidden, backs off on failure (`nextPollDelay`), optional `maxPolls`.
  `useDeckRun` and `SocialSummaryCard` use it; `waitForRun`/`DECK_RUN_POLL_MS` removed.
- Evidence: jest flow-artifacts + both deck Aurora/route suites, node tests
  (flowRunPoll), Playwright assessment-decks-real (6), pipelines-run-decks-real and
  social-summarize (14 pass, 1 skipped) on a private dev:mock stack.

Status, live flow-run push over the gateway (2026-10-06):
- Channel `<tenant>:flowrun:<runId>` (`lib/flow-runs/channel.ts`); the tenant is
  fixed by the id prefix (`sum-` social, `adr-` assessment), so a client cannot
  re-file a run under a looser tenant. The library `pipeline()` feature's
  `channelFor` maps wire `pipeline:run:<flow run id>` onto it (`lib/gateway-run-feed.ts`).
- Authority (`authorizeFlowRunChannel`, `lib/live-principal.ts`): plain subscribe
  only (no publish, service prefix or call lobby), by the run's requester, against
  the freshly reloaded session and the `flow_runs` row read on every decision, no
  positive cache. Social adds ViewSocial plus current conversation membership
  (`chatAccess`); assessment adds active tenant + ViewAssessment. A second session
  reload after the I/O denies a mid-await revoke. The router re-asks per recipient
  per frame.
- Producer: the store emits a move after each fenced write (claim, progress, finish,
  lease-expiry failure; `lib/flow-runs/events.ts`); the feed emits one
  `pipeline:event` hint (`runId`, `status`, `stepId`, failure `error`). The result
  never rides the frame; the portal re-reads REST.
- Portal: `useFlowRun` adapts the library `usePipelineRunStatus` (`idToken: null`,
  `subscribeFirehose: false`, host transport only while connected).
  `hooks/flowRunFollower.ts` (node-tested): frames and reconnects re-read the
  snapshot, a 30 s safety read covers a lost frame, the old cadence runs only
  offline / refused / unacknowledged. Assessment deck runs (`assessment_runs`)
  stay on polling.
- Not done: two-node delivery is covered by the Redis router's per-recipient
  authorize but not exercised (the cluster harness needs live Redis).

### 5. Social `/deck` (M) — DONE 2026-10-06

Sources from `#` pages and, since slice 7, a recorded call (`--from recording:<id>`, picked from the library argument menu); a bare `--from transcript` names no recording and is refused.

Status:
- Reference: realtime-examples `deckCommand.ts` (`parseDeckText` :60-93, title rule
  :100-110, "a preview writes nothing" :201-215) and `deckPreviewCard.ts`.
- Command `/deck [topic] [#initiative:<id> | #work-item:<id> ...] [--preview]`; the
  BFF resolves each `#` token under the caller's current OrgIQ grant and the
  canonical page lookup (never a client title).
- BFF `routes/social-deck.ts` at `/api/chat` (`POST /commands/deck/run`,
  `GET /commands/deck/runs/:id`, `POST /commands/deck/runs/:id/save`, `GET /decks`,
  `GET /decks/:id`, `.../revisions/:rid/spec|file`, `POST /decks/:id/revisions|preview|post`).
  Thread reading reuses `/summarize`'s `readableLines`; `chatAccess` gained a
  `socialSubject` split so an owner can be read without membership. Runs are
  `lib/flow-runs` kind `social.deck` (id `sdk-`), requester-private, 3 active per
  user. No new Cedar action.
- Deck `lib/social-deck/facts.ts` counts every figure from the readable lines
  (title, overview, up to four discussion slides, who spoke, referenced pages);
  slides cite `social-message:<id>` (the pages slide cites the pages). Nova is
  `draft-review-deck` (tenant `social`, `teamId` = run id); `mergeDraft` keeps
  template quotes where spans are not verbatim in the slide's own messages or
  numbers are not in the facts. `MOCK_AGENTCORE` uses `mockDraftResult`; an
  unreachable agent yields a template deck flagged `unavailable`.
- Writes: `--preview` stores no deck (the private run record, 2 h TTL, holds the
  spec); "Save deck" (`PostMessage` + current membership) is the only write and is
  idempotent (deck id from run id, `ON CONFLICT DO NOTHING` + CAS revision 1);
  without `--preview` the run saves itself. Storage on the shared revision store
  (`providers/social-decks.ts`), `schema/social_deck_schema.sql` (registered in
  both loaders) and fixtures `social.decks` / `social.deck-revisions`.
- Authority: read = the deck's owner (with ViewSocial) or a CURRENT member of the
  source conversation, checked fresh each request, else 404. Edit (new revision,
  CAS 409) follows the one deck write rule (`PostMessage` plus current membership, see Open
  decisions), so a member who may post edits and revises too; a member who cannot post gets the viewer, download
  and "Post" only. Post
  (`POST /decks/:id/post`, PostMessage + membership) returns the server-built
  message and posts nothing; the card uploads the .pptx through the attachment path
  and sends it over the gateway.
- Presence: `social:deck:<id>` is presence-only (`lib/social-deck-channel.ts`,
  documented in the `tenant-channels.ts` table). Social is not a partition tenant,
  so it is not a family: `channelGuard` refuses every service but `presence:`,
  `lobbyGuard` refuses it, and `live-principal.ts authorizeSocialDeckChannel` asks
  the deck row plus owner / current membership on every subscribe and delivered
  frame, with a second session reload. Not owner-only.
- Portal: `pages/social/decks/` (`socialDecksApi.ts`, `SocialDeckCard.tsx` with
  `AgentRunCard` and `PresentationView`, `SocialDeckPage.tsx` with
  `PresentationEditor` and the shared deck layer), route `/social/decks/:deckId`,
  `/deck` registered in `ChatCommandProvider`, presence tenant union gained
  `social`. Read-only members see the viewer (no editor shell, so their own avatar
  is not drawn; the owner sees them).
- Live push: `sdk-` maps to `social:flowrun:<id>` (requester + ViewSocial + current
  membership of the run's conversation); the card follows via `useFlowRun`, polling
  only offline.
- Tests: jest `social-deck.test.ts` (18), `social-deck-channel.test.ts` (6),
  `social-decks-aurora.test.ts` (4), node:test `socialDecksApi.test.ts` (12),
  Playwright `e2e/social-deck.spec.ts` (4 pass on private :5296/:3096). Mock floor
  recaptured (new `social-deck` refusal rule); route coverage 0 untested.
- The recording source and picker are slice 7 (below). Open: no document sources; the card is in
  memory (a reload keeps only a saved deck). The narrative now asks the
  tenant-owned `social-deck` drafter mode (2026-10-07; guard table, prompt, `narrative-modes.ts`), like
  the orgiq/pipelines builds; a refusal or error keeps template prose. Revise… is `revise-social-deck`.
- Agent revise (2026-10-06): `POST /api/chat/decks/:id/revise` through
  `makeDeckHandlers`'s new `revise` option and `reviseDeckSync`
  (`lib/deck-shared/revise.ts`), gated like a save (`PostMessage` plus current
  membership; readers 403, outsiders 404). Synchronous: 201
  `{ revisionId, summary, changedSlideIds, engine, replayed }`, 200 for a replay or an
  unchanged edit, 409 `{ activeRevisionId }` on a stale base or a locked slide. The
  facts are rebuilt from the thread as the reviser can read it NOW (current member
  required; a conversation they can no longer read is refused) and `mergeRevise` keeps
  the quoting/grounding rules. Cited pages (read from the deck's own `social-page:` sources)
  are resolved again as the CURRENT reviser; one they can no longer read becomes a "no longer
  available to you" line on the Referenced pages slide and a title-source, never a reused
  title (`refreshPageSlides`, applied even when the agent changes nothing; locked slides kept). `requestId` makes a retry a replay (the revision id is derived from
  deck, base and request id). Editor: `socialDecksApi` `revise: true`, the editor's
  agent box via `useDeckAgentRun`'s inline mode. Evidence: jest `social-deck.test.ts`
  (+5 revise cases), `socialDecksApi.test.ts` (+1), `e2e/social-deck.spec.ts` (+2, cited-page case; on the
  shared :5183 app). Mock floor recaptured (the revise route falls under `social-deck`).

### 6. Orgiq initiative status deck (M) — DONE 2026-10-06

Status:
- Entry: the initiative page header's "Status deck" button
  (`pages/projects/decks/InitiativeStatusDecks.tsx`) lists the initiative's decks
  and, for `DispatchAgentRun` holders, builds one (optional Nova narrative; budget
  option only for `ManageBudgets` holders). Editor `/iq/decks/:deckId`
  (`InitiativeDeckPage`, library `PresentationEditor`, shared `useDeckDocument`,
  `useDeckCollaboration`, revisions, .pptx download, Share to Social).
- Facts (`lib/initiative-deck/facts.ts`, pure): work items by status (chart) and
  type, story points, estimated cost of open work, sprints, decisions; for budget
  readers also allocation, spend, remaining, the 30-day cron maintenance floor
  (`v_initiative_maintenance_30d`, mock analogue `getMaintenance30d`) and sprint
  envelopes. Narrative reuses `draft-review-deck` + `mergeDraft` on the summary and
  decisions slides (`teamId` = initiative id). Planning estimates stay on the deck
  for every role (the board shows them); the 500-item board cap applies.
- Budget tier follows `routes/budgets.ts` (org-leader, hr-admin, program-owner,
  admin, else `ManageBudgets`). Below it, a deck has no money slide or figure. A
  deck built with figures is stored `includes_budget` and is "not found" (list,
  detail, spec, preview, file, save) to non-readers, and is not offered for Social
  sharing. No new Cedar action. Gates: build/edit `DispatchAgentRun`; read, preview,
  download signed-in orgiq (`requireTenant('orgiq')`).
- Routes `/api/initiative-decks/*` (`routes/initiative-decks.ts`), provider
  `providers/initiative-decks.ts` on the shared revision store (CAS 409); storage
  `schema/initiative_deck_schema.sql` (registered in `load_schema.py` and
  `apply_all_seed.py`); fixtures `orgiq.decks` / `orgiq.deck-revisions`, seeded empty.
- Presence: `orgiq:deck:<id>` presence-only family in `lib/tenant-channels.ts`
  (orgiq session; no chat, reactions, activity or lobby; default-deny intact).
- Agent revise (2026-10-06): `POST /api/initiative-decks/:id/revise`
  (`DispatchAgentRun`, like a save) through the same `makeDeckHandlers` + `reviseDeckSync`
  path as Social: 201/200/409 and `requestId` replay as above; the deck's own
  `includes_budget` flag decides whether the rebuilt facts carry money, and a budget
  deck is still "not found" below the tier, so it cannot be revised there. Members 403.
  The reviser is `revise-initiative-status-deck` (`reviseWithAgent`, deterministic
  fallback). Editor: `reviseNow` on `InitiativeDeckPage`. Evidence: jest
  `initiative-decks.test.ts` (+5 revise cases), `initiativeDecksApi.test.ts` (+2),
  `e2e/initiative-decks-real.spec.ts` case (g) on :5183 (the file now has eight cases, (a)-(h)).
- `/deck` from the initiative Discussion (`components/chat/tenantDeck.ts`, `TenantDeckCard`): builds this
  status deck through the same create route, leaves a private card with Open / Revise… / Post, and a reader's
  command is refused with the reason. A deck carrying budget figures is never posted into a thread.
  `e2e/initiative-decks-real.spec.ts` (h).
- Narrative: orgiq has its own drafter mode (`initiative-status-deck`, per-mode guard); a refusal, error or
  empty answer keeps the template prose.
- Evidence: jest `initiative-decks.test.ts` (15), `initiative-decks-aurora.test.ts`
  (6), `tenant-channels.test.ts` (66, 13 new/extended); node:test
  `pages/projects/decks/__tests__`; Playwright `e2e/initiative-decks-real.spec.ts`
  (6 pass on private :5299/:3099). Middleware full suite, portal typecheck/1,394
  tests/build, route coverage (0 untested), mock floor, component discipline and nav
  parity pass.

### 7. Call recording summary (L) — DONE 2026-10-06

Status: a recorded DM call's transcript is a source for Social `/summarize` and `/deck`,
and the Recordings pane can start the summary.
- Reference: platform-api `GET /api/recordings/:id/transcript` (`src/routes/recordings.ts:902`;
  `requireOwnRecording` :291 is the participant rule; 202 + `terminal`/`retryAfterMs` while
  pending, `segments[{startMs,endMs,speakerId,speakerLabel,text,kind?}]` when ready, reactions
  injected as `kind: 'reaction'`); realtime-examples `deckCommand.ts:72-99` (`--from recording:<id>`)
  and :148-176 (the argument picker).
- BFF transcript source: `GET /api/social/recordings/:recordingId/transcript`
  (`routes/social.ts`, `providers/social-platform.ts recordingTranscript`). Same authority as the
  list/playback proxies and no new Cedar action: `ViewSocial` at the mount, a `social:` lobby only,
  and a recording the caller was not on does not exist (404, upstream's own answer). Under a real
  platform-api it asks `GET /api/recordings/:id` (lobby) then the transcript as the caller; nothing is
  cached. A pending transcript is a 202 with `terminal`/`retryAfterMs`. Reactions are dropped from
  speech; indexes keep their place in the document.
- Mock: `socialRecordingTranscriptsFixture` (`social.recording-transcripts`) with a transcript for each
  seeded recording; reset restores it.
- Flows: `lib/recording-transcript.ts` turns segments into `TranscriptLine`s whose id is
  `recording:<id>#<segment>`, so the grounded summarize core's verbatim check and the deck's per-slide
  sources work unchanged (a deck source id is that same string). `lib/recording-source.ts` adds the
  rule that the recording must belong to THIS conversation (a DM call's lobby is its chat channel; a
  room has no chat, so a room call, another conversation's call or an unknown id is the same 404);
  pending is 409, failed/empty 422. Grammar: `/summarize --recording <id>` or `--from recording:<id>`
  (`lib/social-summarize-args.ts`), `/deck --from recording:<id>` (`lib/social-deck/args.ts`).
- Portal: the library argument menu (`ChatCommandProvider` `argument.search`, `onPick: 'insert'`) lists
  the DM's recordings and writes `--from recording:<id>` (`socialRecordingPicker.ts`); it is attached
  only when the conversation has a recording, because a command with an argument makes bare
  `/summarize` a two-step pick in the library menu. `RecordingsPane` Summarize opens the call's DM with
  `?summarizeRecording=<id>`, which runs the command once there so the private card and Post live in
  the conversation; for a room call it starts the run and draws the card in the pane (below); it is disabled while the transcript is unfinished.
- Tests: jest `social-recording-flows.test.ts` (10), `social-platform.test.ts` (+4: member 200,
  non-participant 404, cross-tenant 403, non-social lobby 404, pending 202, platform proxy, fixture
  reset), node:test `socialRecordingPicker.test.ts` (3), Playwright `e2e/social-recording-flows.spec.ts`
  (3 pass on a private :5297/:3097 stack; `social-summarize`/`social-deck` specs still pass).
  Mock floor recaptured; route coverage 0 untested.
- Room-call recordings (2026-10-06): Social rooms have no chat channel (`recordingConversation` is null for
  `social:room:*`, and `ConversationRail` has no rooms group), so the private card is drawn by the Recordings
  pane (`RoomRecordingSummary.tsx`, the same `ConversationSummaryCard` and `social-summary-*` test ids, with the
  private-note notice). Same routes: `POST /summarize/run` accepts the room lobby as `channel` only with
  `--recording <id>` (400 otherwise); authority is `socialSubject` ViewSocial plus the call's own participant gate
  (`recordingTranscript`, 404 for a non-participant or a recording of another lobby; pending 409, failed/empty 422).
  The run keeps `recordingId` in meta and status/post re-ask participation each time. Post needs a body `channel`
  (400 without) and passes `chatAccess(target, 'PostMessage')`; the requester picks a joined channel or DM in the
  pane (`socialRoomSummary.ts`), a hidden `PostBridge` joins it and sends with the persisted-ack path.
  Tests: jest +3 (`social-recording-flows.test.ts` now 13), node:test `socialRoomSummary.test.ts` (3), Playwright
  `social-recording-flows.spec.ts` 4 pass on a private :5292/:3092 stack (room recording seeded by the registered
  mock fixture, no platform-api). Mock floor recaptured; route coverage 0 untested.
- Open: transcripts over 400 segments are cut at the first 400; real platform-api transcripts were not exercised
  against the Tilt SFU in this stage.

### 8. Assessment evidence summary and follow-up drafts (M) — DONE 2026-10-06

Status:
- What: on a team's dimension (Progress & follow-ups tab, "Assistant drafts") an
  assessor can **Summarize evidence** or **Draft follow-ups**; each is a private
  DRAFT and nothing reaches the team until the assessor accepts follow-ups.
- Agent: `orgiq-assessment-drafter`, modes `summarize-evidence` and `draft-followups`
  in `agents/assessment-drafter/evidence_commands.py` (own module; `main.py` only
  dispatches). Never raises on model output: a quote must be verbatim in the
  evidence it cites, a follow-up must end in "?", cite a rubric criterion id or
  quote and not repeat an open question, and any number not in the provider
  facts/criteria/evidence voids that piece; if nothing survives, a deterministic
  draft stands in (`fallback: true`). 7 synth-venv tests (`test_evidence_commands.py`).
- BFF: `lib/assessment-drafts.ts` (source from `getTeamDetail`, executor on
  `lib/flow-runs`, kinds `assessment.evidence-summary` / `assessment.followup-drafts`,
  requester-only, `listFor` added to the store) and `routes/assessment-drafts.ts`
  under `/api/assessment`: `POST /teams/:id/dimensions/:dim/drafts/{evidence-summary,followups}`
  (RunAssessmentAgent), `GET .../drafts` and `GET /drafts/:runId` (ViewAssessment),
  `POST /drafts/:runId/accept` (ScoreAssessment), `POST /drafts/:runId/discard`
  (RunAssessmentAgent). No new Cedar action. Levels, target, claim state and counts
  are `facts` read by code; the model writes prose only.
- Accept picks among the STORED questions by index (body text ignored), writes via
  `providers/assessment.addFollowUps` (same OPEN row, `team` audience, normalized-text
  de-dup; level, history and evidence untouched; Aurora branch takes the team row
  lock), then claims the decision once (409 on a second accept or a discard). A
  summary can only be discarded. Documents parity decision 8's proposal metadata
  was not reused: it is bound to Yjs edits.
- Mock: `MOCK_AGENTCORE` answers with a valid envelope through the same validators;
  `POST /api/__mock/reset` clears drafts (`flows.runs`). Wire snapshots recaptured;
  the four writes are refused by the `assessment-private-draft` rule. The Aurora
  branch of `addFollowUps` and the `listFor` SQL are unrun.
- Portal: `dashboard/EvidenceDraftsPanel.tsx` (library `AgentRunCard`, `Checkbox`,
  `MarkdownView`; no raw elements or inline styles), `evidenceDrafts.ts`; drafts
  recovered on reload.
- Tests: jest `assessment-drafts.test.ts` (14), node:test `evidenceDrafts.test.ts`
  (7), Playwright `e2e/assessment-evidence-drafts.spec.ts` (3 pass on private
  :5297/:3097).
- Shared + Revise (2026-10-06): drafts are visible to every assessor the read gate
  admits (list/get no longer filter by requester; readers see them read-only; Accept
  needs ScoreAssessment, Discard/Revise RunAssessmentAgent; any editor may decide,
  once, via `setMetaOnce(.., null, ..)`). `POST /drafts/:runId/revise
  {instruction, baseRevision, requestId}` re-queues the SAME run row through
  `flowRunStore.requeueRevision` (CAS on `meta.rev`; the prior result stays readable),
  hands the drafter `revision:{instruction, prior_draft}` as separate context, and a
  failed revision keeps the earlier draft with a note. A stale base is a 409 ("Someone
  revised this draft first"); a same-actor retry of the same `requestId` is
  duplicate-safe; Accept may carry `baseRevision`. Portal: Revise... in the card, 8 s
  visible-only list poll, "A newer version is available" banner, stale revise lands on
  the newer version. Tests: jest 16 (drafts), node:test 9, Playwright (d) two assessors
  (5 pass on :5183). Wire snapshots recaptured on a throwaway :3012 server.
- Open: the Aurora SQL of `listScope`/`requeueRevision` is unrun; the live run channel is
  still requester-private, so teammates see progress by polling; a dimension with no
  evidence or no next-level criteria yields an empty draft, not an error.

### 9. Suggestion accept/reject for agent edits (M) — DONE 2026-10-06

Port `/doc` suggestions onto the existing proposal metadata (documents parity
decision 8). No route or schema change.

Status:
- Reference: realtime-examples `DocumentSuggestionsPane.tsx:46-113`,
  `wholeBlockResolve.test.tsx:1-14,52-60` (accept keeps a block, reject removes the
  whole block), `useRunSuggestionReview.ts:1-63,214-262` (card and margin resolve
  through one path; verdict recorded once), `suggestions/marks.ts`.
- Library check (2.410.0): `SuggestionCard`, `SuggestionReviewList`,
  `SuggestionModeControl` exist; the suggestion MARKS (`SuggestChanges`,
  insert/delete/modify) do not, so a suggestion is one whole block of the stored
  proposal, not a Y.Doc mark; the canvas is untouched until Apply. Queued in
  `docs/ui-components-queue.md`.
- Model (`knowledge/documentSuggestionsModel.ts`, node-tested): blocks are the same
  blank-line split Apply uses (`insertContentFor`). `planResolution`: any block
  undecided waits; none accepted discards; all accepted applies the stored text
  unchanged; a subset narrows first.
- Commit path reuses existing operations: Discard; Apply (claim before insert,
  receipt in the Yjs transaction, canonical save acknowledgement, complete); for a
  partial accept the existing revision CAS narrows the SAME row to the accepted
  blocks (anchor/author untouched), then ordinary Apply. A lost narrowing or
  completion response replays (same actor, body, version); a claim is never
  idempotent. A rejected block is never inserted.
- UI `DocumentSuggestionReview.tsx` (library list and cards, one per block, for
  ready saved drafts with 2+ blocks inside the existing strip). Marking is local
  until every block has a verdict, then it commits; Accept all / Reject all commit
  at once. Readers get the cards with no Accept/Reject/bulk controls and send
  nothing; the linked reader preview no longer duplicates them. Single-block drafts
  keep Apply/Discard.
- Drafter: `document_commands.py` asks `suggest-confluence-content` for independent
  blocks separated by blank lines.
- Tests: 6 new jest in `document-proposals.test.ts` (partial accept, reject all,
  accept all, lost-response replays, reader refused, CAS race), 6 node:test
  (`documentSuggestionsModel.test.ts`), 1 python, Playwright
  `e2e/document-suggestions.spec.ts` (4 pass on private :5292/:3092); the existing
  25-case `document-proposals.spec.ts` still passes.
- Not done: a browser canvas Apply of a narrowed draft (canonical canvas /
  platform-api unreachable here; the claim releases, as the existing contract);
  verdicts are not durable until the last block is decided; no in-document marks
  until the library ships them; the mock drafter returns a single block.

### 12. `/diagram` and `/doc` chat commands (M) — DONE 2026-10-06

Goal: the two commands realtime-examples registers (`diagramCommand.ts:21`,
`docCommand.ts:10`) as private run cards on the flow layer. Note the reference
differs from the first brief: its `/diagram` creates a diagram board and has the
agent draw into it, and its `/doc` edits the document open beside the chat. Here
both read the readable transcript and share only on an explicit act.

- Core `lib/conversation-artifact.ts` (`defineArtifactFlow`), routes
  `routes/conversation-artifact.ts`: Social at `/api/chat/commands/{diagram,doc}`,
  tenant discussions and huddles at `/api/conversations/{diagram,doc}` (`POST /run`,
  `GET /runs/:id`, `POST /runs/:id/post` for diagram, `POST /runs/:id/save` for doc).
  Run kinds `social|orgiq|assessment|pipelines.diagram|doc`, id prefixes `sdg sdc odg
  odc adg adc pdg pdc`, mapped to the requester-private `<tenant>:flowrun:<id>` push
  channel (`channel.ts`, `live-principal.ts`, portal `isLiveFlowRunId`).
- Authority is `/summarize`'s, unchanged and fresh per request: Social `chatAccess`
  (ViewSocial to read, PostMessage to post) via `readChatLines`; tenant families and
  huddles `authorizeConversationChat`, re-asked after the transcript read. Runs are
  requester-only (unknown and foreign ids are one 404). Posting and saving are
  once-only claims; nothing is sent without that call plus the portal sending it.
- Agent: the drafter's existing `draw-diagram` (drawio mxGraphModel) and
  `draft-confluence-page` (markdown) with `source_spans`. The TS side re-checks spans
  (verbatim, one message) and the diagram XML (same rules as the Python validator,
  plus only the five predefined entities). The tenant guard was NOT widened:
  non-assessment tenants get the deterministic result with `unavailable` shown on the
  card. `MOCK_AGENTCORE` uses the same deterministic builders (`diagramDigest`,
  `pageDigest`). Posted artifacts carry `metadata.artifactOf` and are excluded from
  later transcripts. Posted text is capped at the chat limit of 1000 characters.
- Portal: `components/chat/conversationArtifact.ts` (pure client + commands),
  `chatCommandRegistry.ts` (the shared registry: Social gets summarize, deck, diagram,
  doc, agent; tenant discussions and huddles get summarize, diagram, doc, agent through
  `useConversationSummarize`, plus `/deck` (`tenantDeckCommand`) where the channel has a tenant deck: an
  orgiq initiative's Discussion builds the status deck, a pipelines run's thread the run report; the
  assessment scorecard composer's agent mode offers `/deck` as its review deck), `ConversationArtifactCard.tsx` (`AgentRunCard`,
  library `NodeGraph` for the diagram, `MarkdownView` for the page preview).
- Save target by tenant, always through an EXISTING path: assessment
  `POST /api/assessment/knowledge/doc/create` (a `workspace_drafts` draft, gated
  ManageKnowledge there; the message carries `documents:[{id,label}]`); Social attaches
  the `.md` through the conversation's upload path (`.drawio` is attached as text/plain
  because the allow-list has no drawio type); orgiq and pipelines have no
  document-creation path, so Save is not offered and the route answers 409.
  `PageReferenceCard` was not used: it is typed to initiative/work-item references in
  `lib/callChat.ts`, which is out of bounds here, so a saved page shows as the
  `documents` reference / attachment instead.
- Tests: jest `conversation-artifact-social.test.ts` and `-tenant.test.ts` (68),
  node:test `conversationArtifact.test.ts` (9), Playwright `e2e/social-diagram-doc.spec.ts`
  (3, on the Tilt stack :5183). Wire snapshots recaptured; writes refused by
  `conversation-artifact-run`.
- Update 2026-10-06: Save into an assessment document now resolves the id against the
  actor's fresh authority (`currentLiveSession`, ManageKnowledge, then `getKnowledgeDoc`):
  missing is 404, read-only or no grant is 403, another tenant's session never reaches the
  run (jest, 71 tests). `e2e/assessment-doc-save.spec.ts` drives `/doc` and Save in the
  assessment document conversation on :5183 and reads the draft back.
- Open: no browser pass of the tenant-discussion or huddle cards (`e2e/conversation-summarize.spec.ts` covers
  the pipelines run thread's summary); NodeGraph ignores drawio geometry (queue row).

### 10. `/agent` loop (L) — first increment DONE 2026-10-06; durable resume DONE 2026-10-06; creation steps DONE 2026-10-06; approval (HITL) steps DONE 2026-10-06

Goal: `/agent <goal>` plans 1-6 steps with acceptance criteria, the requester approves, and the
steps run one after another through the flows that already exist. Reference: realtime-examples
`agentLoopPlanner` (plan 1-6 steps with acceptance), `AgentRunCard`, `useChatCommands`.

Status:
- Planner: drafter mode `plan-agent-loop` (`agents/assessment-drafter/agent_plan.py`, wired in
  `main.py`; 6 tests). The model proposes `{summary, steps:[{kind,title,instruction,acceptance}]}`;
  the validator (Python) and `lib/agent-loop/plan.ts` `acceptPlan` (TS, authoritative) keep the
  plan only if every kind is allowed for the tenant, there are 1-6 steps and every step has a title
  and acceptance; otherwise one deterministic step stands in (`fallback`, with `unavailable` when
  the drafter's tenant guard refused, as in every other flow). Under `MOCK_AGENTCORE` the planner
  answers from the registered fixture `agent.plans` (`mock/agent-plans.ts`: keyword rows, a default
  row, an `empty` scenario), filtered by the tenant's allowed kinds.
- Step kinds: `summarize`, `diagram`, `doc`, `draft`, `note`, plus `deck` in Social only (decks are
  Social's; tenant conversations have no `/deck`). `draft` is the `/doc` flow run with a "Draft:"
  topic (a private page draft); `note` runs nothing and records its text. A deck step starts
  `--preview`, so nothing is stored until the card's Save.
- Run: `lib/agent-loop` on `lib/flow-runs`, kinds `<tenant>.agent`, id prefixes `sag oag aag pag`
  mapped to the requester-private `<tenant>:flowrun:<id>` channel (`channel.ts`, portal
  `isLiveFlowRunId`). One row, two phases: planning completes holding the plan; Approve re-queues
  the SAME row with `requeueRevision` (once-only compare-and-set; Discard is a once-only `decision`
  claim and is refused after Approve) and the approving node executes. `maxAttempts` is 1, so a
  lapsed lease fails visibly and can never re-run a step. `FlowRunStep` gained optional `ref`
  (the child run) and `detail` (acceptance, then why a step failed or what a note recorded).
- Authority: `routes/agent-loop.ts`, Social at `/api/chat/commands/agent/*` and tenant discussions
  and huddles at `/api/conversations/agent/*` (`POST /run`, `GET /runs/:id`, `POST /runs/:id/approve`,
  `POST /runs/:id/discard`). The posting right is required from `/run` (Social chatAccess
  PostMessage; tenant chat `publish`), so readers get 403 and the portal offers them no `/agent`.
  Unknown and foreign ids are one 404; every call re-asks the conversation. Each step reloads the
  requester's session (`currentLiveSession`) and calls the flow's own start function, extracted
  from its route without behaviour change (`beginSocialSummarize`, `beginConversationSummarize`,
  `beginSocialArtifact`/`beginTenantArtifact`, `beginSocialDeck`), so tenant guards and the 403/404/429
  shapes are those flows'. A failed start or a failed child run stops the loop: the step is
  `failed` with the reason, later steps stay `pending`, the card reads failed.
- Portal: `conversationAgent.ts` (pure client, command, status mapping), `ConversationAgentCard.tsx`
  (library `AgentRunCard`, `MarkdownView`, buttons; a rich `localMessage` body with its private
  note), step cards drawn by `useConversationSummarize` (`stepCard`: the same summary, diagram, page
  and deck cards the commands leave). `/agent` is in `chatCommandRegistry` for Social and tenant
  conversations and removed by `withoutAgent` when `maySend` is false.
- Tests: jest `agent-loop-tenant.test.ts` (22: three tenants x plan shape, authz matrix, once-only
  Approve/Discard, ordered execution, a 429 step stopping the loop), `agent-loop-social.test.ts` (4),
  `lib/agent-loop/__tests__/agent-loop.test.ts` (8: plan rules, fixture, fresh session before every
  step, once-only Approve, a node without the session never runs steps); node:test
  `conversationAgent.test.ts` (8); Playwright `e2e/agent-loop.spec.ts` (2 pass on :5183: plan card,
  Approve, summary and diagram cards beneath it; Discard). Mock floor `--quick`, route coverage (714
  routes, 0 untested), component discipline, portal tsc and 1,436 portal tests pass. Wire snapshots
  were recaptured from a throwaway :3099 server (the other pending slices' drift came with it);
  the six `/agent` writes are refused by the `agent-loop-run` rule.

Decisions:
1. One row, two phases, instead of a plan run plus an execution run: the plan the requester approved
   is the plan that runs, and the card follows one id.
2. Durable resume (replaces the memory-only session). Approve stores the approver's IDENTITY
   (sub, tenant, role, epoch, iat, masquerade actor; never grants or a cookie) in the re-queued
   row's `input` and raises `max_attempts` to 5; the step cursor is the row's own `progress`
   (status plus child `ref` per step), written with the lease-fenced `report`. If the node dies
   the lease lapses, any node re-claims, calls `currentLiveSession` BEFORE doing anything (moved
   epoch, lost grant or unavailable directory fails the run closed: `authorization-unavailable`,
   403 text on the card, `errorCode` on the wire, no step started) and continues from the first
   unfinished step. A step whose child is already recorded is followed, never started again.
   Approve takes an optional `requestId` (the portal sends `rq-<runId>`), stored as the CAS's
   `reviseId`: the same id answers the same 202 and one loop; another id gets 409. Discard after
   Approve (stage `running`) sets the once-only `decision`; the executor reads it before each
   step, so it cancels at the next boundary (card: "Stop after this step"). Approvers: a run is its
   requester's alone in every tenant (another editor gets 404 from the owner lookup), because
   steps run as the requester's authority; the per-tenant deck Save rules are unchanged and stay
   each step card's own act.
3. Steps start existing flows through their own start functions rather than a parallel
   implementation; the plan's `instruction` is passed only to `diagram`, `doc`, `draft` and `deck`
   (cleaned of `#` and `--`), never to `summarize`, whose argument is a time range.
4. Nothing posts or saves automatically: each step's card keeps its own Post / Save act.

Creation steps (`document:create`, `meeting:create`; `routes/agent-loop-create.ts`): no child run.
The dispatcher makes one thing through the tenant's existing create path as the requester's fresh
session, re-asking the conversation's posting right first, and the step completes holding a `link`
(`FlowRunStep.link`: document, room or huddle) that the card draws as an Open button (library `Button`,
text via `T`). Offered only where a path exists (`allowedKinds(tenant, channel)`, so the mock and Nova
planners cannot emit others; `acceptPlan` and the drafter validator both enforce it):
- `document:create`: assessment = `createDocumentDraft`, the function behind the Documents tab's New
  (`workspace_drafts`, ManageKnowledge asked inside it, link `/assessment/workspace?doc=<id>`); Social =
  a markdown file in the conversation's upload store (uploader the requester, readable by whoever may read
  the thread, link `/api/uploads/<id>`; Social has no server-side document store, files are how documents
  arrive there). orgiq and pipelines: not offered, the step refuses 409 (the `/doc` route 409s there too).
- `meeting:create`: Social = a room through `createRoom` (ManageChannels, so a participant is refused 403;
  public to the org, the requester its creator, `/social/rooms?room=<slug>`). The rooms API has no member
  invite, so the conversation's members are NOT invited; they join from the link. orgiq and assessment =
  the conversation's own huddle lobby when its family is a call lobby (initiative discussion, assessment
  document): the step records the lobby name, nothing is dialled server-side, and the card says to start it
  from the footer's Huddle. Work items, runs, huddles and pipelines have no lobby: not offered, 409 if forced.
- Restart: a crash after the create but before its report fails that step visibly ("may already have
  started"), never creating twice; resume re-proves the requester first. Mock planner row `plan-kickoff`
  (`{goal}` in its titles keeps each run's room name unique).
- Tests: jest `agent-loop-create-social` (6) and `agent-loop-create-tenant` (7: assessment draft + lobby,
  viewer refused, other approver 404, cross-tenant 403, orgiq lobby-only plan, pipelines fallback, direct
  step refusals), plan rules and restart contract extended (3 more), drafter `test_agent_plan.py` (7),
  portal node:test (+2), Playwright 5 on :5183 (moderator completes with a document and a room link and
  reads the file back; a participant's room step is refused 403 after the document). Wire/write snapshots
  recaptured from a throwaway :3099 server; mock floor `--quick`, route coverage (714, 0 untested),
  component discipline, middleware and portal typecheck, 1,456 portal tests pass.

Approval steps (HITL; `approval` step kind, parity matrix §4a item 7). The planner (Nova, the drafter's
`plan-agent-loop` mode, and the mock `agent.plans` row `plan-approval`) may put an `approval` step, with its
question in `instruction`, before a consequential step (anything that posts, creates a document or room, or
spends). Offered in every tenant; `acceptPlan` and the Python validator both drop a plan whose last step is an
approval. Reference (read-only): realtime-examples' pipeline `approval` node (question, approvals ledger,
timeout that rejects, a distinct rejected end).
- Pause: reaching the step returns `pause: 'approval'` from the executor; `flowRunStore.pause` moves the row
  running -> `waiting-approval` (new status, schema CHECK widened additively), clears the lease, keeps the cursor
  (the row's progress) and `meta.waitingSince`. No node holds it, so a restart neither re-runs earlier steps nor
  claims it; `countActive` still counts it against the requester's limit of active runs. Each pause emits a
  `waiting` move: the BFF run feed sends it as `pipeline:approval:requested` on the requester-private
  `<tenant>:flowrun:<id>` channel and the card re-reads (live; polling is the fallback).
- Decide: `POST /runs/:id/approval/approve|reject` (`requestId`, optional `reason`), both mounts. The decider's
  access is read fresh (`currentLiveSession`) BEFORE the run is revealed: a moved epoch, lost grant or unavailable
  directory is 403 `authorization-unavailable: ...` (the stopped-loop text), nothing resumes. `flowRunStore.resumeWaiting`
  is the once-only compare-and-set (`meta.apprReq`), idempotent per requestId (same id: same 202; another id: 409);
  it merges the verdict (and, for Approve, the approver's identity) into the row input and re-queues it with a fresh
  attempt count. The executor re-proves an approver through `currentLiveSession` before the next step and continues
  AS THEM. Reject ends the loop (`stopped`, step failed, reason on the card: "rejected by <sub>: <reason>").
- Who decides: the requester (with the posting right), plus a second approver only where the tenant's rule table
  (`SECOND_APPROVER_ACTION`, the same split as the deck Save rules) names an action they hold: Social none (owner-only),
  orgiq `DispatchAgentRun`, assessment `RunAssessmentAgent`, pipelines `RunPipeline`, and they must hold the
  conversation's publish right. Everyone else who can read the conversation is a `reader` (403 on a decision); another
  tenant, an unreadable conversation or an unknown id is 404. Discard on a paused loop is 409.
- Seeing it: `GET /agent/waiting?channel=` lists the loops paused in a conversation the caller may read, with the caller's
  role; readers and approvers get the question, the plan summary and the step titles (never the goal's source text).
  `useWaitingApprovals` polls it (5 s, paused in hidden tabs, backoff) so the requester finds their own paused loop again
  after a reload and another member's tab shows `ConversationApprovalCard` (read-only for a reader, Approve/Reject for an
  approver). The requester's own card shows `AgentApprovalPrompt` (library `Input`/`Button`/`T`, optional reason).
- Expiry: the dispatcher tick calls `flowRunStore.expireWaiting(24 h)`; a pause with no decision re-queues with an `expire`
  verdict and ends `stopped` ("nobody answered within 24 hours, so the loop ended"). The card shows "Expires in N h".
- Typing (resolved): `waiting-approval` is a member of `FlowRunStatus` (`mock/flow-runs.ts`). Every exhaustive map handles it
  explicitly: the work-graph projections (all three tenants) draw a paused loop as an open `waiting` node (never running,
  never failed, no lease), the phase maps read it as `running` (the stage field carries the question), and the portal
  status chip says "waiting for approval". `isWaitingApproval(run)` stays as a readable predicate over stored rows.
- A second approver's later steps run as them, so those step cards belong to the approver; the requester's card shows each
  step's status and detail but cannot follow the child runs.
- Tests: jest `lib/agent-loop/__tests__/agent-loop-approval.test.ts` (8: plan rules, pause persists and a restart tick changes
  nothing, Approve resumes as the approver with the earlier step run once, once-only per requestId, moved epoch fails closed,
  Reject, 24 h expiry), `agent-loop-tenant.test.ts` (+7: roles, wrong actor 403/404, requester and second approver,
  Reject, epoch 403, Discard 409), `agent-loop-social.test.ts` (+2); drafter `test_agent_plan.py` (+1); portal node:test (+6);
  Playwright `e2e/agent-loop.spec.ts` 7 pass on :5183 (+2: Social plan with an approval pauses, a second tab as another
  member sees it read-only, the requester approves, the page draft completes; Reject with a reason). Mock floor: wire
  snapshots recaptured from a throwaway :3099 server at the time and `--quick` passed; it has since drifted because another
  lane added `GET /api/page-references/resolve`. Route coverage 730 routes, 0 untested; middleware 6,374 tests; portal 1,481.
  Still unrun: the Aurora SQL for `pause` / `resumeWaiting` / `expireWaiting` / `listWaiting` and the widened CHECK.

Out of scope here: devbox / cloud box steps and their budget (box steps remain out), model-chosen step arguments for `summarize`, re-planning after a
failure, an Aurora run (the SQL paths are the shared store's and remain unrun), a reload keeping the
card (in memory like the other cards), a browser pass of the tenant-discussion and huddle cards
(covered by jest and the pure tests only), and the devbox exception review.
Restart contract: jest `lib/agent-loop/__tests__/agent-loop-restart.test.ts` (3, real flow-runs
store on the mock fixture, real dispatcher and lease expiry: executor killed mid-step, node B
resumes once; revoked requester does not resume; idempotent Approve and Discard-after-Approve);
route test for requestId/second approver in `agent-loop-tenant.test.ts`; Playwright now 3 (adds an
orgiq initiative Discussion as `u-nora`).
Limits: a crash in the narrow window after a step is marked running but before its child ref is
saved fails that step visibly ("may already have started") instead of guessing; resume is proven on
the fixture store, the Aurora SQL (`max_attempts` raise in `requeueRevision`) has not run on a live
cluster; a Discard after the last step started is too late and reads 409 or runs to the end.
Open: the Playwright passes cover Social and orgiq only (assessment, pipelines and huddles by jest; the assessment document and orgiq lobby creation steps are jest only); no member invites for a created room; the huddle step records a lobby but cannot ring anyone;
`draft` duplicates `/doc` until a reply-draft mode exists.

### 11. Activity/work graph (M) — DONE 2026-10-06/07 (orgiq slices 1-3, then pipelines, assessment and Social)

The reference's "Active now" graph (`ActiveWorkGraphPanel`, realtime-examples
`work-graph/WorkGraphPanel.tsx:815`; fed by platform-api `routes/work-graph.ts`)
was not in this repo. Full design record and mapping:
[activity-graph-migration.md](activity-graph-migration.md).

Status:
- BFF projection over rows the REST routes already serve: `routes/work-graph.ts`
  (initiative and workspace snapshots for a local day, v1/v2) and
  `lib/work-graph/**` (initiatives, work items, bot and marketplace runs, bots,
  linked documents). Each part follows its REST read gate, decided per request
  from the reloaded session; a failed Cedar decision withholds and says
  `authorization-unavailable`. v2 is assembled and validated by the library's own
  `buildWorkGraphSnapshotV2`.
- Live: content-free `work-graph.changed` hints through the existing `activity()`
  feature on the new default-deny family `orgiq:workgraph`; the portal refetches
  a re-authorized snapshot on each (no graph data on the socket).
- Portal: `useWorkGraph` + `WorkGraph` as the initiative overview's Activity
  (`ChannelActivity` `graph`, feed kept beneath) and `/iq/activity` (pop-out; no
  rail/palette row yet — `components/shell/**` is owned elsewhere right now).
- Tests: 21 jest (projection honesty, authz matrix, family refusals), 5 node:test,
  Playwright `e2e/orgiq-activity-graph.spec.ts` 3/3 including a live status change.
- Slice 2: sprints, decisions, the viewer's own flow runs (summarize/diagram/doc),
  a person day (`/api/work-graph/people/:id/graph`, `person:<id>` stream subject)
  and the gateway stream's per-viewer deltas.
- Slice 3: live `agent_jobs` (queued/claimed/running) as run nodes, behind the
  dispatch tier (narrower than the signed-in REST floor); `job` hint cause from
  `jobEvents`; stream/route/projection/live tests (54 jest), e2e 7/7 incl. a live
  sprint move and an own flow-run change as stream deltas. No library change
  (the ten node kinds and `statusLabelOf` suffice; sprint/decision still borrow
  `task`/`change`).
- Pipelines (activity §8), assessment (§9) and Social (§10) run on the same projection and stream path,
  parameterised by tenant: families `pipelines:workgraph`, `assessment:workgraph`, `social:workgraph`; pages
  `/pipelines/activity` (and the run page's Activity), `/assessment/activity` (and the scorecard Activity tab),
  `/social/work-graph` (and the conversation Graph toggle, every part behind chat membership); each has its rail
  and palette row. Evidence: jest per tenant (projection, authz matrix, family, stream, live), Playwright
  `e2e/{orgiq,pipelines,assessment,social}-activity-graph.spec.ts` (7, 4, 3, 4 tests).
- Orgiq run rows stay in `agent_jobs` and `flow_runs`; the projection reads both (slices 2-3), so there is no
  separate run store to decide.
- Not built: devbox/local-compute terminals; chat/huddle nodes in orgiq; node detail panes; omitted-node paging;
  watermarked replay instead of re-authorised snapshots; a day picker on `/iq/activity`.

## Open questions

- Whether a recording's transcript beyond 400 segments should be windowed or summarised in stages (it is cut
  at 400 today), and how real platform-api transcripts behave against the Tilt SFU.
- Whether Social's `/deck` narrative gets its own drafter mode; today it asks the assessment-only
  `draft-review-deck` and keeps template prose on a live agent.
- Aurora: the SQL of `flow_runs` pause/resume/expire/list, `requeueRevision`, the deck, draft and relation
  tables has not run on a live cluster.
- Capacity sizing for the realtime gateway is the owner's decision.
- Cloud-bound and out of scope here: `/agent` devbox/box steps and their budget, and live transcription.
  Rooms are Social-only by design.

## Open decisions

- ~~Drafter tenant guard: widen it beyond `assessment` for orgiq and pipelines
  narrative.~~ **Decided 2026-10-06: per-mode guard, not a wider tenant list.**
  The drafter keeps `assessment` as the default tenant and each deck-narrative
  mode is allowed for exactly one tenant (`agents/_shared/tenant_guard.py`
  `reject_wrong_mode_tenant`, `MODE_TENANTS` in `agents/assessment-drafter/main.py`,
  mirrored by `middleware/src/lib/deck-shared/narrative-modes.ts`):

  | Mode | Tenant allowed | Refused for |
  |------|----------------|-------------|
  | `initiative-status-deck` | `orgiq` | assessment, pipelines, social, no auth |
  | `pipeline-run-deck` | `pipelines` | assessment, orgiq, social, no auth |
  | `revise-initiative-status-deck` | `orgiq` | assessment, pipelines, social, no auth |
  | `revise-pipeline-run-deck` | `pipelines` | assessment, orgiq, social, no auth |
  | `revise-social-deck` | `social` | assessment, orgiq, pipelines, no auth |
  | every other mode (`draft-review-deck`, `revise-review-deck`, story, context, document, evidence, agent-plan) | `assessment` | orgiq, pipelines, social, no auth |

  The new modes take the deck builder's facts as the only context and return the
  `draft-review-deck` shape, validated by the same verbatim-span /
  no-invented-numbers check (`deck_narrative.py`). The BFF checks the pair before
  invoking and a refusal, error or empty answer keeps the template prose (the
  deck is never failed for narrative). Under `dev:mock` the deterministic offline
  drafter answers.

  **Revise modes (2026-10-06).** The three `revise-*` modes take the slide's
  current spec, the instruction and the tenant's facts/evidence as separate
  fields and are validated by `validate_revise_deck` (slide ids, layout, sources
  and charts unchanged; numbers only from facts, evidence or existing text;
  otherwise the deck comes back unchanged). The BFF side is
  `reviseWithAgent(tenant, ...)` in `lib/deck-shared/service.ts`: the mode is
  looked up from the tenant, never the caller; refusal/error/empty falls back to
  the stateless `mockReviseResult`; `mergeRevise` and the revision CAS are
  unchanged. Wired for all four tenants: assessment and pipelines (`providers/pipeline-decks.ts`) through
  their own executors, orgiq and Social through `reviseDeckSync` and `POST .../revise` (slices 5 and 6), each
  with an editor Revise…. The social deck's `/deck` generation still uses assessment-only `draft-review-deck`
  and falls back as before (see Open questions).
- ~~Deck save permissions differ across tenants; decide whether to unify.~~
  **Decided 2026-10-06: one rule, stated once, enforced once.** A deck is
  writable (build, save, revise, share) by exactly the actor who may run that
  tenant's agent on the deck's subject:

  | Tenant | Write action | Plus (current, per request) | Delete |
  |--------|--------------|-----------------------------|--------|
  | assessment | `RunAssessmentAgent` | team read (`ViewAssessment`) | n/a |
  | pipelines | `RunPipeline` | run read (`ViewPipelines`) | n/a |
  | orgiq | `DispatchAgentRun` | initiative read; budget-tier redaction stays a read rule | n/a |
  | social | `PostMessage` | CURRENT membership of the deck's conversation | owner only |

  `deckWriteAuthority(tenant, subject, req, op)` in
  `middleware/src/lib/deck-shared/authority.ts` is the only check: it re-reads
  the session through `live-principal.ts` `currentLiveSession`, requires the
  session's active tenant (or admin), and evaluates each Cedar action now.
  Every deck route (`assessment-decks`, `pipeline-decks`, `initiative-decks`,
  `social-deck`) and Social's share-to-conversation path call it; the old
  `ScoreAssessment` / `runGate` / `writeGate` / owner-only checks are gone.
  Reads keep their own gates. Consequences: assessment saves now need
  `RunAssessmentAgent` (every assessment role already held both, so no role
  changes); a Social MEMBER holding `PostMessage` may now save and revise a
  deck someone else built (CAS still 409s a stale base), and `canEdit` on the
  deck detail is that same answer. The portal reads the rule through
  `makeDeckApi({ tenant })` (`writeAction`, `DECK_WRITE_ACTION` in
  `components/decks/deckApi.ts`). Tests: `deck-shared/__tests__/authority.test.ts`
  (4 tenants x writer / reader / outsider / forged subject) plus the four route
  suites.
- ~~Initiative overview: Discussion and an Agent composer block are two composers.~~
  **Decided 2026-10-06: one composer.** On `/iq/projects/:id` Overview the
  Discussion section's `SummarizableChatPanel` composer is the only one (Chat |
  Agent, with the page-reference chip); the docked `InitiativeComposer` no longer
  renders on Overview (it still docks on Work, Decisions, Agents, Contributors
  and the list). Chat posts to the initiative discussion; Agent runs the
  conversation's agent commands (plain text becomes `/agent <goal>`; a typed
  `/summarize`, `/diagram`, `/doc`, `/agent` runs as itself). Without
  `DispatchAgentRun` both modes are disabled with their reason. The call dock
  (huddle in-page tiles) sits above the composer in that section. `/deck` is not
  in the tenant-conversation command registry (`chatCommandRegistry.ts`), so it
  is not offered there yet; Agent mode no longer navigates to the Ask page.
- Browser re-walk of stale journey logs (page edits made several digests stale; they are not sealed to
  clear a mismatch).
- Library asks: a runtime `color` prop on `T`/`Inline` (queue row 223) is the only one still missing.
  Shipped and adopted: `useDeckPresence`, rich `localMessages`, `parseDeckText`/`deckTitleFrom`/`recordingIdFor`
  (portal's `wantsPreview` calls `parseDeckText`; the BFF's stricter `parseDeckArgs` stays because middleware
  does not depend on the library and it also parses `#page` tokens), and the deck engine as
  `@connorhoehnslalom/realtime-modules/deck` (0.112; `pptxgenjs` stays a direct middleware dependency). The
  suggestion marks and `selectedCount` shipped but are not adopted: slice 9 keeps whole-block review of stored
  proposals.

- 2026-10-07 follow-up closed: cursors on every tenant's shared work graph. `WorkGraphActivity` takes `cursorChannel` and wraps the graph in `WrappedCursorOverlay` (`useCursor`, canvas mode); wired for the initiative page (via `ChannelActivity`, no edit to `ProjectDetailPage`), the assessment team scorecard, the pipelines run page and the Social conversation graph. `orgiq:initiative`, `assessment:team` and `pipelines:run` now list `cursor` in `lib/tenant-channels.ts`, under the family's read authority; Social needed no change. Contracts in `realtime-gateway-cursor.test.ts`; browser spec `portal/e2e/work-graph-cursors.spec.ts` (run page).
