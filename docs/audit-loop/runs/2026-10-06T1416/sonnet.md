# Audit 2026-10-06

## Delta since last run
- new: none.
- fixed: last run's #1 (`Leaderboard.tsx:86`). Queue row `docs/ui-components-queue.md:223` now names `Leaderboard.tsx` in its "Composed locally" list. Last run's #2 (`KBHealthBadge.tsx`) is also fixed. `KBHealthBadge.tsx:75-83` now uses the library `StatusPill` with a `tone`, and the file has no `style={{` left.
- still open: 1. It is the `DM_PREFIX` derivation (finding #1).
- Both gates pass (`gates.log`). `useNotifications` still has one non-test caller, `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- parity ❌/⚠️ remaining, from the matrix §4 tally (`docs/audit-loop/realtime-parity.md:76-79`), not re-verified cell by cell. orgiq: 20/38 · assessment: 23/38 · social: 19/38 · pipelines: 18/38. These match last run. The tally table is the only place I checked them.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/pages/social/socialChat.ts:68`, `middleware/src/lib/social-chat.ts:58` | `DM_PREFIX` / `SOCIAL_DM_PREFIX` are built with `dmLobbyPrefix({ prefix: 'social:' })`. The local `dmMembers` helpers (`socialChat.ts:76`, `social-chat.ts:88`) and `parseDmLobby` (`social-notify.ts:365`) also parse DM names locally. | Use a library DM-parse helper if one exists. Otherwise accept this as tenant-specific naming. | upstream-needed (I did not re-check the dist this run) |
| 2 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | `style={{` for a data-driven stroke width and label position. | An `@xyflow/react` helper. | upstream-needed. The queue row at `ui-components-queue.md:221-222` covers it. |

Raw `style={{` hits in `raw-scan` and `signals.txt`: `ScorePanelNode`, `CompareDeltaTable`, `PersonDetailCard` and `Leaderboard` all use a runtime colour and are covered by row 223. `Thumbnail.tsx:42,57` is covered by its own queue row. `VersionPickerStep.tsx:63,70` sets a runtime `borderLeftColor` / `accentColor` that I did not match to a queue row. I did not read those lines in context, so I am not claiming it as a finding.

The 11 `EventSource` uses are all BFF SSE endpoints and match last run. `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` are the candidates for a gateway `activity()` subscription (the assessment activity cell stays open in the matrix). I did not verify either.

I did not walk the 66 files in `raw-scan` brace-aware. The gate budgets pass.

## Stale exemptions
- None found. `WeightedEdge.tsx` still has live inline styles, so its exemption is still valid.
- I did not check the `DiffFrame`, `UnavailableNotice`, `DimensionRow` and `TemplateHighlighted` rows or the Radio row against the dist. `UnavailableNotice.tsx` is in the changed files, so re-check it next run.

## realtime-examples divergences
I did not re-read realtime-examples this run. The changed files are mostly the gateway, chat and shell files the matrix already covers. I did not verify the matrix's citations (for example `MessagesPage.tsx:1576` for `usePins`).

ESCALATE: no — both gates pass and the one open finding is a low-severity upstream-helper question with no authority or fence issue.
