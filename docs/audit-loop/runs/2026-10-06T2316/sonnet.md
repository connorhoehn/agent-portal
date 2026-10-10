# Audit 2026-10-06

## Delta since last run
- new: nothing. The raw-scan and signals outputs are byte-identical to the 2246 run, and both gates pass (`gates.log`).
- fixed: the garbled version header in `docs/audit-loop/realtime-parity.md:3`. It now reads "ui-components 2.423.0 (`c4cd04e9…`)".
- still open: 5 low findings, the same as last run.
- `useNotifications` is still mounted once, in `SharedNotifications.tsx:20`. The only other mention is a comment in `ActivityBell.tsx:3`.
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 21/38 · social: 18/38 · pipelines: 15/38. I carried these forward and did not re-walk them. `realtime-parity.md` was last edited at 22:47, after the previous run, so some cells may already have moved.
- The changed set is the same large dirty tree as before: about 698 files, mostly middleware gateway, work-graph, deck-shared, social and mock code, plus portal chat components. I sampled the files behind the raw-scan and signals output, not the whole set.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label placement in `style` | A library edge composite | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` | no, upstream-needed (queue row 53, per last run's dist check) |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | A `Thumbnail` composite | no, upstream-needed (queue row 222, per last run's dist check) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Local `parseDmLobby` wrapper that parses the tenant prefix itself | The library's `parseDmLobby` | yes, but the library version can't discover the tenant, so the wrapper is defensible |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127` | Raw `<p>` inside `<Prose size="sm">` | Plain text in `Prose` | yes |

`WeightedEdge.tsx` is in this run's changed files, but its `style` sites at lines 57 and 70 are unchanged. The runtime-colour `style={{ color }}` uses in `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109` and `ScorePanelNode.tsx:44` are still tolerated as data-driven.

The 12 raw `EventSource` sites in `signals.txt` are unchanged. They are mostly non-chat feeds: canary, crawl, devbox tail, approvals, authz log and local compute. They are not duplicates of the gateway's chat, presence or notification subscriptions.

## Stale exemptions
- Queue rows 53 (`Radio`) and 222 (`Thumbnail`) are still valid.
- I did not re-check the other "Composed locally" rows against the 2.423.0 dist. `docs/ui-components-queue.md` was last modified at 20:48, before the previous run, so I have nothing new to compare.

## realtime-examples divergences
I did not open realtime-examples this run, so I report no new ones. The standing gaps in `realtime-parity.md` still apply:
- Cursors are not mounted. `cursor()` and `rooms()` exist in the installed dist but the gateway doesn't mount them.
- Hangout rooms and recordings are missing outside social.
- The orgiq and pipelines CRDT cells are missing.
- Knock/lobby is partial in social.
- Screen share is partial outside pipelines.

For the next run: re-walk the huddles-on-run/document-pages cells against realtime-modules 0.113.0, because its `join` verb and lobby page-huddle adoption may flip them. `run.sh` should also keep the previous `raw-scan.txt` so a raw-tag change can be attributed to a file.

ESCALATE: no — both gates pass, nothing new surfaced, and the only open items are low-severity queue-covered upstream gaps.
