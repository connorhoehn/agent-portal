# Audit 2026-10-07

## Delta since last run
- new: none.
- fixed: none. The 0417 findings #1, #4 and #5 still exist as described. Findings #2 and #3 were not re-read, so I'm carrying them over from the 0417 report.
- still open: 5, all low.
- parity ❌/⚠️ remaining, from the tally in `realtime-parity.md` §4 (not re-walked, no cells flipped) — orgiq: 20/38 · assessment: 21/38 · social: 17/38 · pipelines: 15/38.
  - The 0417 report carried assessment 20 and social 18. Reading §4 now, assessment is 8⚠️+13❌ and social is 9⚠️+8❌. That is a correction to the carried numbers, not a change in the code.
- Both gates in `gates.log` pass: component-discipline and nav-parity.
- The installed ui-components is now 2.426.0. The 0417 report said 2.425.0, so the dist moved. Library facts below are checked against this version.
- The tree is still uncommitted. `changed-files.txt` lists 720 files, 399 of them under `portal/src`. I only audited files with raw-scan or signal hits, so the rest of the changed portal files are unaudited.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label transform in `style`. It is listed in the signals scan; not re-read this run. | A library edge composite (the queue row already covers it) | upstream-needed |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Runtime `borderLeftColor` and `accentColor` on a bare radio. In the signals scan; not re-read. | A standalone `Radio` | upstream-needed |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame. In the signals scan; not re-read. | A `Thumbnail` composite | upstream-needed |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | A local `parseDmLobby(name)` with the same name as the library export but a different signature. It uses its own tenant regex (`^([a-z][a-z0-9-]*):dm:`), then calls `dmLobbyMembers`. `realtime-gateway.ts:96` imports this local one, and `:443` and `:725` call it. | Build it on the library's `parseDmLobby(lobby, { prefix })`, as `social-chat.ts:90,101` does, or rename it | yes. The installed `dist/call/index.d.ts:6` exports `parseDmLobby`. |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127` | Raw `<p>` and `<strong>` inside `<Prose>` | Put the text and `<strong>` directly in `Prose` | yes |

- Runtime-colour inline styles stay tolerated as data-driven: `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109` and `ScorePanelNode.tsx:44`.
- `useNotifications` is mounted once, in `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- The 11 `EventSource` sites in `signals.txt` are canary, crawl, devbox tail, work events, assessment events, KB provisioning, authz, approvals, local-compute and data sources. None duplicates a gateway chat, presence or notification subscription.
- There is no raw `WebSocket`.
- Raw tags: 100 across 66 of 423 files, unchanged from the last run. The largest are `DimensionRow.tsx` (6), `TemplateHighlighted.tsx` (4), `DiffFrame.tsx` (4) and `UnavailableNotice.tsx` (3). `validate-component-discipline.sh` reports them at or under budget.
- `socialChat.ts:68` and `social-chat.ts:59` both build the DM prefix with the library's `dmLobbyPrefix`, so they are not local copies.

## Stale exemptions
- None found among the hits I checked.
- `docs/ui-components-queue.md` has 14 "Composed locally" rows.
- I have not checked whether 2.426.0 now covers any of them. That check is still owed for the third run in a row.
  - Rows to check first: the canary edge, version-picker radio and ingest thumbnail rows, which match findings #1–#3.

## realtime-examples divergences
These are carried over. I did not re-verify them against `realtime-examples` file:line this run.
- Cursors are wired only on the assessment canvas. `realtime-parity.md` marks orgiq, social and pipelines as open. `realtime-examples` uses `hooks/useCursors.ts` on its canvases.
- `rooms()` is not mounted on the gateway. `realtime-examples` has `/rooms` at `App.tsx:802-807`.
- Typing indicators: CLAUDE.md says typing and presence are in all four tenants. The parity doc's own header notes (written earlier) say typing was downgraded to ❌ in three tenants. I did not check which is current. Someone should reconcile the typing rows in `realtime-parity.md` with CLAUDE.md.
- `portal/src/lib/capabilities.tsx` mirrors Cedar actions rather than using `useCapabilities` or `useFeatureFlag`. That is legitimate local authority, but the generic read side could become a library wrapper.

ESCALATE: no — both gates pass, all five open findings are low severity, and nothing is new. The caveat is that most of the 399 changed portal files are unaudited.
