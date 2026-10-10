Cursor is now mounted on the gateway and used by the assessment document canvas, so one parity cell has changed. Here is the report.

# Audit 2026-10-06
## Delta since last run
- new: the BFF now mounts the library's `cursor()` (`middleware/src/lib/gateway-cursor.ts`, mounted at `realtime-gateway.ts:958`). The assessment document canvas uses it through `useCursor` and `WrappedCursorOverlay` (`portal/src/pages/assessment/knowledge/CanvasDocumentPane.tsx:5,115,346`).
- fixed: nothing else. Raw-scan and signals are byte-identical to the 2316 run, and both gates pass in `gates.log`.
- still open: 5 low findings, the same as last run.
- `useNotifications` is still mounted once, in `SharedNotifications.tsx:20`.
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 20/38 (was 21; Cursors flips from ❌ to ✅ once the matrix is updated) · social: 18/38 · pipelines: 15/38. The other counts are carried forward, not re-walked.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label placement in `style` | A library edge composite | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` | upstream-needed (queue row 53) |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | A `Thumbnail` composite | upstream-needed (queue row 222) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Local `parseDmLobby` wrapper that parses the tenant prefix itself | The library's `parseDmLobby` | yes, but the library version can't discover the tenant, so the wrapper is defensible |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127` | Raw `<p>` inside `<Prose size="sm">` | Plain text in `Prose` | yes |

The runtime-colour `style={{ color }}` uses (`Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109`, `ScorePanelNode.tsx:44`) are still tolerated as data-driven.

I read `SummarizableChatPanel.tsx` and `CanvasDocumentPane.tsx`, which changed since the last run, only for raw `style`, `<div>`, `<span>` and `<svg>` tags, and found none.

The 12 raw `EventSource` sites are unchanged. They are canary, crawl, devbox tail, approvals, authz log, local compute and similar non-chat feeds, not duplicates of the gateway's chat, presence or notification subscriptions.

## Stale exemptions
- `docs/audit-loop/realtime-parity.md` is stale for cursors. Line 22 says `cursor` is "not mounted". Line 47 shows Cursors ❌ in every tenant. Lines 88 and 102 list the mount as a gap. All four should now read "mounted; used on the assessment document canvas".
- Queue rows 53 and 222 are still valid.
- I did not re-check the other "Composed locally" rows against the 2.423.0 dist. The queue file was last modified at 20:48.

## realtime-examples divergences
- Cursors: the matrix says realtime-examples uses `useCursors` (`hooks/useCursors.ts`) only in its cursor demos, not on the document canvas. aws-agentcore wiring it onto the assessment canvas goes beyond the reference, so it needs no change.
- `tenantCursor()` rebuilds the cursor frame's metadata on the server (name, initials, colour from the user id). That duplicates what realtime-examples' server at `src/server.ts:1256` leaves to the client, so it is probably worth proposing upstream as a `cursor({ resolveIdentity })` option. I did not open realtime-examples this run to confirm.
- The standing gaps in `realtime-parity.md` still apply, apart from the cursor server mount. Cursor client wiring remains open in orgiq, social and pipelines. Rooms are still not mounted. Recordings and knock exist only in social. The orgiq and pipelines CRDT cells are missing. Screen share is partial outside pipelines.

For the next run: re-walk the huddles-on-run/document-pages cells against realtime-modules 0.113.0.

ESCALATE: yes — the new `cursor({ authorizeChannel: () => true })` in `gateway-cursor.ts` relies entirely on the router's channel authority, and I did not probe it. A live probe should confirm a cross-tenant `cursor:` subscribe answers `AUTHZ_CHANNEL_DENIED`.
