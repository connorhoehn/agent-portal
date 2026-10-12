# Meeting processing audit — October 10

This follow-up audits the rehearsal guide and the requested journey from an
ended meeting to a searchable recording, transcript and summary. Historical
evidence remains in `README.md`; it does not establish that the new journey is
complete. Implementation is isolated from the running, memory-backed app.

| Requirement | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Native video transcription | Owned native PipelineExecutor run processed the preserved synthetic MP4 through Whisper and persisted 11 engine-timestamped speech segments. Media hash is unchanged. | Activate the candidate timestamp service only after a safe service handoff. Attribution remains mixed-call audio, not speaker diarization. |
| Successful meeting summary | The same owned native run used the Codex CLI subscription bridge and saved a nonempty, grounded summary against that recording. Transcript and summary both reached ready. Stale attempts and changed settled results were rejected. | Native participant retrieval and Work search passed for two owned identities; safe activation in the running application remains. |
| Processing immediately after meeting end | Shared Work/Assessment recording components cover saving, transcription, summary and terminal states. Sixteen owned browser fixtures pass, including a cleared call host, exact source-document routing and late identity changes. | Canonical gateway-seat/media binding and strict finalizer resolution are implemented and checked. Fixture lifecycle tests do not prove actual gateway delivery. |
| Attach artifacts to recording | Native persistence passes; shared detail shows transcript and summary beside the recording. A failed summary preserves ready transcript and video. | Native participant API acceptance passed. Integrated activation remains. |
| Search and project context | Candidate Work and Assessment search reads participant-authorized native artifacts with fresh host checks and exact initiative, team or verified original-document links. Discovery and hydration are bounded and report incomplete results. | Owned persisted-artifact search, native nonparticipant denial and revoked-epoch rejection pass (4 checks). Directory and Cedar use explicit synthetic fixtures. This is read-through search, not a durable vector index. |
| Preserve reviewed work and originals | Implementation and owned acceptance use isolated checkouts/storage. The original video is unchanged. No live call, grant or saved deck was changed by this run. | Preserve the memory-backed application through a supported handoff before activation; no complete supported checkpoint endpoint has been found. |

## Native engine acceptance

Sanitized [proof](evidence/2026-10-10/native-meeting-pipeline/proof.json),
[execution provenance](evidence/2026-10-10/native-meeting-pipeline/execution-provenance.json)
and [observed lifecycle](evidence/2026-10-10/native-meeting-pipeline/observed-lifecycle.json)
are preserved beside this guide.

The second owned integration attempt passed with a real native pipeline executor,
DynamoDB repository, Redis, timestamp-producing Whisper service and Codex CLI
subscription inference. Only the immutable media-file transport was a fixture;
the run did not create a live call or exercise gateway delivery. Its call and
recording IDs and database prefix are isolated from user data.

The result contains 11 speech segments and a 1,051-character summary. Manual
content review found the dependency-map blocker, the affected-services follow-up,
the proposed outage replay and the decision to post in huddle chat grounded in
the speech. It invents no person or deadline. Mixed composed audio is labeled
`Call`; it does not claim diarization.

The first integration attempt is retained as a failed timestamp acceptance: it
used the older text-only speech endpoint. It must not be counted as the strict
pass. The second attempt used a separate timestamp-capable endpoint and retained
its own evidence. Source-file hashes recorded after execution describe the
working checkout, not necessarily the already-loaded bytes of a long-lived host
bridge. The provider's later diagnostic hardening has separate focused tests.

Private integration results are retained under
`/private/tmp/meeting-native-pipeline-proof-attempt02`. Raw transcript and summary
bodies are not committed. The original synthetic media SHA-256 is
`0c2f7815ea36c0921b927192c2c58364e2f5d19c80eef352276572ac7a45c252`.

## Stronger rehearsal gate

The existing observer's `--wait-pipeline` deliberately accepts terminal failure
as an observation having settled. It does **not** prove successful summarization.
Use the additional strict gate for a speaking meeting:

