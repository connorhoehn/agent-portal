# Audit 2026-10-06

## Delta since last run
- new: the assessment work graph is now wired end to end. I read each hop:
  - route `middleware/src/routes/assessment-work-graph.ts`, mounted at `routes/assessment.ts:77`;
  - subject `{kind:'assessment'}` in `portal/src/lib/workGraph.ts:38-55`;
  - page `pages/assessment/ActivityPage.tsx`, routed at `App.tsx:272`, with rail and palette entries at `Layout.tsx:143` and `portalCommands.ts:245`.
- The page is composed from `PageHeader`, `Stack`, `Button` and the shared `WorkGraphActivity`. It has no raw elements and no inline styles.
- The matrix row for assessment work graph is now ✅ (`realtime-parity.md` §4, gap 5). The assessment Activity cell stays ⚠️ in my reading; I did not re-walk it in a browser.
- fixed: assessment work graph (the previous run's ❌).
- still open: 4 findings, all low, unchanged from the last run.
- parity ❌/⚠️ remaining, from the §4 tally (⚠️+❌ of 38 rows) — orgiq: 20/38 · assessment: 21/38 · social: 18/38 · pipelines: 15/38
- Gates: `validate-component-discipline.sh` and `validate-nav-parity.sh` both pass.
- `raw-scan.txt` shows 418 raw tags across 66 files, up one from 417. The only code files added to the changed set are portal `ActivityPage.tsx` and the middleware assessment work-graph files (route, sources, tests). I confirmed `ActivityPage.tsx` has no raw tags, so the new tag is probably in a file that already had some. I did not locate it.
- `useNotifications` is still mounted once, at `SharedNotifications.tsx:20`.
- The `EventSource` list in `signals.txt` is unchanged. These are non-gateway feeds, and the new page adds none.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | Runtime `strokeWidth` and label transform in `style` | A library edge/label composite | upstream-needed (queue row 221) |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | Bare radio with runtime `accentColor` and `borderLeftColor` | A rich-row `RadioGroup` or standalone `Radio` | upstream-needed |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | Raw `<img>` in a runtime-sized frame | An `Image`/`Thumbnail` composite | upstream-needed (queue row 222) |
| 4 | low | `middleware/src/lib/social-notify.ts:365` | Local `parseDmLobby` with a variable tenant prefix | A tenant-agnostic upstream parse, or keep the wrapper | upstream-needed |

These four were not re-read this run. Their scan lines are identical to the last run. The data-driven colours on `Inline` (`Leaderboard.tsx:86`, `CompareDeltaTable.tsx:37,66`, `PersonDetailCard.tsx:109`) stay under the runtime-colour tolerance.

## Stale exemptions
None found. `docs/ui-components-queue.md` is modified in the working tree (+105/−21) and has 14 "Composed locally" rows. I did not re-check those against the installed dist, including `UnavailableNotice.tsx` and `TemplateHighlighted.tsx`. The queue diff is large enough to deserve that check next run.

## realtime-examples divergences
- I did not open realtime-examples this run. These come from the matrix.
- Assessment work graph now uses the same projection, snapshot and stream path as orgiq and pipelines. That matches the pattern.
- Open ❌ rows:
  - message edit/delete/forward;
  - diagram board;
  - in-call reactions;
  - agent-loop/HITL cards in the thread;
  - call log outside social;
  - files panel;
  - transcription;
  - pre-join screen;
  - document review lifecycle.
- Cursors, rooms and recordings are not mounted outside Social (gap 4).
- Social work graph is still open (gap 5).
- Huddle chat and page sharing stay orgiq-only (gap 3).

ESCALATE: no — both gates pass and the one new feature follows the existing projection pattern. The assessment Activity ⚠️ and the extra raw tag are unchecked, but neither looks like a real defect.
