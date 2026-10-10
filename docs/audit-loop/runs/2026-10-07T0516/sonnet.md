# Audit 2026-10-07

## Delta since last run
- new: none.
- fixed: none. Findings #4 and #5 from the 0446 report are re-read and still present as described. Findings #1–#3 are re-read only at the cited lines.
- still open: 5, all low.
- parity ❌/⚠️ remaining, from the tally at `realtime-parity.md:72-79` (⚠️+❌, "—" cells excluded; no cells re-walked or flipped) — orgiq: 20/38 · assessment: 21/38 · social: 17/38 · pipelines: 15/38. These match the 0446 report.
- Both gates in `gates.log` pass (component-discipline and nav-parity).
- The installed ui-components is 2.426.0, checked against `portal/node_modules`.
- Only the findings and exemptions below were re-read. The other changed files (720 in `changed-files.txt`) were not audited.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label placement in `style` | Library edge helper (queue row 221) | upstream-needed |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare `<input type="radio">` with runtime `accentColor`, plus `borderLeftColor` in `style` | Standalone `Radio` (queue row 53) | upstream-needed. `index.d.ts` has no `Radio`. |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | `Thumbnail` composite (queue row 222) | upstream-needed. `index.d.ts` has no `Thumbnail`. |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Local `parseDmLobby(name)`. It shares a name with the library export but has a different signature and its own tenant regex (`^([a-z][a-z0-9-]*):dm:`). `realtime-gateway.ts:96` imports it and calls it at `:443` and `:725`. | Build it on the library's `parseDmLobby(lobby, { prefix })` as `social-chat.ts` does, or rename it | yes |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127` | Raw `<p>` and `<strong>` inside `<Prose>` | Put the text and `<strong>` directly in `Prose` | yes |

- Runtime-colour inline styles remain tolerated as data-driven, covered by queue row 223: `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109` and `ScorePanelNode.tsx:44`.
- `useNotifications` has one call site: `SharedNotifications.tsx:20`. `ActivityBell.tsx` only mentions it in a comment.
- There is no raw `WebSocket`. The 11 `EventSource` sites in `signals.txt` are all non-gateway streams (canary, crawl, devbox tail, work events, assessment events, KB provisioning, authz, approvals, local-compute, data sources). None duplicates chat, presence or notification.
- Raw tags are unchanged at 100 across 66 of 423 files.

## Stale exemptions
- Queue row 224 (`MasterDetail` has no `paneFooter` slot) is still accurate for `MasterDetail`. The installed `ExplorerLayout` does take `paneFooter` (`dist/index.d.ts:8781,8824`). That may make the assessment scorecard's `sticky bottom-0` workaround avoidable. I did not check how `ExplorerFrame.tsx` is built, so this is a lead, not a finding.
- Rows 53 (`Radio`) and 222 (`Thumbnail`) are confirmed still needed. The dist has neither export.
- Row 221 (edge helpers) is not stale on this evidence. It is unchecked against the dist, as are the other "Composed locally" rows.

## realtime-examples divergences
These are carried over from the 0446 report. I did not re-verify them against `realtime-examples` file:line.
- Cursors are mounted in the gateway (`lib/gateway-cursor.ts`). `realtime-parity.md` §4a item 4 says the portal-side cursor wiring is on the assessment canvas only. `realtime-examples` uses `hooks/useCursors.ts`.
- The gateway mounts no `rooms()`. `realtime-examples` has `/rooms` at `App.tsx:802-807`.
- `capabilities.tsx` mirrors Cedar actions locally. That is legitimate authority, but the generic read side could become a library wrapper.
- The typing-indicator rows are consistent now. `realtime-parity.md` §4a item 1 records typing as closed in all four tenants on 2026-10-06, matching CLAUDE.md.

ESCALATE: no — both gates pass and all five findings are low severity and unchanged. The one caveat is that most of the changed portal files were not audited.
