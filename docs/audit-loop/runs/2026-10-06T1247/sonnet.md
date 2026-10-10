# Audit 2026-10-06

## Delta since last run
- new: none verified.
- fixed: the prior #1 (`portal tsc` failure at `SocialFooter.tsx:107`) is gone. `gates.log` now shows both gates passing, including the nav-parity "portal tsc" build step. The installed ui-components is 2.419.0, matching the pinned sha `ecbaaf49` in `portal/package.json` and `package-lock.json:1410`. `HuddleBarPhase` includes `'idle'` (`dist/video.d.ts:1635`). The earlier failure was a stale `node_modules`/pin mismatch.
- still open: 1. It is the `DM_PREFIX` / `SOCIAL_DM_PREFIX` slicing (#1 below).
- parity ❌/⚠️ remaining, carried forward from `realtime-parity.md` §4 (I re-verified no cells, and the touched files are not in the matrix): orgiq 13/25 (8⚠️, 5❌) · assessment 10/25 (5⚠️, 5❌) · social 8/25 (6⚠️, 2❌) · pipelines 11/25 (8⚠️, 3❌).
  - The tally section counts the ❌ and ⚠️ cells but does not break out "n/n" per tenant, so I added them together.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/pages/social/socialChat.ts:68`, `middleware/src/lib/social-chat.ts:58` | A DM prefix is derived by slicing `dmLobbyName(['a','b'], {prefix:'social:'})`. Only the parse helpers use it. | Ask the library to export a DM-prefix helper, or leave it. | upstream-needed |
| 2 | low | `portal/src/components/shell/SocialFooter.tsx` | Not a finding. It composes the library's `HuddleBar` with no inline styles (0 `style={{` matches). | None | yes |

The data-driven inline styles from the raw scan (`KBHealthBadge.tsx:85,87`, `ScorePanelNode.tsx:44`, `VersionPickerStep.tsx:63,70`, `scores/Leaderboard.tsx:86`, `scores/CompareDeltaTable.tsx:37,66`, `scores/PersonDetailCard.tsx:109`) are all runtime colours. I did not check whether each has a queue row. The queue rows I did see ("Composed locally") cover `WeightedEdge` (line 221) and `Thumbnail` (line 222).

Realtime checks, all verified by grep:
- `useNotifications(` has one non-test caller, `SharedNotifications.tsx:20`. `ActivityBell.tsx` only mentions it in a comment, so there is no duplicate mount.
- `new WebSocket` has no matches in `portal/src`.
- The 11 `EventSource` uses are BFF SSE endpoints, unchanged from the last run (the list is in `raw-scan.txt`). `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` are the likeliest candidates for a gateway channel, but I did not verify that.

## Stale exemptions
- None confirmed. I did not check the installed dist against the queue rows for `DiffFrame`, `UnavailableNotice`, `DimensionRow`, `TemplateHighlighted` or the CSS-Grid row (queue lines 29–53).
- Queue line 36 (CSS-Grid primitive): `Grid` appears in `dist/shared.d.ts`. I did not confirm that it handles a fixed label column with `repeat(N, minmax)` tracks. A person should check this row first.

## realtime-examples divergences
- None compared this run. I did not read any realtime-examples files, so I cannot name a file:line for the social, huddle, DM, documents or notification surfaces.
- `docs/audit-loop/realtime-parity.md` still marks many cells "code-only" or "no browser pass". This audit does not confirm them.

Coverage is thin. `raw-scan.txt` reports 100 raw tags in 66 files out of 410 scanned. I did not walk the 613 files in `changed-files.txt` brace-aware. The top raw-tag files, such as `DimensionRow.tsx` (6) and `DiffFrame.tsx` (4), are covered by existing queue rows as far as I know, but I did not check.

ESCALATE: no — both gates pass, and the only open item is the low-severity DM-prefix helper, which needs an upstream decision rather than judgment now.
