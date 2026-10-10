# Audit 2026-10-06

## Delta since last run
- new: `KBHealthBadge.tsx:85,87` and `Leaderboard.tsx:86` use `style={{…}}` runtime colours with no "Composed locally" queue row. They are not new code, but this is the first run that checked them.
- fixed: last run's finding #1. Queue row `docs/ui-components-queue.md:223` now covers `ScorePanelNode`, `CompareDeltaTable` and `PersonDetailCard`. That row is the only exemption, and it does not name `Leaderboard` or `KBHealthBadge`.
- still open: 3. These are #1 and #2 below, plus the `DM_PREFIX` slicing.
- Both gates pass (`gates.log`). `useNotifications` still has exactly one non-test caller, `SharedNotifications.tsx:20`.
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 23/38 · social: 19/38 · pipelines: 18/38. I took these from the matrix §4 tally and did not re-verify any cells. The changed portal files are chat, deck and pins code that the matrix already covers, and the budget did not allow a cell-by-cell walk.
- Doc inconsistency: the §4 tally table (orgiq 17 ✅/6 ⚠️/14 ❌, and so on) agrees with these counts. Last run's note that the tally prose disagrees with the matrix body was not re-checked.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/scores/Leaderboard.tsx:86` | `style={{ color: deptColors[…] }}` on an `Inline`. It is the same runtime-colour pattern as queue row 223 but is not named in it. | Add the file to row 223, or use a library colour prop. | upstream-needed (row 223 says no dist component takes a runtime colour) |
| 2 | low | `portal/src/components/kb/KBHealthBadge.tsx:80-87` | A `ghost` Button restyled into a pill with `style={{ borderColor, background, color }}` and a second inline `color` on the dot. The queue mentions the file only inside the ghost-Button row (`:81`), not as an inline-style exemption. | A library `Badge`/`StatusPill` with a severity tone. Otherwise add a "Composed locally" row. | no (unchecked against the dist); likely a `Badge` tone exists, so check first |
| 3 | low | `portal/src/pages/social/socialChat.ts:68`, `middleware/src/lib/social-chat.ts:58` | `DM_PREFIX` is derived by slicing `dmLobbyName(['a','b'])`. The installed dist re-exports `dmLobbyName`, `channelForLobby`, `lobbyForChannel` and `isDmLobby` (`dist/client/video/index.d.ts:20`), but no prefix helper. | Upstream a DM-prefix export, or accept the derivation. | upstream-needed |

Other checks:
- The 11 `EventSource` uses in `raw-scan` and `signals` match last run. They are all BFF SSE endpoints.
- Per the matrix, `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` are the candidates for a gateway `activity()` subscription (assessment activity cell ⚠️). I did not confirm either.
- I did not walk the 66 files in `raw-scan` brace-aware. The gate's budgets pass, and the top offenders (`DimensionRow`, `DiffFrame`, `TemplateHighlighted`, `UnavailableNotice`) are unchanged from last run.

## Stale exemptions
- None found. `WeightedEdge.tsx` is in the changed files and the queue still lists it (rows 221–222). Last run found it still had live `style={{` at lines 57 and 70, but I did not re-open it this run.
- The `DiffFrame`, `UnavailableNotice`, `DimensionRow` and `TemplateHighlighted` rows and the Radio row at `:53` are unverified against the dist.

## realtime-examples divergences
I did not re-read realtime-examples this run (budget). Nothing in the changed files contradicts the matrix's own citations, such as `MessagesPage.tsx:1576` for `usePins`. I did not verify those citations.

ESCALATE: no — both gates pass, and the open items are low-severity queue-hygiene and upstream-helper questions with no authority or fence issue.
