# Audit 2026-10-06

## Delta since last run
- new: the `validate-nav-parity.sh` gate failed on `portal tsc`, with `SocialFooter.tsx(107,5)` TS2322: `"idle"` is not assignable to `HuddleBarPhase`.
- fixed: prior #5 (`WeightedEdge.tsx:55,68`) and #6 (`Thumbnail.tsx:42,57`). Both are now covered by "Composed locally" rows in `docs/ui-components-queue.md` (lines 221 and 222). Both rows describe data-driven geometry or dimensions.
- still open: 1. That is #7 below, the local `DM_PREFIX` / `SOCIAL_DM_PREFIX` literals.
- parity ❌/⚠️ remaining: I did not re-verify any matrix cells this run and flipped none, so these are the 2026-10-05 counts carried forward. orgiq: 5/8 · assessment: 5/5 · social: 2/6 · pipelines: 3/8.

`validate-component-discipline.sh` passes (`gates.log`).

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | med | `portal/src/components/shell/SocialFooter.tsx:107` | Not hand-rolled. `phase="idle"` fails the `portal tsc` build step in the nav-parity gate. | Re-run the gate. If it still fails, the type or pin mismatch needs a fix. | yes: installed 2.416.0 lists `'idle'` in `HuddleBarPhase` (`dist/video.d.ts:1635`) |
| 2 | low | `portal/src/pages/social/socialChat.ts:68`, `middleware/src/lib/social-chat.ts:58` | `DM_PREFIX` / `SOCIAL_DM_PREFIX` are derived from `dmLobbyName(['a','b'])` by slicing the result. They only feed the library parse helpers. | Leave it, or ask the library to export the DM prefix. | partly |

For #1, the working tree has uncommitted changes to the `ui-components` pin in `portal/package.json`. It moved from `e95120a8` to `e653d0b2`. The gate probably ran against a stale `node_modules` or an earlier dist. I did not run `tsc` myself.

Inline styles in `KBHealthBadge.tsx`, `scores/*`, `ScorePanelNode.tsx` and `VersionPickerStep.tsx` are data-driven colours. I did not check whether each has a queue row. `raw-scan.txt` shows 66 files with 100 raw tags, mostly `span` and `div`. I did not walk the 608 changed files brace-aware.

Realtime checks:
- `useNotifications` is still called in one place, `SharedNotifications.tsx:20`. `ActivityBell` only reads it.
- All 11 raw `EventSource` uses are BFF SSE endpoints, and there is no raw `WebSocket`. `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` are the likeliest to move to a gateway channel, but I did not verify that.

## Stale exemptions
- None confirmed. I did not check whether the installed dist now ships the primitives behind the `DiffFrame`, `UnavailableNotice`, `DimensionRow` and `TemplateHighlighted` rows.

## realtime-examples divergences
- I did not compare the surfaces file by file this run.
- `SocialFooter.tsx` composes the library's `HuddleBar` from `ui-components/video`. I did not find a `realtime-examples` file that does the same job.
- The `realtime-parity.md` cells marked "code-only" are not confirmed by this audit.

ESCALATE: yes — the nav-parity gate failed on `portal tsc` at `SocialFooter.tsx:107`, and the installed dist appears to accept that value, so the cause (a stale pin or the working tree) needs a person to check.
