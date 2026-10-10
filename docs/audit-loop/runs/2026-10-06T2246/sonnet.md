# Audit 2026-10-06

## Delta since last run
- new: raw tag total rose 420 → 421 (`raw-scan.txt:1`). The only candidate I found is a `<p>` inside `<Prose>` in `portal/src/components/decks/ShareToSocialAction.tsx:127`. I could not diff against the previous raw-scan, because that run didn't save one. It's low severity: the paragraph is wrapped in the library's `Prose`, and the whole `components/decks/` directory is untracked (new).
- new: the version header in `docs/audit-loop/realtime-parity.md:3` is mangled. It reads "…ui-components 2.423.0 (`c4cd04e9…`).419.0.", with a leftover fragment of the old version number. The pins themselves are correct. The installed dists are ui-components 2.423.0 and realtime-modules 0.113.0 (`node_modules/@connorhoehnslalom/*/package.json`).
- fixed: nothing new. The `signals.txt` output is byte-identical to the last run: the same static `style={{` list, the same 12 raw `EventSource` sites, and the same DM-helper wrappers.
- still open: 5 low findings (the 4 from last run plus the new `<p>`).
- Gates: `validate-component-discipline.sh` and `validate-nav-parity.sh` both pass (`gates.log`).
- `useNotifications` is still mounted once, at `SharedNotifications.tsx:20`. `ActivityBell.tsx` only mentions it in a comment, and `tenantCaches.ts` is cache-clearing code.
- parity ❌/⚠️ remaining — orgiq: 20/38 · assessment: 21/38 · social: 18/38 · pipelines: 15/38. These are carried forward from last run and not re-walked. This run's changed set is the same dirty tree as before: middleware gateway, work-graph, deck-shared, social and mock files, plus `docs/ui-components-queue.md`. No portal realtime hook mounts changed in anything I checked.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label placement in `style` | A library edge composite | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` | no. `typeof Radio` is `undefined` in `/shared` at 2.423.0, so upstream-needed (queue row 53). |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | A `Thumbnail` composite | no. `typeof Thumbnail` is `undefined` at 2.423.0, so upstream-needed (queue row 222). |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Local `parseDmLobby` wrapper that parses the tenant prefix itself | The library's `parseDmLobby` | yes, but the library version needs a known prefix and can't discover the tenant. A thin wrapper is defensible. |
| 5 | low | `portal/src/components/decks/ShareToSocialAction.tsx:127` | Raw `<p>` inside `<Prose size="sm">` | Plain text in `Prose`, or a `Text` primitive | yes (`Prose`, already used). The tag is likely the +1 in the raw total. |

I did not re-count the runtime-colour `style={{ color }}` uses in `Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109` and `ScorePanelNode.tsx:44`. They are unchanged from last run's signals and were already tolerated as data-driven.

## Stale exemptions
- Queue rows 53 (`Radio`) and 222 (`Thumbnail`) are still valid: neither export exists in the 2.423.0 dist.
- `docs/ui-components-queue.md` has 126 changed lines (105 insertions, 21 deletions), and it has 14 "Composed locally" rows. I did not diff the queue or re-check the other rows against 2.423.0. This is the same gap as last run, so rows could have moved unseen.

## realtime-examples divergences
I did not open realtime-examples this run, so I report no new ones. The standing gaps in `realtime-parity.md` still apply:
- Cursors are ❌ in all four tenants, because the gateway does not mount `cursor()`.
- Hangout rooms and recordings are ❌ outside social.
- Knock/lobby is ⚠️ in social.
- The orgiq and pipelines CRDT cells are ❌.
- Screen share is ⚠️ in orgiq, assessment and social.

For a human or the next run:
- Fix the garbled header at `realtime-parity.md:3`.
- Re-walk the huddles-on-run/document-pages cells against 0.113.0. Its `join` verb and lobby page-huddle adoption may flip them.
- Have `run.sh` keep the previous `raw-scan.txt` so a raw-tag change can be attributed to a file.

ESCALATE: no — both gates pass and nothing new beyond a low-severity wrapped `<p>`.