```sh
node scripts/demos/observe-huddle-recordings.mjs \
  --lobby orgiq:initiative:p-observability \
  --since '<the owned rehearsal start in UTC>' \
  --expected 1 --watch 240 --wait-pipeline --require-summary --verify \
  --out /private/tmp/meeting-processing-proof.json
```

The observer is read-only. It requires matching native composed media, a
completed finalize run, stored nonempty speech, a nonempty ready summary and a
completed current transcription attempt. Duplicate recordings and an earlier
successful attempt cannot satisfy the gate. It reports counts, not transcript
or summary bodies. This status gate still needs the separate content validator,
participant API/UI checks and search authorization checks.

Seven focused observer regressions pass, including failed summaries, empty
artifacts, stale attempts and duplicate IDs. The complete goal is still open.

Private fresh speech evidence is retained at
`.scratch/meeting-recording-pipeline-20261010/native-speech-proof.json` in the
primary checkout. Raw recognized text is private and is not committed.


## Explicit Codex summary provider

The candidate native implementation supports `RECORDING_SUMMARY_PROVIDER=codex`.
An empty `RECORDING_SUMMARY_MODEL` uses the Codex CLI default. It uses the existing
Codex login on the host, an ephemeral read-only working directory, and disabled
tool-bearing features. A completed, nonempty tool-free response is required;
partial output, a tool attempt, failure, timeout or cancellation cannot become a
ready summary. No subscription credential is copied into the platform container.

For a containerized native platform, `scripts/codex-summary-server.cjs` in
platform-api provides an optional host bridge. `CODEX_EXEC_TOKEN` is an independent
random bridge credential (at least 32 characters), supplied to both ends;
`CODEX_EXEC_URL` must be a local HTTP origin. The server defaults to loopback,
accepts one inference at a time, limits request size, and bounds request lifetime.
An independently configured summary provider has its own model circuit breaker;
the existing shared model slot limits and global operator stop still apply.

These source changes are in isolated checkouts and are not yet activated in the
running services. The earlier standalone speech and Codex proof files remain in
the private evidence directory above. The subsequent owned integration proves
native persistence; it does not yet prove that the running user-facing UI can
retrieve that new summary.


## Call association and rollout limits

The candidate client sends its actual gateway connection identity to the native
media join, then requests a durable binding. The native service verifies the
current accepted signaling seat through the owning BFF and conditionally stores
that call identity on the exact media attendance entry. A client-side roster or
successful media join alone cannot claim a binding.

Finalization uses the complete channel history and recorded identities. It does
not choose the newest call in a Work or Assessment lobby. Missing, conflicting
or ambiguous proof remains unresolved. New native WHIP recordings preserve the signed token participant ID separately
from the camera/screen transport ID. Every recorded leg must match that signed
seat and its authenticated user; mixed audio/video provenance is rejected. This
lets new screen-share tracks resolve to the same call without interpreting a
`:screen` suffix. Legacy recordings and mesh/stream-key sources without signed
seat metadata remain unresolved; no historical recording is relabeled.

The primary app API is memory-backed. Its supported mock-state endpoint exposes
counts and boot metadata, not a complete restorable snapshot, and periodic
active-call counts are not an atomic idle check. This change has not restarted
or hot-reloaded that service. Feature-branch publication is separate from local
activation; the existing user-facing application does not yet run this candidate.


## Reproduce the isolated UI check

Use an isolated checkout with its own installed dependencies:

```sh
cd portal && node node_modules/@playwright/test/cli.js test --config playwright.recording.config.ts
```

The configuration starts and stops its own loopback Vite server on port 5283,
refuses an existing server, and sets the API proxy to the inert loopback port 9.
It runs the recording pipeline and document recording specs together; no manual
Vite process or primary application API is used.

The spec intercepts its owned API requests and supplies an inert native call
host. The only video is a two-second synthetic preview; it never starts a real
call or requests microphone/camera capture. The test supplies both ready and
partial-failure receipts and checks exact recording routing, identity changes,
finite polling, compact action fonts and participant denial.

