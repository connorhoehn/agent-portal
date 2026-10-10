# Audit 2026-10-06

## Delta since last run
- new: none. `raw-scan.txt` and `signals.txt` are byte-identical to the 1846 run (66 files, 100 of 417 raw tags). `changed-files.txt` differs only by the removal of the `middleware/src/lib/deck/*` entries.
- fixed: none.
- still open: 4, all low severity, same as last run.
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 22/38 · social: 18/38 · pipelines: 15/38. These are recounted from the tally in `realtime-parity.md` (§4), where orgiq is 6 ⚠️ + 14 ❌ and so on. I did not flip any cell, because no changed file touches a cell that the matrix doesn't already record for 2026-10-06.
- Gates: `validate-component-discipline.sh` and `validate-nav-parity.sh` both pass (`gates.log`).
- `useNotifications` is still mounted once, at `portal/src/components/shell/SharedNotifications.tsx:20`.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime `strokeWidth` and the label `transform` live in `style`. The label also uses raw `text-[10px] font-semibold` classes (line 69). | A library edge/label composite, with `T` tokens for the label text | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A rich-row `RadioGroup` or a standalone `Radio` | upstream-needed (queue) |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame, with raw `text-[10px]` on the placeholder | An `Image`/`Thumbnail` composite | upstream-needed (queue row 222) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Local `parseDmLobby` with a variable tenant prefix | A tenant-agnostic parse upstream, or keep the wrapper | upstream-needed |

`WeightedEdge.tsx` is in `changed-files.txt`. I re-read it: the label already uses `Inline` and the comment names the queue row, so finding 1 is unchanged.

I read `DimensionRow.tsx:26-70` and `DiffFrame.tsx:30-34`. Both are plain raw `div`/`span` structure with no inline styles. The gate budget matches what I saw.

Eleven `EventSource` sites remain (`signals.txt`). The two most likely to be the gateway `activity()` feed are `portal/src/hooks/useWorkEvents.ts:16` and `portal/src/pages/assessment/knowledge/useAssessmentEvents.ts:61`.
- `useWorkEvents` is already one ref-counted shared connection to `/api/work/events`, so it is not duplicated.
- `useActivity(channel)` does exist in the installed dist (`dist/client/useActivity.d.ts`). Its feed is global, so replacing the work-queue SSE with it is a design decision, not a swap.

## Stale exemptions
None found. I confirmed the `DimensionRow` rail-row exemption (queue row 16), the `WeightedEdge` row (221) and the `Thumbnail` row (222) against their files. I did not re-check the `UnavailableNotice` or `TemplateHighlighted` exemptions against the installed dist.

## realtime-examples divergences
I did not open realtime-examples this run. These come from the matrix.
- Open ❌ rows: message edit/delete/forward, diagram board, in-call reactions, agent-loop/HITL cards in the thread, call log outside social, files panel, transcription, pre-join screen, document review lifecycle.
- Typing indicator is ❌ in assessment, social and pipelines. Nothing outside the huddle chat passes `presence`/`typingUsers` or calls `setTyping`.
- Assessment and social have no work-graph caller.
- Pipelines presence is ⚠️ because `join: true` is missing.

ESCALATE: no — both gates pass and nothing changed since the last run. The four findings are low severity, with queue rows or a local wrapper.
