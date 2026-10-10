# Audit 2026-10-07

## Delta since last run
- new: none found. I could not diff the inputs against the 0147 run, because that directory holds only `sonnet.md`. The raw-scan and signals output I read matches what the 0147 report describes.
- fixed: none.
- still open: 5, all low, carried over.
- parity ❌/⚠️ remaining (carried from the 0147 report, not re-walked) — orgiq: 20/38 · assessment: 20/38 · social: 18/38 · pipelines: 15/38
- Both gates in `gates.log` pass: component-discipline and nav-parity.
- `changed-files.txt` lists mostly middleware realtime-gateway tests, plus `config.ts`, `index.ts` and `docs/ui-components-queue.md`. None of them touches a portal page, so I did not flip any parity cell.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label placement in `style` | A library edge composite | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` | upstream-needed (queue row 53) |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | A `Thumbnail` composite | upstream-needed (queue row 222) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | A local `parseDmLobby(name)` with the same name as the library export but a different signature. It matches the tenant with its own regex, then calls `dmLobbyMembers`. | Build it on the library's `parseDmLobby(lobby, { prefix })`, as `social-chat.ts` does, or rename it | yes by the 0147 report; I did not re-read the library signature |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127` | Raw `<p>` wrapping `<strong>` inside `<Prose>` | Put the text and `<strong>` directly in `Prose` | yes. I read the lines this run. |

- I read the local function (#4) and the `<p>` (#5) this run and both still exist as described.
- The runtime-colour `style={{ color }}` uses at `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109` and `ScorePanelNode.tsx:44` stay tolerated as data-driven.
- `useNotifications` is mounted once, in `SharedNotifications.tsx:20`. `ActivityBell.tsx:3` only mentions it in a comment.
- The 12 `EventSource` sites in `signals.txt` are non-chat feeds (canary, crawl, devbox tail, approvals, authz, local-compute, work events, assessment events, KB provisioning). None duplicates a gateway chat, presence or notification subscription.
- Raw-tag totals are 100 tags in 66 of 422 files. The largest are `DimensionRow.tsx` (6), `TemplateHighlighted.tsx` (4), `DiffFrame.tsx` (4) and `UnavailableNotice.tsx` (3). The gate passes on its budget.

## Stale exemptions
- None found. Queue rows 53, 221 and 222 still match raw-scan hits.
- `docs/ui-components-queue.md` has about 105 added and 21 removed lines in the working tree (`git diff --stat`). I did not check the new "Composed locally" rows against ui-components 2.425.0, so that check is still owed.

## realtime-examples divergences
These are carried over. I did not re-verify them against realtime-examples files this run.
- Cursors are wired only on the assessment canvas. realtime-examples uses `hooks/useCursors.ts` on all its canvases.
- `rooms()` is not mounted on the gateway. realtime-examples has `/rooms` at `App.tsx:802-807`.
- `lib/capabilities.tsx` mirrors Cedar actions instead of using `useCapabilities` or `useFeatureFlag`. This is legitimate local authority, but the generic read side could become a library wrapper.

ESCALATE: no — both gates pass, no portal files changed, and the five open findings are all low-severity.
