```
# Audit 2026-10-07

## Delta since last run
- new: none.
- fixed: none.
- still open: 5, all low, carried over.
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 20/38 · social: 18/38 · pipelines: 15/38. These are carried over from the 0246 report and not re-walked. I did not flip any cell.
- Both gates in `gates.log` pass: component-discipline and nav-parity.
- The 0246 report said no portal files changed. That was wrong. `changed-files.txt` has 717 entries, 396 of them under `portal/src`, because the tree is dirty and never committed. Most of the portal files are chat, deck and agent-loop components. I sampled only the raw-scan and signal hits, so portal files outside those hits are unaudited this run.
- The installed ui-components pin is `f03b2575…` (2.425.0).

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label transform in `style`. The code comment points at a queue row. | A library edge composite | upstream-needed (queue row) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` | upstream-needed (queue row) |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | A `Thumbnail` composite | upstream-needed (queue row) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | A local `parseDmLobby(name)` that shares its name with a library export but has a different signature. It uses its own tenant regex, then calls `dmLobbyMembers`. | Build it on the library's `parseDmLobby(lobby, { prefix })`, as `social-chat.ts` does, or rename it | likely yes; I did not re-read the dist signature |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127` | Raw `<p>` with `<strong>` inside `<Prose>` | Put the text and `<strong>` directly in `Prose` | yes |

- I read the code at #1, #4 and #5 this run and all three still exist as described.
- The runtime-colour inline styles (`Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109`, `ScorePanelNode.tsx:44`) stay tolerated as data-driven.
- `useNotifications` is mounted once, in `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- The 12 `EventSource` sites in `signals.txt` are non-chat feeds: canary, crawl, devbox tail, approvals, authz, local-compute, work events, assessment events and KB provisioning. None duplicates a gateway chat, presence or notification subscription.
- Raw tags: 100 across 66 of 422 files. The largest are `DimensionRow.tsx` (6), `TemplateHighlighted.tsx` (4), `DiffFrame.tsx` (4) and `UnavailableNotice.tsx` (3).
- `socialChat.ts:68` and `social-chat.ts:59` both build the DM prefix with the library's `dmLobbyPrefix`, so they are not local copies.

## Stale exemptions
- None found among the hits I checked.
- `docs/ui-components-queue.md` has 105 added and 21 removed lines in the working tree. It has 14 "Composed locally" rows. A path check found them all except one: `trafficFormat.ts` exists at `portal/src/pages/observability/trafficFormat.ts`. The other miss, "string", is only a parse artifact.
- I did not check whether any of those rows is now covered by a primitive in 2.425.0. That check is still owed.

## realtime-examples divergences
These are carried over; I did not re-verify them against realtime-examples files this run.
- Cursors are wired only on the assessment canvas. realtime-examples uses `hooks/useCursors.ts` on all its canvases.
- `rooms()` is not mounted on the gateway. realtime-examples has `/rooms` at `App.tsx:802-807`.
- `portal/src/lib/capabilities.tsx` mirrors Cedar actions instead of using `useCapabilities` or `useFeatureFlag`. That is legitimate local authority, but the generic read side could become a library wrapper.

ESCALATE: no — both gates pass and the five open findings are all low severity. The one caveat is that the 396 changed portal files are mostly unaudited beyond the raw-scan hits.
```
