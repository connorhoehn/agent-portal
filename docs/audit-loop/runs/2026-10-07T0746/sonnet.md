```
# Audit 2026-10-07
## Delta since last run
- new: none.   - fixed: none.   - still open: 5 (all low, the same five as the 0716 report).
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 21/38 · social: 17/38 · pipelines: 15/38
```
Both gates in `gates.log` pass. `raw-scan.txt` and `signals.txt` are byte-identical to the 0716 run (66 files, 100 raw tags). I re-read the source for all five findings and they are unchanged. I did not audit the other ~300 changed files in `portal/src` and `middleware/src` line by line. I flipped no parity cells. The tally at `realtime-parity.md:72-79` matches the counts above (⚠️+❌: orgiq 6+14, assessment 8+13, social 9+8, pipelines 5+10). `docs/audit-loop/realtime-parity.md` is untracked in git.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57-60,70` | `strokeWidth` and the label `transform` are runtime values in `style`. A code comment at lines 55-56 points to the queue row. | Library edge helper (queue row 221). | upstream-needed |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,66-70` | A bare `<input type="radio">` with a runtime `accentColor`, and `borderLeftColor` in `style`. | `Radio` (queue row 53). | upstream-needed |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,49-57` | A raw `<img>` with `style={{ width, minHeight }}`. The placeholder `Inline` takes `style={{ width, height }}`. | `Thumbnail` composite (queue row 222). | upstream-needed |
| 4 | low | `middleware/src/lib/social-notify.ts:365-369` | A local `parseDmLobby(name)` with its own tenant regex, on top of the library's `dmLobbyMembers`. It shares a name with the library export but has a different signature. | Build it on the library's `parseDmLobby(lobby, { prefix })`, or rename it. | yes (the signature is carried over from the earlier report; I did not re-read the dist this run) |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127-130` | A raw `<p>` and `<strong>` inside `<Prose>`. | Put the text and `<strong>` directly in `Prose`. | yes |

Other checks:
- **`useNotifications`:** it is mounted once, at `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- **WebSocket:** the portal has no `new WebSocket`.
- **EventSource:** it has 11 sites, all on non-gateway streams (canary, crawl, devbox tail, approvals, authz, local compute, assessment events). The list is unchanged.
- **Local DM helpers:** `socialChat.ts:68` and `social-chat.ts:59` build their prefix with the library's `dmLobbyPrefix`, so they are not copies.

## Stale exemptions
- None confirmed.
- I did not re-check queue rows 221-224 against the installed dist this run.
- Row 224 (`MasterDetail` `paneFooter`) may be avoidable via `ExplorerLayout`. This is an unverified lead carried over from an earlier report.
- `docs/ui-components-queue.md` has uncommitted edits. I did not diff them against dist.

## realtime-examples divergences
I carried these over from earlier reports and did not re-verify them against `realtime-examples` file:line this run.
- Cursors are wired on the assessment canvas only. The gateway mounts them in `lib/gateway-cursor.ts`. `realtime-examples` uses `hooks/useCursors.ts`.
- The gateway mounts no `rooms()`. `realtime-examples` has `/rooms` at `App.tsx:802-807`.
- Agent-loop and HITL cards in the thread are ❌ in all four tenants (`realtime-parity.md`). `realtime-examples` has `useAgentLoopCards` and `useHitlMirror`.
- Typing indicators are ❌ outside the huddle chat in assessment, social and pipelines (`realtime-parity.md`).

ESCALATE: no — both gates pass, and the five open findings are low severity and unchanged.
