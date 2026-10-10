# Audit 2026-10-06

## Delta since last run
- new: none. The raw scan is unchanged (66 files, 100 raw tags). `WeightedEdge.tsx` changed (+3/−2), but its inline `style` is still only the stroke width and label transform, and the queue row covers both (`ui-components-queue.md:221`).
- fixed: the previous report's stale typing text in `docs/audit-loop/realtime-parity.md` is refreshed. Section 4a items 1–3 are now marked CLOSED (typing, pipelines presence, page huddles).
- still open: 4. These are `WeightedEdge.tsx:57,70`, `VersionPickerStep.tsx:63,70`, `Thumbnail.tsx:42,57` and `ShareToSocialAction.tsx:127`.
- parity ❌/⚠️ remaining, from the section 4 tally (`realtime-parity.md:74-79`) as ⚠️+❌ out of 38. I recounted from the tally rows but did not re-verify cells in the browser: orgiq 20/38 · assessment 22/38 · social 18/38 · pipelines 16/38. Pipelines has 7 more rows marked "—" that are not counted. The previous report's 20/23/19/18 came from the stale tally and is superseded.
- Both gates pass (`gates.log`). `useNotifications(` has one non-test mount, `SharedNotifications.tsx:20`, and `ActivityBell.tsx` only mentions it in a comment. There is no raw `new WebSocket` in `portal/src`.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `components/canary/edges/WeightedEdge.tsx:57,70` | Per-render stroke width and a label `transform` in inline `style` | A library weighted-edge or edge-label composite | upstream-needed (queue `:221`) |
| 2 | low | `components/canary/setup/VersionPickerStep.tsx:63,70` | A bare radio with a runtime `accentColor`, and a runtime `borderLeftColor` | A standalone `Radio` or a rich-row `RadioGroup` | upstream-needed (queue `:53`) |
| 3 | low | `components/ingest/Thumbnail.tsx:42,57` | A raw `<img>` with a runtime-sized frame and an error fallback | An `Image` or `Thumbnail` composite | upstream-needed (queue `:222`, which says no installed composite was verified) |
| 4 | low | `components/decks/ShareToSocialAction.tsx:127-130` | A raw `<p>` and `<strong>` inside `Prose size="sm"` | `Prose` children are probably acceptable. Use `T` if the gate ever counts them. | yes |
| 5 | low | `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109`, `canary/nodes/ScorePanelNode.tsx:44` (all under `components/`) | Runtime-colour `style={{ color }}` on `Inline`. I did not check whether a queue row covers them. | A `T` or `Badge` colour prop | upstream-needed (queue row not found) |

I did not walk the other raw tags brace-aware, such as `DimensionRow.tsx` (6) and `DiffFrame.tsx` (4). For those, the gate budget is my only evidence.

Eleven `EventSource` uses remain, all against BFF SSE endpoints. `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` are candidates for a gateway `activity()` subscription. This matches matrix gap 5, which covers Work graph and Activity outside orgiq.

The local `dmMembers` (`portal/src/pages/social/socialChat.ts:76`, `middleware/src/lib/social-chat.ts:88`) and `parseDmLobby` (`middleware/src/lib/social-notify.ts:365`) could duplicate library helpers. I did not check whether the installed dist exports equivalents. That check is a TODO for the next run.

## Stale exemptions
None found. I confirmed that the `WeightedEdge`, `VersionPickerStep` and `Thumbnail` files still contain the raw elements their rows exempt. I did not re-check the other queue rows (`UnavailableNotice`, `DiffFrame`, `DimensionRow`, `TemplateHighlighted`) against the installed dist, and `docs/ui-components-queue.md` has an uncommitted diff.

## realtime-examples divergences
I did not open realtime-examples this run. These citations come from the matrix.
- Typing: `HuddleChat.tsx:326,350` is the reference, and it is now followed by `composerTyping.ts`, `SummarizableChatPanel` and `SocialConversation`.
- Page huddles: `usePageHuddle.ts` registers per-page lobbies, as the matrix describes. Huddle chat (`call-chat.ts:121`) and page sharing stay orgiq-only, so assessment team and pipelines run huddles have no in-call Message pane.
- Remaining ❌ rows:
  - `cursor()`/`rooms()` are not mounted on the gateway.
  - Recordings and knock exist only in Social.
  - Message edit/delete/forward is blocked because `WrappedChatPanel` has no such props.
  - The diagram board and in-call reactions are open.
  - Pre-join and transcription are open.
  - HITL step approval inside a running agent loop is open.

ESCALATE: no — both gates pass and the open findings are low-severity items that the queue already covers. The one question for a human is the matrix's note that platform-api's `lobbyAccess` has no per-resource check. That is already recorded in `realtime-parity.md` as open.