The [UI validation receipt](evidence/2026-10-10/native-meeting-pipeline/ui-validation.json)
and [ready](evidence/2026-10-10/native-meeting-pipeline/recording-attachments-ready.png),
[partial failure](evidence/2026-10-10/native-meeting-pipeline/recording-partial-failure.png)
and [compact Assessment](evidence/2026-10-10/native-meeting-pipeline/assessment-recording-compact.png)
fixtures are preserved. These images demonstrate component behavior in fixtures,
not live human-call acceptance.


The [backend receipt](evidence/2026-10-10/native-meeting-pipeline/backend-verification.json)
includes actual isolated DynamoDB acceptance of the binding write: first write,
idempotent retry, conflicting call, leave and changed connection. Its two tests
passed. The separate [artifact/search receipt](evidence/2026-10-10/native-meeting-pipeline/cross-read-search-proof.json)
records four passing checks using the genuinely generated artifacts and clearly
identifies the synthetic directory/Cedar authority fixtures.


## Published source and final verification

These commits are published on feature branches; they are not merged or activated
in the shared local stack:

| Repository | Branch | Commit |
| --- | --- | --- |
| aws-agentcore | `feat/meeting-recording-pipeline-20261010` | `0ce0ec92` (implementation; documentation follow-up follows) |
| platform-api | `feat/meeting-pipeline-20261010` | `cbec174` |
| realtime-modules | `feat/meeting-call-binding-20261010` | `849477f` |
| ui-components | `fix/meeting-recording-search-native` | `4f95fc40` |
| live-video-streaming | `feat/meeting-timestamps-20261010` | `90e023b` (includes timestamp commit `6aec9da`) |

The final platform source build and typecheck pass. Its recording lane passes
214 focused cases; the overlapping route/repository lane passes 220 cases with
6 skipped. These overlapping counts must not be added together. Middleware
passes 92 tests. Actual isolated Dynamo binding passes 2 tests; actual generated
artifact cross-read/search passes 4. The shared UI passes 30 focused tests and
8 browser fixture cases, plus its build and typecheck. The native UI package
passes 10,826 tests with 2 skipped.

The [native source receipt](evidence/2026-10-10/native-meeting-pipeline/native-source-verification.json)
preserves final source hashes and scope limits. The actual Whisper/Codex pipeline
proof predates the last signed-seat and replay-access hardening; those later
changes have focused source/repository coverage, not a new live-call acceptance.
Governed replay currently includes trusted recorded users. A listener-only
attendee with no recorded media is not newly granted playback by this change.
Historical recordings missing signed-seat metadata remain unresolved.

The [LVS receipt](evidence/2026-10-10/native-meeting-pipeline/lvs-signed-seat-validation.json)
records the published signed-seat follow-up. LVS focused recording/WHIP checks pass 21 tests, and source syntax checks pass
170 files. Its full unit runner passes 226 files and fails 2 unchanged suites:
`api/channels/createRetry.test.js` and `anti-stampede-multi-pod.test.js`.
The latter uses an optional local Redis connection and unique expiring fixture
keys; it is not an inert test despite the runner's no-dependencies banner.
The failures are documented rather than represented as a successful full run.
Owned validation services have been stopped; source worktrees remain for review
and integration. Original media, saved decks, and primary service state were
preserved during this implementation pass.

## Follow-up: scoped Assessment search and lifecycle correctness

Assessment team Documents now has a candidate transcript/summary content search using its own ViewAssessment authority, a signed Assessment native token, exact recording participant reads, and a fresh team-read check. Work Search remains scoped to Work. Seventy-seven focused middleware tests, 34 Assessment parent-route tests, and middleware typecheck pass; these counts describe distinct runs, not a replacement for live native acceptance. The UI covers partial results, exact recording navigation, denied access and actor changes. Eleven recording browser fixtures pass, including active media failure/reconnection not falsely becoming a post-call processing card.

