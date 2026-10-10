# Audit 2026-10-07
## Delta since last run
- new: none.
- fixed: #6 (`HuddleChat.tsx:308`). The reaction bar is now wrapped in `Inline gap="none" data-testid=…` instead of a bare `<span>`.
- still open: 5, all low. I re-read #1–#5 at their cited lines this run.
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 21/38 · social: 17/38 · pipelines: 15/38. These are ⚠️+❌ from the tally at `realtime-parity.md:72-79`. No cells flipped, and the totals match the last run.
- Gates: component-discipline and nav-parity both pass in `gates.log`.
- Coverage: `changed-files.txt` lists 720 files, 400 of them under `portal/`. I re-read only the findings, the exemptions and the parity tally. I did not audit the other changed files, many of which are chat and deck components under `portal/src/components`.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Stroke width and label `transform` set in `style` from runtime values | Library edge helper (queue row 221) | upstream-needed |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio `<input>` with runtime `accentColor`, plus `borderLeftColor` in `style` | `Radio` (queue row 53) | upstream-needed |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame (`style={{ width, height }}`) | `Thumbnail` composite (queue row 222) | upstream-needed |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Local `parseDmLobby(name)` with its own tenant regex. It shares a name with the library export but has a different signature. | Build it on the library's `parseDmLobby(lobby, { prefix })`, or rename it | yes |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:126-129` | Raw `<p>` and `<strong>` inside `<Prose>` | Put the text and `<strong>` directly in `Prose` | yes |

- Runtime-colour inline styles remain tolerated under queue row 223: `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109` and `ScorePanelNode.tsx:44`.
- `useNotifications` is called once, at `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- The portal has no raw `WebSocket`. The 11 `EventSource` sites in `signals.txt` are non-gateway streams (canary, crawl, devbox tail, work events, assessment events, KB provisioning, authz, approvals, local-compute, data sources). None duplicates chat, presence or notifications.
- `DM_PREFIX` at `portal/src/pages/social/socialChat.ts:68` builds on the library's `dmLobbyPrefix`.
- The raw-scan summary reports 66 files and 100 tags, the same as the prior run's 0546 baseline. That fits #6 being fixed.

## Stale exemptions
- None confirmed.
- Row 224 (`MasterDetail` has no `paneFooter` slot) is still accurate for `MasterDetail`. The installed `ExplorerLayout` does take `paneFooter` (`dist/index.d.ts:8781,8824`, from the 0516 report), which may make the assessment scorecard's `sticky bottom-0` workaround avoidable. I did not re-check this run, so treat it as a lead, not a finding.
- Rows 53 and 222 are still needed, per the 0516 dist check. Row 221 and the other "Composed locally" rows are unchecked against the dist.

## realtime-examples divergences
These are carried from earlier reports. I did not re-verify them against `realtime-examples` file:line this run.
- Cursors are mounted in the gateway (`lib/gateway-cursor.ts`), but the portal wires them on the assessment canvas only (`realtime-parity.md` §4a item 4). `realtime-examples` uses `hooks/useCursors.ts`.
- The gateway mounts no `rooms()`. `realtime-examples` has `/rooms` at `App.tsx:802-807`.
- `capabilities.tsx` mirrors Cedar actions locally. That is legitimate authority, but the generic read side could become a library wrapper.
- Agent-loop and HITL cards in the thread are ❌ in all four tenants. `realtime-examples` has `useAgentLoopCards` and `useHitlMirror`.

ESCALATE: no — both gates pass, the five open findings are all low severity and unchanged, and the one finding from the last run is fixed.
