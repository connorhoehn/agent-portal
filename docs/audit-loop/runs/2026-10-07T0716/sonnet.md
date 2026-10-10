```
# Audit 2026-10-07
## Delta since last run
- new: none.   - fixed: none.   - still open: 5 (all low, same five as the 0646 report).
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 21/38 · social: 17/38 · pipelines: 15/38
```
I flipped no parity cells. The tally at `realtime-parity.md:72-79` gives these counts as ⚠️+❌ (orgiq 6+14, assessment 8+13, social 9+8, pipelines 5+10). Both gates in `gates.log` pass. `raw-scan.txt` and `signals.txt` are byte-identical to the 0646 run (66 files, 100 raw tags). I checked the five findings against the source files and did not re-audit the roughly 720 other changed files.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57-58,70-71` | `strokeWidth` and the label `transform` come from runtime values in `style`. A code comment points to the queue row. | Library edge helper (queue row 221). | upstream-needed |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | A bare `<input type="radio">` with a runtime `accentColor`, and `borderLeftColor` in `style`. | `Radio` (queue row 53). | upstream-needed |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | A raw `<img>` with `style={{ width, minHeight }}`. The placeholder `Inline` takes `style={{ width, height }}`. | `Thumbnail` composite (queue row 222). | upstream-needed |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | A local `parseDmLobby(name)` with its own tenant regex. It shares a name with the library export but has a different signature. | Build it on the library's `parseDmLobby(lobby, { prefix })`, or rename it. | yes |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:126-129` | A raw `<p>` and `<strong>` inside `<Prose>`. | Put the text and `<strong>` directly in `Prose`. | yes |

Other checks:
- **`useNotifications`:** it is mounted once, at `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- **WebSocket:** the portal has no `new WebSocket`.
- **EventSource:** it was unchanged since last run. Last run's 11 sites are non-gateway streams.

## Stale exemptions
- None confirmed.
- I did not re-check queue rows 221–224 against the installed dist this run.
- Row 224 (`MasterDetail` `paneFooter`) may be avoidable via `ExplorerLayout`. This is an unverified lead from an earlier report.
- `docs/ui-components-queue.md` has about 105 uncommitted added lines. I did not diff them against dist.

## realtime-examples divergences
I carried these over from earlier reports and did not re-verify them against `realtime-examples` file:line this run.
- Cursors are wired on the assessment canvas only. The gateway mounts them in `lib/gateway-cursor.ts`. `realtime-examples` uses `hooks/useCursors.ts`.
- The gateway mounts no `rooms()`. `realtime-examples` has `/rooms` at `App.tsx:802-807`.
- Agent-loop and HITL cards in the thread are ❌ in all four tenants. `realtime-examples` has `useAgentLoopCards` and `useHitlMirror`.
- Typing indicators are ❌ outside the huddle chat in assessment, social and pipelines.

ESCALATE: no — both gates pass, and the five open findings are low severity and unchanged.
