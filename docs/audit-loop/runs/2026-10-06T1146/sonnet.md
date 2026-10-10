# Audit 2026-10-06

## Delta since last run
- new: none confirmed. I sampled and did not do a full brace-aware walk of the 601 changed files.
- fixed: 5 of the 6 earlier findings, or most of them.
  - #1 `stripServicePrefix` (`middleware/src/lib/realtime-gateway.ts:314`) is now an alias of the library's `baseChannel`. The comment at `:300-313` records that the narrower rule fails closed.
  - #2 `dmChannelFor` (`middleware/src/lib/social-chat.ts:82-83`) now calls `dmLobbyName`.
  - #2 `dmMembers` in `portal/src/pages/social/socialChat.ts:75-78` now calls `dmLobbyMembers`.
  - #3 `parseDmLobby` (`middleware/src/lib/social-notify.ts:365-370`) now uses `dmLobbyMembers`. Only the tenant regex remains local.
  - #4 `ToolWaterfall.tsx` has no `style={{` left.
  - The `SkillFilter.tsx` exemption looks correct: the file has 0 raw `<input|div|span` tags, so last run's comment false positive is gone or resolved.
- still open: 2 (#5, #6 below), plus the leftover prefix constants.
- parity ❌/⚠️ remaining, counted from the 2026-10-05 matrix tally. I did not re-verify cells and flipped none, so treat the counts as unchanged.
  - orgiq: 5/8
  - assessment: 5/5
  - social: 2/6
  - pipelines: 3/8

Gates: `validate-component-discipline.sh` and `validate-nav-parity.sh` both pass (`gates.log`).

## Findings
| # | sev | file:line | what is hand-rolled | replace with | in installed dist? |
|---|---|---|---|---|---|
| 5 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:55,68` | Inline styles with no queue row. They may be xyflow geometry, which is data-driven. | A queue row, or confirm it is geometry | n/a |
| 6 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Inline `width`/`height` with no queue row | A queue row | no |
| 7 | low | `portal/src/pages/social/socialChat.ts:67`, `middleware/src/lib/social-chat.ts:57` | `DM_PREFIX` / `SOCIAL_DM_PREFIX = 'social:dm:'` are local literals. They are now only used with the library parse helpers. | Derive the prefix from `dmLobbyName([], { prefix: 'social:' })`, or leave it. | partly |

Inline styles in `KBHealthBadge`, `scores/*`, `ScorePanelNode` and `VersionPickerStep` are data-driven colours. `ScorePanelNode` (`:44`) is the only one I did not check for a queue row. `raw-scan.txt` shows 66 files with 100 raw tags, mostly `span`/`div`. I did not walk them brace-aware.

Realtime checks:
- `useNotifications` is mounted once, in `SharedNotifications.tsx:20`. `ActivityBell` only consumes it.
- All 11 raw `EventSource` uses are BFF SSE streams, not gateway sockets. No raw `WebSocket` appears in the scan.
- `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` are still the likeliest candidates to move onto a gateway channel. I did not verify that.

## Stale exemptions
- None confirmed.
- I did not check whether the installed dist now ships the primitives behind the `DiffFrame`, `UnavailableNotice`, `DimensionRow` and `TemplateHighlighted` rows.
- Queue line 81 (the ghost-Button row) still lists SkillFilter among the `h-auto`/`p-0` overrides. That is harmless, but the row text is out of date.

## realtime-examples divergences
- The notification context still mirrors `realtime-examples/frontend/src/contexts/NotificationsContext.tsx`. The local `tell` mark-read relay is an upstream candidate.
- I did not compare the social, huddle, DM, documents and notification surfaces file by file this run.
- `realtime-parity.md` is dated 2026-10-05 and was edited on 2026-10-06. Many of its ✅ cells say "code-only" or "no browser pass". The audit cannot confirm those.

ESCALATE: no — the earlier prefix-stripping question is settled by the `baseChannel` swap, and both gates pass.
