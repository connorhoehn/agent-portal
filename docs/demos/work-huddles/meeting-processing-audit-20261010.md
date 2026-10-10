# Meeting processing audit — October 10

This follow-up audits the rehearsal guide and the requested journey from an
ended meeting to a searchable recording, transcript and summary. Historical
evidence remains in `README.md`; it does not establish that the new journey is
complete. Implementation is isolated from the running, memory-backed app.

| Requirement | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Native video transcription | Owned native PipelineExecutor run processed the preserved synthetic MP4 through Whisper and persisted 11 engine-timestamped speech segments. Media hash is unchanged. | Activate the candidate timestamp service only after a safe service handoff. Attribution remains mixed-call audio, not speaker diarization. |
| Successful meeting summary | The same owned native run used the Codex CLI subscription bridge and saved a nonempty, grounded summary against that recording. Transcript and summary both reached ready. Stale attempts and changed settled results were rejected. | Native participant retrieval and Work search passed for two owned identities; safe activation in the running application remains. |
| Processing immediately after meeting end | Shared Work/Assessment recording components cover saving, transcription, summary and terminal states. Eight owned browser fixtures pass, including a cleared call host and late identity changes. | Finish canonical gateway-seat/media binding and finalizer resolution. Fixture lifecycle tests do not prove actual gateway delivery. |
| Attach artifacts to recording | Native persistence passes; shared detail shows transcript and summary beside the recording. A failed summary preserves ready transcript and video. | Native participant API acceptance passed. Integrated activation remains. |
| Search and project context | Candidate Work search reads participant-authorized native artifacts with fresh host checks and exact initiative links. Discovery and hydration are bounded and report incomplete results. | Owned persisted-artifact search, native nonparticipant denial and revoked-epoch rejection pass (4 checks). Directory and Cedar use explicit synthetic fixtures. This is read-through search, not a durable vector index. |
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
or ambiguous proof remains unresolved. In particular, legacy screen-share source
IDs have no durable parent-seat proof; a matching user name or `:screen` suffix
is insufficient. Those recordings may retain their authorized artifacts without
appearing as a confirmed exact-call match. A future native signed source-to-seat
mapping is needed for that case.

The primary app API is memory-backed. Its supported mock-state endpoint exposes
counts and boot metadata, not a complete restorable snapshot, and periodic
active-call counts are not an atomic idle check. This change has not restarted
or hot-reloaded that service. Feature-branch publication is separate from local
activation; the existing user-facing application does not yet run this candidate.


## Reproduce the isolated UI check

Use an isolated checkout with its own installed dependencies. In `portal`, start
Vite with an inert API target (port 9) and run the browser suite in another shell:

```sh
API_PROXY_TARGET=http://127.0.0.1:9 npx vite --host 127.0.0.1 --port 5283 --strictPort
```

```sh
npx playwright test e2e/recording-pipeline.spec.ts --project=chromium
```

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