The prior real Whisper/Codex run seeded a recording and started transcription directly. It did not test the automatic completion-webhook/finalizer path. A later audit found duplicate completion could overwrite saved artifacts and enqueue another automatic attempt; native remediation is published separately as platform-api commit c366dcc. Its 176 tests across ten suites and typecheck pass. The host Docker socket is unavailable. An owned Dynamo container was started through the existing Colima VM, but VM control subsequently timed out; actual transaction acceptance did not pass, and cleanup of the exact owned container remains unconfirmed. The bounded harness was stopped; no shared service was restarted. See platform-api docs/work-huddle-candidates/finalization-replay-verification.json for the exact resource and limits. No fresh automatic native acceptance or service activation is claimed. Document-call binding, hashed document context, and workspace recording routes were still open at that checkpoint; the source implementation and fixture checks below now cover them. Fresh automatic finalizer acceptance was still pending at that checkpoint; the owned proof below supersedes that status.

Frontend-only file controls and composer notices were also applied to the primary app in commit 8f363b5f. Three toolbar browser cases and one notice interaction/layout case pass; primary portal typecheck passes. Native recording package/API changes remain isolated. Search keeps the mode control first, then context chips and a small notices icon; hover/focus previews the list and click pins it. No permanent history footer is rendered.


## Verified document context and shared recording files

The candidate adds a Recordings tab to the existing Assessment document workspace,
including Enterprise, Rules and Prompts source documents. The saved recording,
transcript and summary remain native artifacts. Search and selected-record
hydration use the existing Assessment read gate, native participant ownership,
and a fresh exact source read. Search results open the document's current section
and Recordings tab. Work initiative and Assessment team files retain their
existing paths; no Work document call family or unsupported association is added.

A document source ID is never reconstructed from the lobby hash. The native call
store captures the original document channel once at call creation, including
initial page joins and invitations. The binding callback compares its exact
source ID with that immutable accepted-call channel, canonical lobby hash,
current signed actor/tenant/epoch, accepted socket and fresh source read. The
native media attendance stores the verified context immutably and returns the
same context in its acknowledgment. Finalization retains document context only
when every recorded signed seat agrees; missing or conflicting context remains
unassociated. Legacy calls cannot acquire a source later through re-invitation.

Native document recording detail, playback and artifact reads also ask the
existing BFF callback about the stored source. Lists use the caller's participant
index and exact membership reads. A deleted or denied source, lost membership,
wrong active tenant or missing context is withheld, including revocation during
native media I/O. Explicit preexisting share-capability reads retain their
existing bounded grant contract. The separate raw-media access candidate is not
activated by this work.

The [document integration receipt](evidence/2026-10-10/native-meeting-pipeline/document-context-integration.json)
links exact source/package hashes to [backend checks](evidence/2026-10-10/native-meeting-pipeline/document-context-backend.json)
and [shared UI checks](evidence/2026-10-10/native-meeting-pipeline/document-context-ui.json).
The app backend passes 100 distinct focused cases; the native boundary lane
passes 98. Both typechecks pass. The UI passes 16 browser fixtures and 5 unit
cases, with portal typecheck passing. The SDK lane passes its build, 37 focused
cases and 9 owned Redis cases. These counts describe these source lanes; older
overlapping runs elsewhere in the guide must not be added. The [document recording
fixture](evidence/2026-10-10/native-meeting-pipeline/document-recording-partial.png)
shows independent transcript and summary status in the actual shared document
shell. Fixture APIs and identity/policy data are explicit; no actual human-call
acceptance, capture or live Cedar session is claimed.

The SDK package is pinned identically in the isolated portal and middleware;
primary services remain unchanged. The later owned automatic finalizer proof below now covers that transaction and
model path. Safe native activation and a state-preserving handoff for the
memory-backed app remain necessary before live journey acceptance.


## Automatic finalizer acceptance in owned storage

The [fresh automatic finalizer proof](evidence/2026-10-10/native-meeting-pipeline/automatic-finalizer-proof.json)
passes from the actual signed completion-webhook handler through the native
finalize executor, actual DynamoDB transactions and automatically enqueued
transcription child. No recording row was pre-seeded and the manual transcription
helper was not called. Actual Whisper produced 11 timestamped segments; actual
Codex subscription inference saved a 1,019-character summary. Both isolated
participant reads returned the exact saved summary; a nonparticipant was denied.
Repeating the completion webhook preserved the ready row and enqueued no second
automatic generation. The immutable media hash is unchanged.

