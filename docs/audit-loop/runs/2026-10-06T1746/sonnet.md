# Audit 2026-10-06

## Delta since last run
- new: none. `raw-scan.txt` and `signals.txt` have the same counts as the 1716 run: 66 files, 100 raw tags, the same 11 `EventSource` sites, and one non-test `useNotifications(` mount at `SharedNotifications.tsx:20`.
- fixed: the open question on local DM helpers is settled, and none of them are duplicates. `socialChat.ts:76` and `social-chat.ts:88` are thin wrappers over the library's `parseDmLobby(…, {prefix:'social:'})`. The library's `dmLobbyPrefix`, `dmLobbyName` and `parseDmLobby` are exported from the installed `dist/call/lobbyChannel.d.ts`. `splitServiceChannel` is re-exported from the installed dist (`dist/server/index.d.ts:28`).
- still open: 5 low-severity findings (listed below).
- parity ❌/⚠️ remaining, from the tally at `realtime-parity.md:74-79` (⚠️+❌ of 38): orgiq: 20/38 · assessment: 22/38 · social: 18/38 · pipelines: 15/38. I recounted these from the table rows and did not re-verify any cell in a browser. The pipelines figure is 15, not the 16 in the 1716 report, because the matrix row now shows 5 ⚠️ + 10 ❌. The 1716 report recorded the 16 as a recount (5+11), so I take it as miscounted or stale. 7 "—" rows are excluded.
- Both gates pass (`gates.log`).

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `components/canary/edges/WeightedEdge.tsx:57,70` | Inline `style` for the stroke width and the label transform. Both are runtime values, and the file has an uncommitted change. | A library weighted-edge or edge-label composite | upstream-needed (queue row) |
| 2 | low | `components/canary/setup/VersionPickerStep.tsx:63,70` | A runtime `borderLeftColor` and a runtime `accentColor` on a bare radio | A standalone `Radio` or a rich-row `RadioGroup` | upstream-needed (queue row) |
| 3 | low | `components/ingest/Thumbnail.tsx:42,57` | A raw `<img>` in a frame sized at runtime | An `Image` or `Thumbnail` composite | upstream-needed (queue row) |
| 4 | low | `components/decks/ShareToSocialAction.tsx:127-130` | A raw `<p>` and `<strong>` inside `Prose` | None needed. `Prose` children are its intended use. | yes |
| 5 | low | `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109`, `canary/nodes/ScorePanelNode.tsx:44` (all under `components/`) | Runtime-colour `style={{ color }}` | A `T` or `Badge` colour prop | upstream-needed (no queue row seen) |
| 6 | low | `middleware/src/lib/social-notify.ts:365` | A regex wrapper around the library's `dmLobbyMembers`, parsing the tenant prefix by hand. The library's `parseDmLobby` takes a fixed prefix, so a library change would be needed to cover a variable tenant. | Ask upstream for a tenant-agnostic parse, or keep the wrapper. | upstream-needed |

I did not walk `DimensionRow.tsx` (6 raw tags) or `DiffFrame.tsx` (4) brace-aware. The gate budget is my only evidence for them.

## Stale exemptions
None found. The `WeightedEdge`, `VersionPickerStep` and `Thumbnail` files still contain the raw elements their queue rows exempt.

`docs/ui-components-queue.md` has an uncommitted diff of +104/−21 lines. I did not re-check the other rows (`UnavailableNotice`, `DiffFrame`, `DimensionRow`, `TemplateHighlighted`) against the installed dist.

## realtime-examples divergences
I did not open realtime-examples this run. These citations come from the matrix.
- Typing: `HuddleChat.tsx:326,350` is the reference. The portal now matches it through `composerTyping.ts` in all four tenants (closed gap 4a.1).
- Page huddles: each of the four tenants has a footer context (`realtime-parity.md` row 38).
- Eleven `EventSource` sites remain, all against BFF SSE endpoints. `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` are the candidates for a gateway `activity()` subscription (matrix gap 5).
- Open ❌ rows, unchanged:
  - edit, delete and forward (`WrappedChatPanel` has no props for them)
  - diagram board
  - in-call reactions
  - agent-loop and HITL cards in the thread
  - call log outside social
  - files panel
  - transcription
  - pre-join screen
  - document review

ESCALATE: no — both gates pass, and the remaining findings are low severity and covered by queue rows.
