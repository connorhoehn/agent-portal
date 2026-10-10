# Audit 2026-10-07

## Delta since last run
- new: a chat-forward feature in `portal/src/components/chat/useChatForward.tsx` and `portal/src/lib/chatForward.ts` (parity item 6). The file has no raw elements and no inline styles. It composes the library's `ConversationList`, `QuoteBlock`, `PopoverForm`, `SearchInput` and `EmptyState`. It reads the gateway with `useGatewayOptional`. `SocialConversation.tsx:236,329,355` wires it into `WrappedChatPanel` through `onForwardMessage`.
- fixed: nothing.
- still open: 5 low findings, all carried over.
- Both gates in `gates.log` pass (component-discipline and nav-parity).
- `raw-scan.txt` differs only in the scanned-file count (421 → 422), which is the new `useChatForward.tsx`. The raw-tag total is still 100 and the per-file tables are identical. `signals.txt` is identical.
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 20/38 · social: 18/38 · pipelines: 15/38. These are carried forward. I did not re-walk the matrix or flip the forward cell, since the matrix is a 115-line doc and I did not read it this run.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label placement in `style` | A library edge composite | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` | upstream-needed (queue row 53) |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | A `Thumbnail` composite | upstream-needed (queue row 222) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Local `parseDmLobby` wrapper | The library's `parseDmLobby` (0.109) | yes, but not re-verified. The wrapper may be needed for tenant discovery. |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127` | Raw `<p>` inside `<Prose>` | Plain text in `Prose` | yes. Carried over; I did not re-read the file. |

Runtime-colour `style={{ color }}` uses are unchanged and still tolerated as data-driven. They are in `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109` and `ScorePanelNode.tsx:44`.

`useNotifications` is still mounted once, in `SharedNotifications.tsx:20`. The 12 raw `EventSource` sites are unchanged. They are non-chat feeds (canary, crawl, devbox tail, approvals, authz log and similar), not duplicates of gateway chat, presence or notification subscriptions.

Portal files modified since last run:
- `SummarizableChatPanel.tsx`, `useChatForward.tsx`, `chatForward.ts` and `SocialConversation.tsx`: a grep for raw tags, `style={{`, `WebSocket` and `EventSource` found none in the first, second and fourth. I did not grep `chatForward.ts`, which is a plain `.ts` file.
- `CanvasDocumentPane.tsx`: same grep, no hits.

## Stale exemptions
None found. Queue rows 53, 221 and 222 still match raw-scan hits. I did not re-check the other "Composed locally" rows against the installed 2.424.0 dist.

## realtime-examples divergences
- The forward flow sends through `sendAndWaitForSocialChatAck` (join, send, wait for the persisted ack) and keeps the original in `metadata.forwardedFrom`. I did not find or compare the equivalent realtime-examples file this run. The gateway still decides every send, so authority stays server-side.
- Cursor wiring is still only on the assessment canvas (`CanvasDocumentPane.tsx`), and `rooms()` is still not mounted. The other standing gaps in `realtime-parity.md` are unchanged.

ESCALATE: no — both gates pass and the only new code composes library primitives with server-side send authority. I did not run tests or a live probe.
