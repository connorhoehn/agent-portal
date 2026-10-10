# Audit 2026-10-06

## Delta since last run
- new: none. `raw-scan.txt` matches the 1746 scan (66 files, 100 raw tags). The only difference is the denominator, 413 → 417 total tags, so a few tags were added elsewhere while the raw count stayed at 100.
- fixed: finding 5 of the last report said the runtime-colour `style={{ color }}` sites had no queue row. That was wrong. `docs/ui-components-queue.md:223` covers `ScorePanelNode`, `CompareDeltaTable`, `PersonDetailCard` and `Leaderboard`. Finding 4 (`ShareToSocialAction.tsx`) is also withdrawn: the `<p>`/`<strong>` sit inside `Prose` at lines 127-130, which is the intended use.
- still open: 4 findings, all low severity.
- parity ❌/⚠️ remaining (the 38-row tally at `realtime-parity.md:~74`, recounted from the matrix, no cells re-verified) — orgiq: 20/38 · assessment: 22/38 · social: 18/38 · pipelines: 15/38
- Both gates pass: `validate-component-discipline.sh` and `validate-nav-parity.sh`.
- Only `SharedNotifications.tsx:20` mounts `useNotifications`, so no duplicate mounts. My count command errored on the glob, so I'm relying on `signals.txt` for this.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `components/canary/edges/WeightedEdge.tsx:57,70` | Runtime `strokeWidth` and label `transform` in `style`. The label `Inline` also uses raw `text-[10px] font-semibold` classes (line 69). | A library `WeightedEdge`/`EdgeLabel` composite; `T` tokens for the label text | upstream-needed (queue row at line 221) |
| 2 | low | `components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` or a rich-row `RadioGroup` | upstream-needed (queue row at line 53) |
| 3 | low | `components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a frame sized at runtime; the placeholder uses raw `text-[10px]` | An `Image`/`Thumbnail` composite | upstream-needed (queue row at line 222) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Hand-written regex parse of the DM lobby with a variable tenant prefix. The library's `parseDmLobby` takes a fixed prefix. | A tenant-agnostic parse upstream, or keep the wrapper | upstream-needed |

I did not walk `DimensionRow.tsx` (6 raw tags) or `DiffFrame.tsx` (4 raw tags) brace-aware. The gate budget is my only evidence for them. The 11 `EventSource` sites in `signals.txt` are unchanged from the last report, and the gateway `activity()` candidates are `hooks/useWorkEvents.ts:16` and `pages/assessment/knowledge/useAssessmentEvents.ts:61`. The `DM_PREFIX` and `dmMembers` wrappers (`pages/social/socialChat.ts:68,76`, `lib/social-chat.ts:58,88`) were already confirmed as thin wrappers over the library helpers in the last report; I did not re-read them.

## Stale exemptions
None found. `WeightedEdge`, `VersionPickerStep` and `Thumbnail` still contain the elements their queue rows exempt. `docs/ui-components-queue.md` carries an uncommitted +104/−21 diff. I did not re-check the rows for `UnavailableNotice`, `DiffFrame`, `DimensionRow` or `TemplateHighlighted` against the installed dist.

## realtime-examples divergences
I did not open realtime-examples this run. These come from the matrix.
- Open ❌ rows: message edit/delete/forward (`WrappedChatPanel` has no props for them), diagram board, in-call reactions, agent-loop/HITL cards in the thread, call log outside social, channel files panel, transcription, pre-join screen, document review lifecycle.
- Typing and footer huddle context are closed in all four tenants (`composerTyping.ts`, matrix row 38).
- Pipelines presence is ⚠️ because the `join: true` option is missing.

ESCALATE: no — both gates pass, and the remaining findings are low severity with queue rows.
