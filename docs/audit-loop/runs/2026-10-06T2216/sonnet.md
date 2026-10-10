# Audit 2026-10-06

## Delta since last run
- new: none confirmed. The raw tag total is 419, the same as the previous run (`raw-scan.txt:1`), so last run's "418 → 419" has now settled.
- new: the installed library versions are ahead of the docs. The portal pins ui-components 2.423.0 at `c4cd04e9…` and realtime-modules 0.113.0 at `16a2fb22…` (`portal/package.json:16-17`). `docs/audit-loop/realtime-parity.md:3` still says 0.108.0 and 2.419.0.
- fixed: the local `dmMembers` question from last run. Both copies (`portal/src/pages/social/socialChat.ts:76`, `middleware/src/lib/social-chat.ts:89`) are thin wrappers over the library's `parseDmLobby(lobby, {prefix})` (`dist/call/lobbyChannel.d.ts:73`). They only adapt the return shape, so they are fine.
- still open: 4 low findings, all unchanged.
- Gates: `validate-component-discipline.sh` and `validate-nav-parity.sh` both pass (`gates.log`).
- `useNotifications` is still mounted once, at `SharedNotifications.tsx:20`.
- The 12 raw `EventSource` sites and the static `style={{` list in `signals.txt` match last run.
- parity ❌/⚠️ remaining, carried forward and not re-walked — orgiq: 20/38 · assessment: 21/38 · social: 18/38 · pipelines: 15/38. The changed set is large (209 `portal/src` files plus the middleware gateway tests), and I did not re-verify matrix cells.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime stroke width and label placement in `style` | A library edge composite | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A standalone `Radio` | no. `Radio` is `undefined` in `/shared` at 2.423.0, so this is upstream-needed (queue row 53). |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | A `Thumbnail` composite | no. `Thumbnail` is `undefined` in `/shared` at 2.423.0, so this is upstream-needed (queue row 222). |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | A local `parseDmLobby` wrapper that parses the tenant prefix itself | The library's `parseDmLobby` | yes, but it needs a known prefix and cannot discover the tenant. A thin wrapper is defensible. |

## Stale exemptions
- Queue rows 53 (`Radio`) and 222 (`Thumbnail`) are still valid. I checked the installed 2.423.0 dist and neither export exists.
- I did not re-check the other "Composed locally" rows (16, 17, 21, 221, 223, 224 and more) against 2.423.0. Those were also skipped last run.
- `docs/ui-components-queue.md` is in the changed set, so a row may have moved. I did not diff it.

## realtime-examples divergences
I did not open realtime-examples this run, so I report no new divergences. The standing gaps in `realtime-parity.md` still apply:
- Cursors are ❌ in all four tenants, because the gateway does not mount `cursor()`.
- Hangout rooms and recordings are ❌ outside social.
- Knock/lobby is ⚠️ in social.
- The orgiq and pipelines CRDT cells are ❌.
- Screen share is ⚠️ in orgiq, assessment and social.

Two items for a human or the next run:
- Refresh the version header in `realtime-parity.md:3`.
- Re-walk the parity matrix against 0.113.0. That release adds the `join` verb and adopts the lobby's live page huddle, which may flip the huddles-on-run/document-pages cells.

ESCALATE: no — both gates pass and no new raw JSX or style findings are confirmed.
