# Audit 2026-10-06

## Delta since last run
- new: none. `raw-scan.txt` still shows 66 files and 100 raw tags of 417, the same as the 1816 run.
- fixed: none.
- still open: 4, all low severity and the same four as last run. Findings 1–3 were re-read this run. Finding 4 is carried from the 1816 report.
- parity ❌/⚠️ remaining, recounted from `realtime-parity.md:72-79` — orgiq: 20/38 · assessment: 22/38 · social: 18/38 · pipelines: 15/38. I did not re-verify any cell against code this run. `ChannelActivity.tsx` and many `components/chat/*` files are in `changed-files.txt`, but they belong to the 2026-10-06 slices the matrix already records.
- Gates: `validate-component-discipline.sh` and `validate-nav-parity.sh` both pass (`gates.log`).
- `useNotifications` is mounted once, at `components/shell/SharedNotifications.tsx:20`, so there are no duplicate mounts.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `components/canary/edges/WeightedEdge.tsx:57,70` | Runtime `strokeWidth` and label `transform` in `style`. The label also carries raw `text-[10px] font-semibold` classes (line 69). | A library edge/label composite, with `T` tokens for the label text | upstream-needed (queue row 221) |
| 2 | low | `components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` or a rich-row `RadioGroup` | upstream-needed (queue row ~53) |
| 3 | low | `components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame. The placeholder uses raw `text-[10px]`. | An `Image`/`Thumbnail` composite | upstream-needed (queue row 222) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Hand-written DM-lobby parse with a variable tenant prefix. The library's `parseDmLobby` takes a fixed prefix. | A tenant-agnostic parse upstream, or keep the wrapper | upstream-needed |

I did not walk `DimensionRow.tsx` (6 raw tags) or `DiffFrame.tsx` (4) brace-aware, so the gate budget is my only evidence for them.

The eleven `EventSource` sites in `signals.txt` are unchanged. `hooks/useWorkEvents.ts:16` and `pages/assessment/knowledge/useAssessmentEvents.ts:61` are still the likeliest candidates for the gateway `activity()` feed. I did not check whether that feed exists in the installed dist.

The `DM_PREFIX` and `dmMembers` wrappers (`pages/social/socialChat.ts:68,76`, `lib/social-chat.ts:58,88`) use the library's `dmLobbyPrefix`. I did not re-read them this run.

## Stale exemptions
None found. The `WeightedEdge`, `VersionPickerStep` and `Thumbnail` rows still match elements present in those files. I did not re-check the rows for `UnavailableNotice`, `DiffFrame`, `DimensionRow` or `TemplateHighlighted` against the installed dist.

## realtime-examples divergences
I did not open realtime-examples this run. These come from the matrix.
- Open ❌ rows: message edit/delete/forward, diagram board, in-call reactions, agent-loop/HITL cards in the thread, call log outside social, channel files panel, transcription, pre-join screen, document review lifecycle.
- Assessment has the most open rows (22/38). Its work graph has no caller in `pages/assessment` (`realtime-parity.md:57`), and social has none in `pages/social`.
- Pipelines presence is ⚠️ because the `join: true` option is missing.

ESCALATE: no — both gates pass, and the four findings are low severity with queue rows or an upstream wrapper.