The owned harness uses native PipelineExecutor, EventBus and WAL lifecycle; it
does not boot production Raft/RunPersistence. Accepted gateway-seat metadata is
an explicit fixture. Composition/file HTTP transport is immutable fixture media,
not real SFU or ffmpeg capture. Native chat cards were **zero** because the Work
initiative lobby is not mapped to native chat; the processing UI's finite polling
is covered separately by browser fixtures. Work-graph effects were intercepted,
so neither notification nor external graph delivery is claimed. Native primary
services, original media and application data were not activated or changed.
The receipt retains exact native source hashes and these boundaries. This owned
success supersedes the earlier failed transaction attempt while preserving its
dated failure and cleanup limitation above.


## Current completion audit after main consolidation

This section supersedes historical branch and activation status above. App main
`30133a60`, ui-components main `e7a42a4f`, realtime-modules main `57d8a1b4`,
platform-api main `65761509`, and live-video-streaming main `90e023b3` contain
the consolidated implementation. Main publication does not establish runtime
activation. The primary application stays on its fully merged runtime branch
because its backend is watched and memory-backed.

| Explicit outcome | Inspected evidence | Completion judgment |
| --- | --- | --- |
| Audit the huddle guide and its acceptance commands | Current observer source, strict acceptance rules, automatic-finalizer receipt, cross-read/search receipt and live native media reads | Audit updated; the acceptance command must fence the exact processing attempt, including the claim-to-enqueue gap. Ten regression checks and observer syntax check pass. |
| Transcribe video automatically | Signed webhook → native finalize → automatic child → real Whisper; persisted 11 timestamped segments in owned DynamoDB | Proven for owned storage/fixture media transport; actual primary SFU integration is not established. |
| Summarize and attach to the recording | Automatic receipt records a real Codex subscription result, ready artifacts, duplicate replay preservation and two participant reads | Proven in the owned pipeline; not yet verified in the running application. |
| Show processing after the meeting ends | Native RecordingActivityCard and app PostCallRecording/useRecordingRead source; prior isolated browser cases | UI uses authorized five-second polling. The receipt reports zero native chat cards, and no production realtime delivery is proven. It must not be described as verified realtime push. |
| Make recording artifacts searchable and associated with initiatives/projects and supported document/team contexts | Current recording-search implementation, four actual persisted-artifact cross-read/search checks, document-context integration evidence | Canonical associations and permission filtering pass owned checks. Directory/Cedar remain synthetic in that acceptance; live user search is outstanding. |
| Preserve original work and current session | Read-only native stats and each channel's recording state at 19:07:48 UTC; primary API/Vite processes unchanged | One recording remains active, with two participants and three producers. No restart, call stop or live data mutation was performed. |

The observer now projects `processingAttemptId` from both recording metadata and
pipeline context. When the recording has an attempt ID, only that exact attempt
can satisfy terminal or successful processing acceptance. A missing newly
registered run remains unfinished, even when an old run completed successfully.
Legacy records retain the existing newest-run fallback.

Remaining end-to-end acceptance requires a state-preserving runtime handoff,
then an authorized speaking-call journey through actual capture/finalization,
processing UI, saved playback/transcript/summary and participant-scoped search.
Work initiative lobbies currently have no native chat-card mapping. Their live
chat uses separate gateway authority, so adding a string mapping alone is not a
valid delivery integration. The current local five-second status observer is
not evidence of server-pushed recording events. Existing recorded media and
memory-only session activity must survive any activation.


## Event-driven status acceptance

Platform main `989fabf` adds an authenticated, participant-scoped status endpoint
backed by the existing native pipeline EventBus. Long-poll requests wake on
matching call/recording events or the current native run. Each response repeats
token validation and current participant/host access checks. Event payloads and
artifact bodies never leave that channel; the app rechecks normal metadata and
artifact endpoints. A 25-second resync handles missed events and the existing
finite five-second polling remains a fallback.

