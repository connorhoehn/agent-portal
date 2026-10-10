# Audit 2026-10-06

## Delta since last run
- new: none in the scan output. One low-severity item I found by reading: a raw `<p>` and `<strong>` inside `Prose` in `ShareToSocialAction.tsx:127`. The scan counts it as 1 raw `p`.
- fixed: nothing in code. I flagged `Thumbnail.tsx` last run, and that was a correction, not a fix.
- still open: 3 (the two inline-style findings from last run, plus `Thumbnail.tsx`). All are queue-covered.
- Stale docs: `docs/audit-loop/realtime-parity.md:38` marks the typing indicator ✅ FIXED, but the §4 tally note (`:81`) and §4a item 1 (`:85`) still say typing is ❌ and "dead outside the huddle". Typing is wired in `SummarizableChatPanel.tsx` and `SocialConversation.tsx` (`setTyping`/`typingUsers` found by grep). Row 38 appears right, so the tally text and §4a need a refresh.
- parity ❌/⚠️ remaining, from the §4 tally (`realtime-parity.md:74-80`), not re-verified cell by cell: orgiq 20/38 · assessment 23/38 · social 19/38 · pipelines 18/38. Pipelines has 7 more rows marked "—", which are not counted in the 18. Last run said 7 of the 18 were "—", which was wrong.
- Both gates pass (`gates.log`). `useNotifications(` has one non-test mount, `SharedNotifications.tsx:20`, so there is no duplicate.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Traffic-weighted stroke width and label transform in inline `style`. The code comments say this is data-driven geometry from `getBezierPath`, with a queue row. | A library weighted-edge or edge-label composite. | upstream-needed |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | A runtime `borderLeftColor` and a bare radio with a runtime `accentColor`. | A standalone `Radio` or a rich-row `RadioGroup`. | upstream-needed (queue ~`:53`, not re-read) |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | A raw `<img>` with a runtime-sized frame. | An `Image` or `Thumbnail` composite with a fallback. | upstream-needed (queue `:222`) |
| 4 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127` | A raw `<p>` and `<strong>` as the body copy, inside `Prose`. | `Prose` handles this case, so it is probably acceptable. Use `Text` or `Prose` children if the gate ever counts it. | yes (`Prose` is already imported) |

The runtime-colour `style={{ color }}` hits in `ScorePanelNode`, `Leaderboard`, `CompareDeltaTable` and `PersonDetailCard` are unchanged. I did not re-verify their queue row (~`:223`).

Other things I saw in `raw-scan.txt`:
- 66 files have raw tags, 100 tags in total. The biggest are `DimensionRow.tsx` (6), `TemplateHighlighted.tsx`, `DiffFrame.tsx` and `UnavailableNotice.tsx`. I did not walk these brace-aware, so the gate budget is my only evidence for them.
- There are 11 `EventSource` uses, all against BFF SSE endpoints. `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` are candidates for a gateway activity subscription, but I did not check them.
- The scan found no raw `new WebSocket` in `portal/src`.
- The scan flags `dmLobbyPrefix({ prefix: 'social:' })` at `portal/src/pages/social/socialChat.ts:68` and `middleware/src/lib/social-chat.ts:58`. Both call the library helper, so they are not copies. The local `dmMembers` (`socialChat.ts:76`, `social-chat.ts:88`) and `parseDmLobby` (`social-notify.ts:365`) are the real duplication candidates. I did not check whether the installed dist exports an equivalent.

## Stale exemptions
None found, but not re-checked. The queue file has a large uncommitted diff, and I did not re-verify its rows against the installed dist. That includes `UnavailableNotice`, `DiffFrame`, `DimensionRow` and `TemplateHighlighted`.

## realtime-examples divergences
I did not open realtime-examples this run. The citations come from the matrix.
- Typing: `HuddleChat.tsx:326,350` is the reference. The portal's `SummarizableChatPanel` and `SocialConversation` now follow it.
- Remaining ❌ rows (`realtime-parity.md` rows 26–38):
  - agent-loop and HITL cards in the thread, ❌ in all four tenants. The matrix notes `middleware/src/lib/agent-loop/plan.ts` is server-only.
  - in-call reactions, ❌ in three tenants.
  - message edit/delete/forward.
  - diagram board.
  - document review.
  - `useWorkGraph` outside orgiq (`:57`).
- Footer huddle bar (matrix row 38 in the table, not the "Typing indicator" row 38): ⚠️ in assessment, social and pipelines. This is a design limit because no page maps to a lobby.

ESCALATE: no — both gates pass, and the open findings are low-severity upstream gaps already queued. The only action is refreshing the stale typing text in `realtime-parity.md`.
