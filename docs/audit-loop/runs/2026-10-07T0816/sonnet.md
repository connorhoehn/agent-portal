```
# Audit 2026-10-07
## Delta since last run
- new: none.   - fixed: none.   - still open: 5 (all low, the same five as the 0746 report).
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 21/38 · social: 17/38 · pipelines: 15/38
```
Both gates in `gates.log` pass: component-discipline and nav-parity. `raw-scan.txt`, `signals.txt` and `changed-files.txt` are byte-identical to the 0746 run (66 files, 100 raw tags). I re-read the source for findings 2, 4 and 5 this run; findings 1 and 3 are carried over from the 0746 report without a re-read. I did not audit the other changed files line by line, and I flipped no parity cells.

The tally at `docs/audit-loop/realtime-parity.md:72-79` matches the counts above (⚠️+❌: orgiq 6+14, assessment 8+13, social 9+8, pipelines 5+10).

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime `strokeWidth` and the label `transform` in `style`. | Library edge helper (queue row 221). | upstream-needed |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,66-70` | A bare `<input type="radio">` with a runtime `accentColor`, and `borderLeftColor` in `style`. | `Radio` (queue row 53). | upstream-needed |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | A raw `<img>` with `style={{ width, minHeight }}`, and `style={{ width, height }}` on the placeholder. | `Thumbnail` composite (queue row 222). | upstream-needed |
| 4 | low | `middleware/src/lib/social-notify.ts:365-370` | A local `parseDmLobby(name)` with its own tenant regex, wrapping the library's `dmLobbyMembers`. It has the same name as a library export but a different signature. | Build it on the library's `parseDmLobby(lobby, { prefix })`, or rename it. | yes (signature carried over from the earlier report; I did not re-read the dist) |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127-130` | A raw `<p>` and two `<strong>` elements inside `<Prose>`. | Put the text and `<strong>` directly in `Prose`. | yes |

Other checks:
- **`useNotifications`:** it is mounted once, at `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- **WebSocket and EventSource:** the portal has no `new WebSocket`. The 11 `EventSource` sites are all non-gateway streams (canary, crawl, devbox tail, approvals, authz, local compute, assessment events, KB provisioning, work events), unchanged.
- **Local DM helpers:** `socialChat.ts:68` and `social-chat.ts:59` build their prefix with the library's `dmLobbyPrefix`, so they are not copies.
- **Static inline styles:** the only ones in `signals.txt` are the runtime colours and sizes above, plus the `deptColors` and `colorFor` colours in the scores components (`Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109`) and `ScorePanelNode.tsx:44`. I did not check those against the queue.

## Stale exemptions
- None confirmed.
- I did not re-check queue rows 221-224 against the installed dist this run.
- `docs/ui-components-queue.md` has uncommitted edits (+104/−21). I did not diff them against dist.
- Row 224 (`MasterDetail` `paneFooter`) may be avoidable via `ExplorerLayout`. This is an unverified lead from an earlier report.

## realtime-examples divergences
These are carried over from earlier reports and not re-verified against `realtime-examples` file:line this run.
- Cursors are wired on the assessment canvas only (`lib/gateway-cursor.ts`). `realtime-examples` uses `hooks/useCursors.ts`.
- The gateway mounts no `rooms()`. `realtime-examples` has `/rooms` at `App.tsx:802-807`.
- Agent-loop and HITL cards in the thread are ❌ in all four tenants. `realtime-examples` has `useAgentLoopCards` and `useHitlMirror`.
- Typing indicators are ❌ outside the huddle chat in assessment, social and pipelines.

ESCALATE: no — both gates pass, and the five open findings are low severity and unchanged.