The post-call indicator and recording detail consume this endpoint. They pause
while hidden, abort on actor/scope changes and re-read without clearing the
visible card. A status refusal immediately triggers an authorized metadata
recheck so revoked content is hidden without waiting for the fallback timer.

Evidence: 12 focused native checks include actual distributed-core EventBus
publication → authenticated HTTP response, expiry during a wait, participant and
host revocation, unrelated events, subscription races and cleanup. Pub/sub and
recording/host authority are explicitly isolated fixtures. The existing native
recording route suite passed 43 cases. Eighteen browser cases cover existing
recording/document journeys plus immediate event-driven completion and denial;
the new cases freeze time and advance only 300 ms, below the five-second poll.
Fifteen client checks pass. Both source typechecks and builds pass; OpenAPI
coverage now includes status and the existing call-seat binding endpoint.

The user chose **preserve the current session; continue isolated integration**.
No primary API, frontend, SFU or stored media was changed. This establishes the
native event-to-status and browser consumer boundaries separately. It does not
claim a fresh end-to-end SFU call, automatic transcription/model run, or primary
runtime activation. Those remain outstanding under the original objective.


## October 12: actual SFU capture through processing and status

[Live native acceptance](evidence/2026-10-12/live-native-recording/verification.json)
now connects two actual Chromium RTP publishers, native JWT media seats, real
SFU/ffmpeg capture and composition, the actual signed completion webhook,
automatic native finalize/transcription executors, Whisper, Codex subscription
summarization, owned DynamoDB persistence, and authenticated native EventBus
status reads. No recording row was pre-seeded and no manual transcription
helper started the child. The final run stored six engine-timestamped segments
and a 666-character summary; both recorded participants read that exact summary,
and a nonparticipant was denied. Thirteen status responses include the actual
pending → processing → ready progression. The final 30.564-second H.264/AAC
recording decodes in full with no ffmpeg errors and retains both signed seats.

This exposed a native timing bug: stopRecording stamped the recording and
still-open participant timelines after waiting for ffmpeg and uploads. A
30-second capture therefore claimed roughly 40 seconds and composition reported
`degraded` despite retaining both tracks. The fix captures the end boundary
before draining, preserves earlier participant departures, and keeps operational
finalization metrics separate. Both single-process and multi-leg regression
cases fail before the fix and pass after it. Twenty-three clock/identity tests,
25 recording-manager checks, and 28 composition checks pass. The repeated live
run reports composition `ok`.

Browser input is prepared speech plus animated canvases, not physical devices.
Gateway acceptance and host directory/Cedar authority remain explicit fixtures;
production Raft/RunPersistence bootstrap, the application's rendered card and
application search are not exercised in this run. Chat/work-graph delivery is
intercepted. Primary services and original media remain untouched. This replaces
the earlier fixture-media limitation for the isolated native pipeline, while
preserving those remaining application acceptance boundaries.


## October 12 — recording interactivity and lifecycle audit

Fixed a status observer that permanently switched to polling after one network
failure. It now reconnects with a 1–30 second bounded backoff, rechecks current
metadata/authorization on failures, and schedules its next request only after
releasing the in-flight guard. Hidden tabs and unmounted scopes still stop work;
terminal cards stop subscribing. Server status reads now release subscriptions
on disconnect or timeout even if an authority read stalls.

CDP instrumentation in the recording browser suite measures request counts,
interaction-to-paint, event-to-paint, long tasks, task duration, and layout count
at normal and 4× throttled CPU. Both cases inject one network failure, establish
one held status request, open the details UI while it waits, deliver the ready
revision, and check that requests stop at completion. Measurements and source
hashes are in `recording-interactivity-audit-20261012.json`.

All 16 browser cases pass using main's pinned ui-components/realtime packages in
an isolated dependency copy; portal typecheck passes. Platform validation adds
68 Jest checks, six harness lifecycle/failure checks, and a passing build. The
browser uses the real React hooks/components with explicit HTTP/authority
fixtures. Its measurements are local rendering/interactivity evidence, not
production network latency or a new native media/inference run. The prior live
native evidence remains unchanged. Primary services and memory-backed session
were preserved; activation and the complete live application search flow remain
separate verification boundaries.
