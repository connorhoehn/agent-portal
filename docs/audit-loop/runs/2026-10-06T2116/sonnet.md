# Audit 2026-10-06

## Delta since last run
- new: raw tag count went 418 → 419 (`raw-scan.txt:1`). Only the total line changed, so I could not tell which file gained the tag. The top-files table is identical to the last run's. The per-file table is truncated, so a file below the cutoff may have gained it.
- new: `portal/package.json` now pins ui-components `c4cd04e9…` (installed 2.423.0). `CLAUDE.md` still says 2.422.0 `922b05b9…`. The pin moved and the doc did not.
- fixed: none.
- still open: 4 low findings from last run.
- Gates: both `validate-component-discipline.sh` and `validate-nav-parity.sh` pass (`gates.log`).
- `useNotifications` is still mounted once, at `SharedNotifications.tsx:20`.
- The `EventSource` list in `signals.txt` has the same 12 sites as last run.
- The static inline styles in `signals.txt` are also unchanged. All of them are data-driven runtime values (colour, width, `accentColor`).
- parity ❌/⚠️ remaining, last run's tally carried forward — orgiq: 20/38 · assessment: 21/38 · social: 18/38 · pipelines: 15/38. The changed set has 379 `portal/src` files. I did not re-walk the matrix.
- `realtime-parity.md:3` records installed versions as realtime-modules 0.108.0 and ui-components 2.419.0. The installed packages are now 0.112.0 and 2.423.0, so that header is stale.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label placement in `style`. This file has a 5-line uncommitted diff. | A library edge composite | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` | upstream-needed. Last run found `Radio` undefined in `/shared` at 2.422.0; I did not re-check at 2.423.0. |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | A `Thumbnail` composite | upstream-needed. Same: not re-checked at 2.423.0. |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | A local `parseDmLobby` wrapper that parses the tenant prefix itself | Library `parseDmLobby(lobby, {prefix})` | yes, but it needs a known prefix and cannot discover the tenant. A thin wrapper is still defensible. |

- `portal/src/pages/social/socialChat.ts:76` and `middleware/src/lib/social-chat.ts:88` each define a local `dmMembers` next to the library's `dmLobbyPrefix`. I did not check whether the library exports an equivalent. Worth a look next run.
- The raw `EventSource` feeds are SSE, not gateway channels. I did not judge whether any should move to realtime-modules.

## Stale exemptions
- Queue row 224 (`MasterDetail` has no `paneFooter`) is not stale. I checked the installed dist. `ExplorerLayout` has `paneFooter` (`index.d.ts:8773`), but `MasterDetail`'s props (`index.d.ts:12283`) do not. Last run's suggestion of moving the scorecard to `ExplorerLayout` is still open as a design choice, not a stale row.
- The other "Composed locally" rows (16, 17, 21, 221, 222, 223 and more) were not re-checked against 2.423.0, as last run. The 2.422 → 2.423 bump makes that check more worthwhile.

## realtime-examples divergences
I did not open realtime-examples this run, so I report no new ones. The standing gaps in `realtime-parity.md` still apply:
- Cursors are ❌ in all four tenants. The gateway does not mount `cursor()`.
- Hangout rooms and recordings are ❌ outside social.
- Knock/lobby is ⚠️ in social, with no portal code.
- The orgiq CRDT cell is ❌, and the pipelines CRDT cell is ❌.
- Screen share is ⚠️ in orgiq, assessment and social. The footer `HuddleBar` has only mic and camera.

ESCALATE: no — both gates pass and no new raw JSX or style findings are confirmed. For a human or the next run: locate the 419th raw tag, refresh the stale version header in `realtime-parity.md` and the `CLAUDE.md` pin, and re-check the queue rows against 2.423.0.
