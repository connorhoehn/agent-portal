# Audit 2026-10-07

## Delta since last run
- new: none that I could verify. `raw-scan.txt` and `signals.txt` are identical to the 0046 run (422 files scanned, 100 raw tags, same static-style sites, same 12 `EventSource` sites). Both gates in `gates.log` pass: component-discipline and nav-parity.
- fixed: nothing.
- still open: 5 (all low, carried over).
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 20/38 · social: 18/38 · pipelines: 15/38. These are carried forward unchanged. I did not re-walk the per-tenant cells. `realtime-parity.md` has 17 ❌ and 17 ⚠️ lines in total, which is not a per-tenant count.
- `changed-files.txt` lists 706 entries, which is the whole dirty tree against HEAD. It is not a delta since the last run. I did not diff it against the previous run.
- The matrix header says installed realtime-modules 0.113.0 and ui-components 2.423.0. The installed dist is now realtime-modules 0.114.0 in both consumers and ui-components 2.425.0. The header is stale, and the cell evidence should be re-checked against the newer dist.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label placement in `style` | A library edge composite | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` | upstream-needed (queue row 53) |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | A `Thumbnail` composite | upstream-needed (queue row 222) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | A local `parseDmLobby` wrapper that shares its name with the library export. It has a different signature and discovers the tenant from the prefix. | The library's `parseDmLobby(lobby, { prefix })` from `.../call` (`lobbyChannel.d.ts:73`), as `social-chat.ts:90,101` already does | yes. The library version needs a known prefix, so the wrapper's only extra job is tenant discovery. Rename it, or build it on the library function. |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127` | Raw `<p>` wrapping `<strong>` inside `<Prose>` | Text and `<strong>` directly in `Prose` | yes. I read the file this run. |

- Runtime-colour `style={{ color }}` uses remain tolerated as data-driven: `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109` and `ScorePanelNode.tsx:44`.
- The largest raw-tag files are unchanged: `DimensionRow.tsx` (6), `TemplateHighlighted.tsx` (4), `DiffFrame.tsx` (4) and `UnavailableNotice.tsx` (3). The gate passes on its budget, so I did not escalate them.
- `useNotifications` is still mounted once, in `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- A grep of `components/chat/*.tsx`, `components/decks/*.tsx`, `ActivityBell.tsx` and `ChannelActivity.tsx` for `<div|span|svg|input`, `style={{`, `WebSocket` and `EventSource` returned no hits.
- The 12 `EventSource` sites are non-chat feeds (canary, crawl, devbox tail, approvals, authz log, local-compute, work events, assessment events, KB provisioning). None duplicates a gateway chat, presence or notification subscription.
- DM helpers: `portal/src/pages/social/socialChat.ts:68` and `middleware/src/lib/social-chat.ts:59` build `dmLobbyPrefix` from the library. The local `dmMembers` wrappers around them are thin.

## Stale exemptions
None found. Queue rows 53, 221 and 222 still match raw-scan hits. I did not re-check the other "Composed locally" rows against ui-components 2.425.0. `docs/ui-components-queue.md` is in the changed list, so someone should diff its rows against the 2.423–2.425 release notes.

## realtime-examples divergences
- Cursor wiring is still only on the assessment canvas. The orgiq, social and pipelines canvases do not mount `cursor()`. realtime-examples uses `hooks/useCursors.ts` and the server at `server.ts:1256`.
- `rooms()` is still not mounted. It exists in the installed dist (`dist/server/index.d.ts:19`), while realtime-examples has `/rooms` at `App.tsx:802-807`.
- `lib/capabilities.tsx` mirrors Cedar actions instead of using `useCapabilities` or `useFeatureFlag`. This is legitimate local authority, but the generic read side could be a library wrapper.
- I did not compare the forward flow against a realtime-examples file this run. The same gap was reported last run.

ESCALATE: no — both gates pass, the scans are identical to the last run, and I found nothing new. The stale matrix header (0.113/2.423 against installed 0.114/2.425) is worth a refresh but does not need judgment.
