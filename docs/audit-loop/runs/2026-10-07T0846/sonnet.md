```
# Audit 2026-10-07
## Delta since last run
- new: none.   - fixed: none.   - still open: 5 (all low, the same five as the 0816 report).
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 21/38 · social: 17/38 · pipelines: 15/38
```
Both gates in `gates.log` pass (component-discipline and nav-parity). `raw-scan.txt` and `signals.txt` are byte-identical to the 0816 run. `changed-files.txt` differs from 0816 (the first difference is at line 302), and I did not review those changed files line by line. I flipped no parity cells. The tally at `docs/audit-loop/realtime-parity.md:72-79` matches the counts above (⚠️+❌: orgiq 6+14, assessment 8+13, social 9+8, pipelines 5+10).

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime `strokeWidth` and the label `transform` in `style`. I carried this over and did not re-read it. | Library edge helper (queue row 221) | upstream-needed |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,66-70` | A bare `<input type="radio">` with a runtime `accentColor`, and `borderLeftColor` in `style`. I re-read this one. | `Radio` (queue row 53) | upstream-needed |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | A raw `<img>` with `style={{ width, minHeight }}`, and `style={{ width, height }}` on the placeholder. I carried this over and did not re-read it. | `Thumbnail` composite (queue row 222) | upstream-needed |
| 4 | low | `middleware/src/lib/social-notify.ts:365-370` | A local `parseDmLobby(name)` with its own tenant regex, wrapping the library's `dmLobbyMembers`. It has the same name as a library export but a different signature. I re-read this one. | Build it on the library's `parseDmLobby(lobby, { prefix })`, or rename it. | yes (carried over, dist not re-read) |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127-130` | A raw `<p>` and two `<strong>` elements inside `<Prose>`. I re-read this one. | Put the text and `<strong>` directly in `Prose`. | yes |

Other checks, from `signals.txt`:
- **`useNotifications`:** it is mounted once, at `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- **WebSocket and EventSource:** the portal has no `new WebSocket`. The 11 `EventSource` sites are all non-gateway streams (canary, crawl, devbox tail, approvals, authz, local compute, assessment events, KB provisioning, work events).
- **Local DM helpers:** `socialChat.ts:68` and `social-chat.ts:59` build their prefix with the library's `dmLobbyPrefix`, so they are not copies.
- **Static inline styles:** the only ones are runtime colours or sizes (`deptColors` and `colorFor` in the scores components, `ScorePanelNode.tsx:44`, plus findings 1–3). I did not check the scores ones against the queue.

## Stale exemptions
- None confirmed.
- I did not re-check queue rows 221-224 against the installed dist this run.
- `docs/ui-components-queue.md` has uncommitted edits that I did not diff against dist.
- Row 224 (`MasterDetail` `paneFooter`) shipped in ui-components 2.427.0 per `CLAUDE.md`. If that row still exempts a file, it is probably stale; I did not verify this.

## realtime-examples divergences
These are carried over and not re-verified against `realtime-examples` file:line this run.
- Cursors are wired on the assessment canvas only (`lib/gateway-cursor.ts`). `realtime-examples` uses `hooks/useCursors.ts`.
- The gateway mounts no `rooms()`. `realtime-examples` has `/rooms` at `App.tsx:802-807`.
- Agent-loop and HITL cards in the thread shipped 2026-10-06 in all four tenants (`ConversationAgentCard.tsx`; parity matrix §4a item 7). Refreshed 2026-10-07 to match the matrix; not re-read in the browser.
- Typing indicators shipped 2026-10-06 in all four tenants (`composerTyping.ts`; matrix §4a item 1).

ESCALATE: no — both gates pass, and the five open findings are low severity and unchanged.
