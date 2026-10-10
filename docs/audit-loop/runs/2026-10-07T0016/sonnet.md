# Audit 2026-10-07
## Delta since last run
- new: nothing in the raw-scan or signals output. `raw-scan.txt` and `signals.txt` are byte-identical to the 2346 run, and both gates in `gates.log` pass.
- fixed: last run's upstream proposal for server-stamped cursor identity has shipped. realtime-modules 0.114.0 is installed, and `middleware/src/lib/gateway-cursor.ts:21-23` now uses `cursor({ resolveIdentity, metadataAllowlist: [] })`. The `realtime-parity.md` cursor cells were already updated (lines 47, 88 and 102), so that stale-doc finding is closed.
- still open: 5 low findings, all carried over (numbered below).
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 20/38 · social: 18/38 · pipelines: 15/38. These counts are carried forward from last run and I did not re-walk the matrix. A new social cell, the work graph, is already marked ✅ in the doc.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label placement in `style` | A library edge composite | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` | upstream-needed (queue row 53) |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | A `Thumbnail` composite | upstream-needed (queue row 222) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Local `parseDmLobby` wrapper that reads the tenant prefix | The library's `parseDmLobby` (the 0.109 addition) | yes. The wrapper may still be needed for tenant discovery; I did not re-verify that against the dist. |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127` | Raw `<p>` inside `<Prose>` | Plain text in `Prose` | yes. This is carried over from last run; the raw-scan still lists the `<p>` there. |

The runtime-colour `style={{ color }}` uses are unchanged and still tolerated as data-driven: `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109` and `ScorePanelNode.tsx:44`.

Three portal files changed since the last run: `SummarizableChatPanel.tsx`, `HuddleChat.tsx` and `SocialConversation.tsx`. A grep found no raw `style`, `div`, `span`, `svg`, `img`, `input`, `button` or `p` tags in any of them. `SocialConversation.tsx` has 262 added lines against the last commit. I did not read its logic for hand-rolled realtime beyond the tag grep.

`useNotifications` is still mounted once, in `SharedNotifications.tsx:20`. The 12 raw `EventSource` sites are unchanged. They are non-chat feeds (canary, crawl, devbox tail, approvals, authz log, local compute and similar), not duplicates of gateway chat, presence or notification subscriptions.

## Stale exemptions
- None found. Queue rows 53, 221 and 222 still match raw-scan hits. `docs/ui-components-queue.md` was last modified at 20:48 on 10-06, and I did not re-check the other "Composed locally" rows against the installed 2.424.0 dist.
- Last run said the parity doc was stale for cursors. That is fixed.

## realtime-examples divergences
- The cursor identity duplication I flagged last run is gone. Identity now comes from the library, so there is no divergence from `realtime-examples/src/server.ts:1256` on that point.
- `authorizeChannel: () => true` at `gateway-cursor.ts:21` makes the router's channel authority the only gate. `realtime-gateway-cursor.test.ts:109` covers an orgiq session being refused on an assessment document, and `:125` covers a malformed position and an unrelated channel. I did not run the tests or a live probe.
- Cursor client wiring is still only on the assessment canvas (`CanvasDocumentPane.tsx`). `rooms()` is still not mounted. The other standing gaps in `realtime-parity.md` are unchanged.

ESCALATE: no — the cursor authority question from last run now has jest coverage for cross-tenant refusal, so no new judgment call is open. I did not run the tests, so a live probe is still optional.
