# Audit 2026-10-06

## Delta since last run
- new: nothing new in the scan output. The inline-style hits are the same as last run.
- fixed: the `Thumbnail.tsx:42,57` inline `style={{ width, height }}` I flagged last run as having no queue row. It does have one, `docs/ui-components-queue.md:222` ("Composed locally in `portal/src/components/ingest/Thumbnail.tsx`"). I did not find a queue row last run because I did not look for one, so this is a correction, not a code fix.
- fixed (matrix only): the "Typing indicator" row in `docs/audit-loop/realtime-parity.md:38` was already flipped to ✅ for assessment, social and pipelines, so last run's stale-row complaint no longer applies. I read that row and the §4 tally but did not browser-verify anything.
- still open: 2 (`WeightedEdge.tsx:57,70` and `VersionPickerStep.tsx:63,70`, both upstream-needed and queue-covered).
- parity ❌/⚠️ remaining, from the §4 tally (`realtime-parity.md:74-80`) and not re-verified cell by cell: orgiq 20/38 · assessment 23/38 · social 19/38 · pipelines 18/38 (7 of those are "—").
- Both gates pass (`gates.log`). `useNotifications(` has one non-test mount, `SharedNotifications.tsx:20`, so there is no duplicate.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Per-render stroke width and label transform in inline `style`. | A library weighted-edge or edge-label composite. | upstream-needed (queue ~`:221`) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | A runtime `borderLeftColor` and a bare radio with a runtime `accentColor`. | A standalone `Radio` or a rich-row `RadioGroup`. | upstream-needed (queue ~`:53`) |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | A raw `<img>` and a runtime-sized frame. | An `Image` or `Thumbnail` composite with a fallback. | upstream-needed (queue `:222`) |

The runtime-colour hits in `ScorePanelNode`, `Leaderboard`, `CompareDeltaTable` and `PersonDetailCard` are unchanged and covered by the queue row near `:223`.

Eleven `EventSource` uses remain, all against BFF SSE endpoints (`raw-scan.txt`). `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` are candidates for a gateway activity subscription, but I did not check them. The scan found no raw `new WebSocket` in `portal/src`.

## Stale exemptions
None found. `docs/ui-components-queue.md` has a large uncommitted diff (+104/−21), and I did not re-check its rows against the installed dist. That includes the `UnavailableNotice`, `DiffFrame`, `DimensionRow` and `TemplateHighlighted` rows.

## realtime-examples divergences
I did not open realtime-examples this run, so the citations are carried over from the matrix. For typing, `HuddleChat.tsx:326,350` is the reference and the portal's `SummarizableChatPanel` follows it.

The real gaps are the remaining ❌ rows:
- assessment, social and pipelines have no `useWorkGraph` caller (`realtime-parity.md:57`)
- message edit/delete/forward
- diagram board
- document review
- call reactions
- agent-loop cards

Scope: the changed-files list has 646 entries, mostly middleware. I did not walk the 66 raw-element files brace-aware, so the gate budgets are my only evidence for those.

ESCALATE: no — both gates pass, and the open findings are low-severity upstream gaps already in the queue.
