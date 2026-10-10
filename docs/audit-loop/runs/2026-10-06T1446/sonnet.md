# Audit 2026-10-06

## Delta since last run
- new: none.
- fixed: last run's finding #1 is largely resolved. The local DM helpers wrap library functions and don't reimplement them. `socialChat.ts:76-80` calls the library's `parseDmLobby(lobby, { prefix: 'social:' })`. `social-notify.ts:365-370` calls `dmLobbyMembers`, and its regex only splits the tenant prefix. Both are thin tenant adapters, so I downgraded this to informational.
- still open: 1. `WeightedEdge.tsx` still has 2 inline `style={{` uses, which is finding #1 below.
- Both gates pass: `validate-component-discipline.sh` and `validate-nav-parity.sh` (`gates.log`).
- `useNotifications(` still has one non-test mount, `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment, so there is no duplicate mount.
- parity ❌/⚠️ remaining, from the §4 tally (`docs/audit-loop/realtime-parity.md:72-77`), not re-verified cell by cell. The tally was recomputed on 2026-10-06 and its columns sum to 38.
  - orgiq: 20/38
  - assessment: 23/38
  - social: 19/38
  - pipelines: 18/38 (7 of those rows are "—")

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx` (2 inline `style={{`, see `raw-scan.txt`) | Per-render stroke width and label transform. | A library weighted-edge or edge-label composite. | upstream-needed. Queue row `ui-components-queue.md:221` covers it. The file is in changed-files and its static stroke colour is now the `.canary-weighted-edge` class. |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | The row has a runtime `borderLeftColor`. The bare `<input type="radio">` has a runtime `accentColor`. | A standalone `Radio`, or a rich-row `RadioGroup`. | upstream-needed. Queue row `ui-components-queue.md:53` ("Composed locally in `VersionPickerStep.tsx`") covers the radio and its `accentColor`. |

Last run's data-driven-colour hits (`ScorePanelNode`, `CompareDeltaTable`, `PersonDetailCard`, `Leaderboard`) are still covered by queue row `ui-components-queue.md:223`. They use runtime colours only, and the text goes through `Inline`.

I didn't walk the 66 files in `raw-scan.txt` brace-aware. The gate budgets pass.

The `raw-scan.txt` list of `EventSource` uses is unchanged from last run: 11 BFF SSE endpoints. `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` remain the candidates for a gateway `activity()` subscription. I didn't verify either this run.

## Stale exemptions
- None found.
- `WeightedEdge.tsx` still has live inline styles, so its row at `ui-components-queue.md:221` stays valid.
- `UnavailableNotice.tsx` has live raw `div`s (3 in `raw-scan.txt`) and uncommitted changes (32 lines added). Its row at `ui-components-queue.md:41` ("Composed locally in `UnavailableNotice.tsx`") is still valid. I didn't check the library dist for a `FailedRead`-style composite.
- I didn't re-check the `DiffFrame`, `DimensionRow` and `TemplateHighlighted` rows against the dist.

## realtime-examples divergences
- I didn't re-read realtime-examples this run, and I didn't verify the matrix's citations.
- The changed files are mostly chat, deck, gateway and compute files already covered by the matrix.
- The matrix itself flags typing as ❌ in assessment, social and pipelines: nothing outside the huddle chat passes `presence`/`typingUsers` or calls `setTyping`. This is the largest known gap, and nothing changed it this run.

ESCALATE: no — both gates pass, and the open findings are low-severity upstream-library gaps already covered by queue rows, with no authority or fence question.
