# Audit 2026-10-06

## Delta since last run
- new: three data-driven inline colour styles have no queue row (finding #1).
- fixed: nothing new. Both gates in `gates.log` still pass.
- still open: 1. It is the `DM_PREFIX` slicing (#2).
- Parity ❌/⚠️ remaining, from `realtime-parity.md` §4, which now counts 38 rows. I re-verified no cells.
  - orgiq: 20/38 (6⚠️ + 14❌); 9/25 on the original rows.
  - assessment: 23/38 (9⚠️ + 14❌); 11/25 on the original rows.
  - social: 19/38 (10⚠️ + 9❌); 9/25 on the original rows.
  - pipelines: 18/38 (7⚠️ + 11❌); 9/25 on the original rows.
  - The matrix body cells and the tally disagree. The pipelines presence cell is now ✅ (`PipelineRealtime.tsx:17`), but the tally prose still says it stays ⚠️. The matrix also shows typing as FIXED, while the tally prose says it was downgraded to ❌. The matrix body is newer, so the tally prose needs an update.
- The changed files are almost all middleware tests and server code. The portal changes are chat, pins, typing, summarize and deck, which the matrix already covers. I did not walk them brace-aware.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/nodes/ScorePanelNode.tsx:44`; `portal/src/components/scores/CompareDeltaTable.tsx:37,66`; `portal/src/components/scores/PersonDetailCard.tsx:109` | Runtime colours via `style={{ color }}`. `grep` finds zero mentions of these three files in `docs/ui-components-queue.md`. | Add queue rows, or use a library `Badge`/`Text` colour prop. | upstream-needed (a data-colour prop; not checked in the dist) |
| 2 | low | `portal/src/pages/social/socialChat.ts:68`; `middleware/src/lib/social-chat.ts:58` | `DM_PREFIX` is derived by slicing `dmLobbyName(['a','b'])`. The installed dist exports `isDmLobby`, but no prefix constant. | Upstream export of a DM-prefix helper, or leave as is. | upstream-needed |

I did not check whether `KBHealthBadge:85,87`, `VersionPickerStep:63,70` and `Leaderboard:86` have a "Composed locally" row. They are named once in the queue each.

Realtime checks:
- `useNotifications` has one non-test caller, `SharedNotifications.tsx:20`. `ActivityBell.tsx` only mentions it in a comment. No duplicate mount.
- The 11 `EventSource` uses are BFF SSE endpoints, unchanged from last run. `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` are the likeliest candidates for a gateway channel. I did not verify that.
- No `unreadFrom` in the portal, which matches the ⚠️ for social unread.

## Stale exemptions
- Queue rows at `docs/ui-components-queue.md:221` (`WeightedEdge`) and `:222` (`Thumbnail`) still match live `style={{` at `WeightedEdge.tsx:57,70` and `Thumbnail.tsx:42,57`. They are not stale.
- I did not check the other rows (`DiffFrame`, `UnavailableNotice`, `DimensionRow`, `TemplateHighlighted`, the Radio row at line 53) against the dist.

## realtime-examples divergences
I did not read any realtime-examples files this run, so I can't name a file:line. The matrix's own references (for example `MessagesPage.tsx:1576` for `usePins`) are unverified here.

ESCALATE: no — both gates pass, nothing here needs authority judgment, and the two findings are low-severity queue-hygiene and upstream-helper items.
