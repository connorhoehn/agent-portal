# Audit 2026-10-07
## Delta since last run
- new: 1 low finding (#6, `HuddleChat.tsx:308`).
- fixed: none.
- still open: 6. All are low; the five carried over were re-read at their cited lines.
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 21/38 · social: 17/38 · pipelines: 15/38. These come from the tally at `realtime-parity.md:72-79`. No cells were flipped, and the tally is unchanged from the 0516 report.
- Gates: component-discipline and nav-parity both pass in `gates.log`.
- Raw tags rose from 100 to 101 and the file count from 66 to 67. The cause is finding #6.
- Coverage: only the findings and exemptions below were re-read. `changed-files.txt` lists 720 files and I did not audit the rest. Most are middleware tests, plus many chat and deck files under `portal/src/components`.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Stroke width and label `transform` set in `style` from runtime values. The file comments cite the queue row. | Library edge helper (queue row 221) | upstream-needed |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio `<input>` with runtime `accentColor`, plus `borderLeftColor` in `style` | `Radio` (queue row 53) | upstream-needed (the 0516 report found no `Radio` export) |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | `Thumbnail` composite (queue row 222) | upstream-needed (the 0516 report found no `Thumbnail` export) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Local `parseDmLobby(name)` with its own tenant regex (`^([a-z][a-z0-9-]*):dm:`). It shares a name with the library export but has a different signature. It then calls `dmLobbyMembers`. | Build it on the library's `parseDmLobby(lobby, { prefix })`, as `social-chat.ts:59` does with `dmLobbyPrefix`, or rename it | yes |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:126-129` | Raw `<p>` and `<strong>` inside `<Prose>` | Put the text and `<strong>` directly in `Prose` | yes |
| 6 | low | `portal/src/components/shell/HuddleChat.tsx:308` | Bare `<span data-testid="huddle-reaction-bar">` wrapping `ReactionPickerButton`. It exists only as a test hook. | Pass `data-testid` to the library component, or use `Inline` | yes (`Inline` is used elsewhere in the portal; I did not check whether `ReactionPickerButton` forwards `data-testid`) |

- Runtime-colour inline styles remain tolerated and are covered by queue row 223: `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109` and `ScorePanelNode.tsx:44`.
- `useNotifications` is called once, at `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- The portal has no raw `WebSocket`. The 11 `EventSource` sites in `signals.txt` are non-gateway streams (canary, crawl, devbox tail, work events, assessment events, KB provisioning, authz, approvals, local-compute, data sources). None of them duplicates chat, presence or notification.
- `DM_PREFIX` and `dmMembers` in `portal/src/pages/social/socialChat.ts:68,76` and in `middleware/src/lib/social-chat.ts:59,84,89` build on the library's `dmLobbyPrefix`. I did not check whether `dmMembers` duplicates a library helper.

## Stale exemptions
- None confirmed this run.
- Row 224 (`MasterDetail` has no `paneFooter` slot) is still accurate for `MasterDetail`. The 0516 report found that the installed `ExplorerLayout` does take `paneFooter` (`dist/index.d.ts:8781,8824`), which may make the assessment scorecard's `sticky bottom-0` workaround avoidable. I did not check `ExplorerFrame.tsx`, so this is a lead, not a finding.
- Rows 53 and 222 are still needed, per the 0516 dist check. Row 221 and the other "Composed locally" rows are unchecked against the dist.

## realtime-examples divergences
These are carried from earlier reports. I did not re-verify them against `realtime-examples` file:line this run.
- Cursors are mounted in the gateway (`lib/gateway-cursor.ts`). The portal-side cursor wiring is on the assessment canvas only (`realtime-parity.md` §4a item 4). `realtime-examples` uses `hooks/useCursors.ts`.
- The gateway mounts no `rooms()`. `realtime-examples` has `/rooms` at `App.tsx:802-807`.
- `capabilities.tsx` mirrors Cedar actions locally. That is legitimate authority, but the generic read side could become a library wrapper.
- Agent-loop and HITL cards in the thread are ❌ in all four tenants (`realtime-parity.md`). `realtime-examples` has `useAgentLoopCards` and `useHitlMirror`.

ESCALATE: no — both gates pass and all six findings are low severity; one is new and trivial, and the rest are unchanged.
