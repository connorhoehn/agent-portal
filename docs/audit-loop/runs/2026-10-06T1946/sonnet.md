# Audit 2026-10-06

## Delta since last run
- new: `middleware/src/lib/work-graph/assessment-projection.ts` is untracked and now in `changed-files.txt`. It is a 404-line assessment work-graph projection that reuses `finishProjection`, `part` and `edgeIdFor` from `projection.ts`. Nothing imports it yet, so it is not wired. `routes/work-graph.ts` and `tenant-channels.ts` are unchanged, and `pages/assessment` has no `useWorkGraph` caller. The assessment work-graph cell therefore stays ❌ in `docs/audit-loop/realtime-parity.md:57`, with backend groundwork noted.
- fixed: none.
- still open: 4 findings, all low, unchanged from the 1916 run.
- parity ❌/⚠️ remaining, from the matrix tally in `realtime-parity.md` line 81. I did not flip any cell. orgiq: 20/38 · assessment: 22/38 · social: 18/38 · pipelines: 15/38
- Gates: `validate-component-discipline.sh` and `validate-nav-parity.sh` both pass (`gates.log`).
- `raw-scan.txt` and `signals.txt` are identical to the 1916 run. That means 66 files and 100 of 417 raw tags.
- `useNotifications` is still mounted once, at `portal/src/components/shell/SharedNotifications.tsx:20`.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime `strokeWidth` and label `transform` in `style` | A library edge/label composite | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A rich-row `RadioGroup` or standalone `Radio` | upstream-needed |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | An `Image`/`Thumbnail` composite | upstream-needed (queue row 222) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Local `parseDmLobby` with a variable tenant prefix | A tenant-agnostic upstream parse, or keep the wrapper | upstream-needed |

I read these four items last run and did not re-read them this run. The scan output that anchors them is unchanged.

The other raw-element and inline-style hits (`Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109`) are data-driven colours on `Inline`. They fall under the existing runtime-colour tolerance.

Eleven `EventSource` sites remain (`signals.txt`). These are non-gateway feeds such as devbox tail, canary events, crawl status and approvals. They are not duplicate chat, presence or notification clients. The assessment, work and local-compute feeds were not re-checked this run.

## Stale exemptions
None found. I did not re-check exemptions for files outside the changed set against the installed dist. That includes `UnavailableNotice.tsx` (modified in the working tree) and `TemplateHighlighted.tsx`.

## realtime-examples divergences
I did not open realtime-examples this run. These come from the matrix.
- The new assessment projection follows the same pure-projection pattern as the orgiq and pipelines graphs. It is backend-only so far. Before this graph can stream, it needs:
  - an `assessment:workgraph` channel family and route;
  - a portal caller, via `WorkGraphActivity`/`ChannelActivity`.
- Open ❌ rows:
  - message edit/delete/forward;
  - diagram board;
  - in-call reactions;
  - agent-loop/HITL cards in the thread;
  - call log outside social;
  - files panel;
  - transcription;
  - pre-join screen;
  - document review lifecycle.
- Typing indicator is ❌ in assessment, social and pipelines.
- Pipelines presence is ⚠️ because `join: true` is missing.

ESCALATE: no — both gates pass and the only change is an unwired backend projection that follows the existing pattern.
