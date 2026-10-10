# Audit 2026-10-07

## Delta since last run
- new: none.
- fixed: none this run.
- still open: 5, all low. I re-read #1–#5 at their cited lines and each is unchanged.
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 21/38 · social: 17/38 · pipelines: 15/38. These are ⚠️+❌ from the tally at `realtime-parity.md:72-79`. They match the last run, and I flipped no cells.
- Gates: component-discipline and nav-parity both pass in `gates.log`.
- Coverage: `changed-files.txt` lists 720 files, 400 of them under `portal/`. I re-read only the five findings and the parity tally. I did not audit the other changed files.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | `strokeWidth` and the label `transform` are set in `style` from runtime values. | Library edge helper (queue row 221). | upstream-needed |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | A bare radio `<input>` with a runtime `accentColor`, plus `borderLeftColor` in `style`. | `Radio` (queue row 53). | upstream-needed |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | A raw `<img>` in a frame sized by `style={{ width, height }}`. | `Thumbnail` composite (queue row 222). | upstream-needed |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | A local `parseDmLobby(name)` with its own tenant regex. It shares a name with the library export but has a different signature. | Build it on the library's `parseDmLobby(lobby, { prefix })`, or rename it. | yes |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:126-129` | A raw `<p>` and `<strong>` inside `<Prose>`. | Put the text and `<strong>` directly in `Prose`. | yes |

- The runtime-colour inline styles under queue row 223 are still tolerated. They are at `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109` and `ScorePanelNode.tsx:44`.
- `useNotifications` is called once, at `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- The portal has no raw `WebSocket`. The 11 `EventSource` sites in `signals.txt` are non-gateway streams (canary, crawl, devbox tail, work events, assessment events, KB provisioning, authz, approvals, local-compute, data sources). None duplicates chat, presence or notifications.
- `DM_PREFIX` at `portal/src/pages/social/socialChat.ts:68` and `SOCIAL_DM_PREFIX` at `middleware/src/lib/social-chat.ts:59` both build on the library's `dmLobbyPrefix`.
- The raw-scan summary reports 66 files and 100 raw tags, the same as the last run.

## Stale exemptions
- None confirmed.
- Row 224 (`MasterDetail` has no `paneFooter` slot) is still accurate for `MasterDetail`. An earlier report found that the installed `ExplorerLayout` does take `paneFooter`. That may make the assessment scorecard's `sticky bottom-0` workaround avoidable. I did not re-check this run, so treat it as a lead.
- Rows 53 and 222 were last checked against the dist in the 0516 report. I did not re-check row 221 or the other "Composed locally" rows against the dist.

## realtime-examples divergences
I carried these over from earlier reports and did not re-verify them against `realtime-examples` file:line this run.
- The gateway mounts cursors (`lib/gateway-cursor.ts`), but the portal wires them on the assessment canvas only. `realtime-examples` uses `hooks/useCursors.ts`.
- The gateway mounts no `rooms()`. `realtime-examples` has `/rooms` at `App.tsx:802-807`.
- Agent-loop and HITL cards in the thread are ❌ in all four tenants (`realtime-parity.md`). `realtime-examples` has `useAgentLoopCards` and `useHitlMirror`.
- Typing indicators are ❌ in assessment, social and pipelines, because nothing outside the huddle chat passes `presence`/`typingUsers` or calls `setTyping`.

ESCALATE: no — both gates pass, and the five open findings are all low severity and unchanged.
