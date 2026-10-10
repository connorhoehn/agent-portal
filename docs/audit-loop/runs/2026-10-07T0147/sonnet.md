# Audit 2026-10-07

## Delta since last run
- new: none. `raw-scan.txt`, `signals.txt` and `changed-files.txt` are byte-identical to the 0116 run (checked with `diff`).
- fixed: the stale matrix header from last run. `realtime-parity.md:3` now says realtime-modules 0.114.0 and ui-components 2.425.0. That matches the installed `package.json` files in `portal/node_modules` and `middleware/node_modules`.
- still open: 5 (all low, carried over).
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 20/38 · social: 18/38 · pipelines: 15/38. These are carried forward, not re-walked, because no changed file touches a cell since the last run.
- Both gates in `gates.log` pass: component-discipline and nav-parity.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label placement in `style` | A library edge composite | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` | upstream-needed (queue row 53) |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | A `Thumbnail` composite | upstream-needed (queue row 222) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | A local `parseDmLobby(name)` that shares a name with the library export but has a different signature. It finds the tenant itself with a regex, then calls `dmLobbyMembers`. | Build it on the library's `parseDmLobby(lobby, { prefix })`, as `social-chat.ts:90,101` does, or rename it | yes. I read the local function this run. I did not re-read the library signature. |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127` | Raw `<p>` wrapping `<strong>` inside `<Prose>` | Put the text and `<strong>` directly in `Prose` | yes. I read the lines this run. |

- Runtime-colour `style={{ color }}` uses remain tolerated as data-driven: `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109` and `ScorePanelNode.tsx:44`.
- `useNotifications` is mounted once, in `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- The 12 `EventSource` sites in `signals.txt` are non-chat feeds (canary, crawl, devbox tail, approvals, authz, local-compute, work events, assessment events, KB provisioning). None duplicates a gateway chat, presence or notification subscription.
- The largest raw-tag files are unchanged: `DimensionRow.tsx` (6), `TemplateHighlighted.tsx` (4), `DiffFrame.tsx` (4) and `UnavailableNotice.tsx` (3). The gate passes on its budget.

## Stale exemptions
None found. Queue rows 53, 221 and 222 still match raw-scan hits. I did not re-check the other "Composed locally" rows against ui-components 2.425.0. That check is still owed, since `docs/ui-components-queue.md` is in the dirty tree.

## realtime-examples divergences
Carried over; I did not re-verify these against the realtime-examples files this run.
- Cursors are wired only on the assessment canvas. realtime-examples uses `hooks/useCursors.ts` on all its canvases.
- `rooms()` is not mounted on the gateway. realtime-examples has `/rooms` at `App.tsx:802-807`.
- `lib/capabilities.tsx` mirrors Cedar actions instead of using `useCapabilities` or `useFeatureFlag`. This is legitimate local authority, but the generic read side could become a library wrapper.

ESCALATE: no — both gates pass, the inputs are identical to the last run, and there is nothing new.
