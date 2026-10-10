# Audit 2026-10-06

## Delta since last run
- new: none in portal JSX. `raw-scan.txt` still reports 418 raw tags across 66 files, unchanged from the last run.
- fixed: none.
- still open: 4 low findings from last run, plus 2 stale-exemption candidates below.
- Gates: `validate-component-discipline.sh` and `validate-nav-parity.sh` both pass in `gates.log`.
- `useNotifications` is still mounted once, at `portal/src/components/shell/SharedNotifications.tsx:20`.
- The `EventSource` list in `signals.txt` is unchanged, with no new feeds.
- Parity cells were not re-verified. The changed set is about 676 files from an uncommitted tree, mostly middleware and tests. I did not re-walk the matrix, so I carried last run's tally forward unchanged.
- parity ❌/⚠️ remaining (last run's tally, unchanged) — orgiq: 20/38 · assessment: 21/38 · social: 18/38 · pipelines: 15/38

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label placement in `style` | A library edge composite | upstream-needed (queue 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` | upstream-needed. `Radio` is `undefined` in `/shared` at 2.422.0. |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | A `Thumbnail` composite | upstream-needed. `Thumbnail` and `Image` are `undefined` in `/shared`. |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Local `parseDmLobby` wrapper that regexes the tenant prefix, then calls the library's `dmLobbyMembers` | Library `parseDmLobby(lobby, {prefix})` | yes, in `realtime-modules/dist/call/lobbyChannel.d.ts:73`. It needs a known prefix and cannot discover the tenant from the name, so a thin wrapper is still defensible. |

The runtime-colour `style={{ color }}` uses on `Inline` (`Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109`) stay under the tolerance, covered by queue row 223.

The raw `EventSource` uses (canary, ingest, devbox tail, assessment events, local-compute and others) are non-gateway SSE feeds. I did not judge whether any should move to a realtime-modules channel.

## Stale exemptions
- Queue row 224 (`MasterDetail` has no docked pane footer): `paneFooter` now exists in the installed dist, on `ExplorerLayout` (`dist/index.d.ts:8755`). `portal/src/pages/projects/InitiativesExplorer.tsx:145` and `portal/src/pages/search/SearchPage.tsx:349` already use it. I did not confirm whether `MasterDetail` itself has the prop, so the assessment scorecard may be able to move to `ExplorerLayout`. Re-check this row.
- Queue row 53 (standalone `Radio`) and row 222 (`Thumbnail`) are still valid: neither export exists.
- The other 11 "Composed locally" rows (16, 17, 29, 32, 33, 36, 41, 80, 223, 274 and the rest) were not re-checked against the dist this run. The queue file has a large uncommitted diff, so this is still owed.

## realtime-examples divergences
I did not open realtime-examples this run, so I report no new divergences. The standing open items in `docs/audit-loop/realtime-parity.md` §4a still apply:
- huddle and page-sharing outside orgiq;
- cursors, rooms and recordings outside social;
- the social work graph;
- message edit/delete/forward, in-call reactions, transcription and the files panel.

ESCALATE: no — both gates pass and no portal JSX regressed. Two things need a human or a later run: the row 224 `paneFooter` question and the unchecked queue rows.
