# Audit 2026-10-05

## Delta since last run
- new: all findings below (first run, no baseline)
- fixed: none
- still open: 6 findings, 1 stale-exemption cleanup

Gates: `validate-component-discipline.sh` and `validate-nav-parity.sh` both pass (`gates.log`). I audited by sampling. I did not do a full brace-aware walk of all 90 raw-tag files.

## Findings
| # | sev | file:line | what is hand-rolled | replace with | in installed dist? |
|---|---|---|---|---|---|
| 1 | med | `middleware/src/lib/realtime-gateway.ts:249-252` | `SERVICE_PREFIX` regex and `stripServicePrefix` duplicate the library's `splitServiceChannel`. The local regex also strips `chat\|typing\|activity\|pins`, which the library says pass through unchanged. | `splitServiceChannel(name).channel` from `realtime-modules/server`, or upstream the extra prefixes if they are real | yes (`server/index.d.ts:28`); extra prefixes are upstream-needed |
| 2 | low | `middleware/src/lib/social-chat.ts:55,80,88` and `portal/src/pages/social/socialChat.ts:65,73` | Local `social:dm:` prefix and `dmMembers` parsing. The sorted, deduped `dmChannelFor` is a second implementation of `dmLobbyName`. | `dmLobbyName(ids, { prefix: 'social:' })`, which `searchMessageModel.ts:40` and `peopleCall.tsx:74` already use. Member parsing has no library helper. | partly: `dmLobbyName` yes, parse helper upstream-needed |
| 3 | low | `middleware/src/lib/social-notify.ts:360` | `parseDmLobby` is a regex that parses the same lobby names | a library parser, if one exists | no, upstream-needed |
| 4 | low | `portal/src/components/observability/ToolWaterfall.tsx:161,174` | Inline `left`/`width` percentages with no queue row | a waterfall or gantt bar primitive, or a queue row | no |
| 5 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:55,69` | Inline style with no queue row. It may be xyflow geometry, which is data-driven. | queue row | n/a |
| 6 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` and `ingest/SiteSurveyPanel.tsx:369` | Inline `width`/`height` and a depth-based `paddingLeft` with no queue row. `SiteSurveyPanel` has one row, but I did not check what it covers. | queue row, or a `Tree`/indent prop | no |

Static inline styles that are data-driven and already carry a queue row: `KBHealthBadge.tsx:85` has a row. The `scores/*` department-colour styles are covered by the `CohortCard` and `HistogramBar` rows, queue lines 45-46. The `VersionPickerStep.tsx:63,70` radio accent colour is covered by queue line 56.

Every `EventSource` in `raw-scan.txt` is a BFF SSE stream, not a gateway socket, so none duplicates `useChat`/`usePresence`. I did not check the 11 call sites one by one. `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` are the likeliest candidates to move onto a gateway channel. I did not verify that.

`useNotifications()` is mounted once, in `SharedNotificationsProvider` (`SharedNotifications.tsx:20`). `ActivityBell`, `EmbeddedSocial` and `SocialChatWorkspace` consume the shared context. There are no duplicate mounts, and no raw `new WebSocket`.

## Stale exemptions
- `components/scores/SkillFilter.tsx`: the queue (lines 38 and 47) says "exemption retired: no raw elements remain". But `raw-scan.txt` counts 8 raw tags there (5 `input`, 2 `div`, 1 `span`). The grep hits I saw are all inside comments (`SkillFilter.tsx:118-130`), so this is probably a scanner false positive on comment text, and the retirement looks right. No anchored JSX `<input|div|span` line turned up, but I did not read the whole file. The scanner should skip comments.
- Not verified: the `DiffFrame.tsx`, `UnavailableNotice.tsx`, `DimensionRow.tsx` and `TemplateHighlighted.tsx` rows. I confirmed these files still contain raw `div`/`span`, so the rows are not stale on that count. I did not check whether the installed dist has since gained the primitives (a line-list diff, `FailedRead`, `Histogram`, or `WorkflowStepper` dots).

## realtime-examples divergences
- Notifications: `SharedNotifications.tsx:1-4` states it mirrors `realtime-examples/frontend/src/contexts/NotificationsContext.tsx`. No divergence. The local mark-read relay (`tell`, line 24) is a generic plumbing candidate for upstream: it is a `markRead` frame the hook should send itself.
- Social, huddle, DM and documents surfaces: I did not compare these file by file against realtime-examples (for example `MessagesPage`). Findings 1-3 are the divergences I confirmed. The tenant-prefix, epoch and directory checks around them are legitimately local.

ESCALATE: yes — finding 1: the local regex strips `chat|typing|activity|pins` but the library's `splitServiceChannel` does not. Swapping it could change which channels `authorizeLiveGatewayChannel` checks, so someone needs to decide that, or an upstream change. Also, the scanner's comment false positive needs a second opinion.
