# Journey continuation — 2026-10-31

Resumed from `7dd22dc9` and `docs/local-backlog-goal-2026-10-28.md`.
The app's rendered contracts are measured on the current source. The first
walks found failures beyond stale seals; passing maps alone are eligible for
sealing. No expectation or audit burn-down entry was relaxed.

## Execution

| Family | Maps | Passed | Failed | Held | Status |
|---|---:|---:|---:|---:|---|
| Pipelines | 55 | 17 | 38 | 0 | All walked; 17 passing logs sealed |
| Social | 48 | 31 | 13 | 4 | All runnable maps walked; 31 passing logs sealed |
| Assessment | 57 | 17 | 40 | 0 | All walked; 17 passing logs sealed |

All 156 runnable target maps have current, complete step lists and matching
log verdicts; no interrupted result is counted. There are 65 passing walks
and 91 failing walks. These are executable-map results. Assessment's older
stretch proofs are separate records; the map count does not claim to re-prove them. Social's four
activity maps remain held: their live notification proof needs a chat write
that the shared gateway cannot isolate in a mock scope. They were not re-sealed.

Scope: Chromium 148 at 1680×940, light theme, local mock services and clone
identities (except the explicit cookie-less demo probes). This is not a full
responsive/dark-theme acceptance matrix or cloud validation. No application,
middleware or infrastructure source was changed by this continuation. The
concurrent deploy-machine commit `be244ee8` was fast-forwarded before the first
push; it did not overlap these changes.

## Runner and map repairs

- Coverage generation reads the generated tenant registry after DE-29 instead
  of parsing declarations that no longer exist in `session.ts`. Its denominator
  includes the cross-tenant administrator role in each tenant. The report
  explicitly distinguishes static map coverage from executed, passing walks.
- Social inbound maps now prove forged chat join/history and presence
  subscription refusals for identities without a Social grant. The bounded
  probe closes its socket, rejects leaked channel data and records no token or
  message content. It uses the token endpoint's gateway URL or the same public
  Vite setting the portal uses.
- Social channel keyboard steps target the current accessible row name while
  retaining the same Enter-and-navigation assertion. Unknown-hangout steps
  expect only the specific missing-room 404, rather than swallowing unrelated
  console errors.
- Negative-text assertions wait for the expected live update, using the same
  bounded polling as positive assertions. Text that remains still fails;
  global regular expressions cannot alternate into an accidental pass.
- Assessment searches must return a real data row before a row can be opened;
  an empty-state row with a spanning cell no longer satisfies that check.
  Activity opens an Assessment run from its own ledger (the separate pipeline
  summary deliberately has no record links). The scorecard opens the About
  disclosure before checking the evidence coverage it contains.

## Findings to resolve

Pipelines' surface failures recur across the four roles:

- Run detail: `DetailSection` heading order and `ActivityFeed` text contrast.
  Owners: `portal/src/pages/pipelines/RunDetailPage.tsx`,
  `portal/src/components/ChannelActivity.tsx`, and the shared component library.
- Missing pages: no primary heading, low-contrast title and oversized raw
  keyboard hint in `portal/src/pages/NotFoundPage.tsx`.
- Missing approval: two primary headings; the nested `RecordNotFound` call in
  `portal/src/pages/pipelines/ApprovalsPage.tsx` needs the embedded heading size.
- Definition records expose a raw bot UUID in the header; promotion warnings
  and the configuration description also fail contrast.
- Audit-policy issue: `/pipelines/runs/does-not-exist` is required to have a
  composer even though the visible missing-run state has no discussion.
  Any correction needs positive missing-record evidence and must retain the
  composer requirement on loaded runs and collections.
- One Approvals measurement moved between the two audit frames. It remains a
  failed stability observation, not a new exemption.

Social has 13 failed maps after the repairs and confirming walks:

- Calls, all four roles: two primary headings (`Calls`, `Calls`).
- Configuration, all four roles: contrast findings in the permission matrix;
  two roles also trip the repeated-content heuristic on adjacent `Yes` cells.
  Review that heuristic against the table semantics before treating repeated
  permission values as a product defect.
- DMs, all four roles: control typography; two also report conversation
  metadata typography. The three roles with copied DMs attempt
  `POST /api/social/dms/read` on opening a conversation. The read-only walker
  blocks the receipt write. Prove isolation of this write before permitting it;
  do not call it a read-only request merely because it marks a message read.
- Participant Channels: the Documents tab moves between the two audit frames,
  reproduced on the confirming walk. The moderator's equivalent measurement
  passed on confirmation; that map is sealed. The original failure remains in
  `.scratch/resume-2026-10-31/social-rewalk.log`.

All four hangout maps now pass with the signalling fixture. This proves the
live occupancy UI, not SFU media. Both no-grant gateway probes pass against the
actual local gateway: join returns `not-a-member`; history and presence return
`AUTHZ_CHANNEL_DENIED`; zero channel frames are disclosed. All 31 passing
Social maps were checked with the freshness judge and are fresh.

Assessment has 40 failed maps: ten surfaces per role; all four dashboards,
all four reports and all nine isolation maps pass. The remaining findings are:

- Document explorers: repeated primary headings, breadcrumb landmark names,
  contrast, comment typography, dashed reaction controls and the italic
  toolbar's serif preview. Owners: `knowledge/KnowledgeExplorer.tsx`,
  `knowledge/CanvasDocumentPane.tsx`, `knowledge/ExplorerFrame.tsx` and the
  shared document components. Review editor content and style previews against
  the audit contract before prescribing component changes; these observations
  have not been exempted.
- The assessor maps still require the older reader's `On this page` and
  `Full width` buttons. The current canvas renders neither; it exposes
  `Show outline` through its document menu instead. The old buttons live in
  `knowledge/DocumentReader.tsx`, while the active surface is
  `knowledge/CanvasDocumentPane.tsx`. The reading-width expectation remains
  unresolved and failing; it was not dropped to obtain a pass.
- Scorecards: composer shelf inset by 24px, skipped heading levels in the
  Stories tab, and inert rows in the Evidence & Intake table.
- The submission wizard trips the collection composer's presence policy and
  its step-number controls measure 11px against the 12/14px contract.
  Submission, question and run records, and Configuration, also have contrast
  findings.

## Validation

- All 364 maps validate; static coverage generation and its drift check pass.
  The coverage report has 351 runnable maps across all families and is not an
  execution count for this continuation.
- `node --test scripts/journeys/tests/*.test.mjs`: 45 passed, zero failed or
  skipped, including gateway refusal/leak/timeout cases and live-update waits.
- All 65 passing target logs pass the freshness judge against measured current
  contracts: Pipelines 17, Social 31, Assessment 17.
- The three tenant judges were run with `--quick --no-time`. Middleware and
  portal typechecks pass, as do the Pipelines and Assessment node tests. The
  journey gates deliberately remain red:

| Judge | Failing checks | Current journey failures |
|---|---:|---|
| Pipelines | 3 | 26 P0 + 12 P2 surface logs; 38 of 56 logs stale/unsealed |
| Social | 4 | 5 S1 + 8 S2 surface logs; 12 of 48 logs stale/unsealed (including four held activity proofs); Assessment neighbor judge red |
| Assessment | 2 | 40 surface logs; 17 of 61 logs stale/unsealed (including `stretch/realtime.md`) |

Freshness totals include historical records outside these maps. A failed walk
can still have an older matching seal; passing freshness alone is not journey
acceptance. No failed walk was re-sealed to clear a gate. These were quick
judges, not the full middleware/infra suites or a deployed acceptance run.

## Next repair pass

1. Start with the repeated shared-component and page-composition findings
   above. Review the missing-record/wizard composer policies and document
   content/style-preview rules against real states; do not add blanket
   exclusions or new burn-down allowances.
2. Resolve the assessor reader-control contract, and prove isolation for DM
   receipts and activity writes before permitting those writes in a walk.
3. After changing rendered application code, measure the contracts with
   `scripts/journeys/measure.sh`, re-walk the affected maps with `--no-seal`,
   and use `scripts/journeys/seal.sh <log>` only for passing complete walks.
   Assessment’s older `stretch/realtime.md` also needs a separate safe proof;
   no stretch record was re-sealed here.

[The measured findings](continuation-findings-2026-10-31.json) preserve rule,
selector, expected/actual values, affected logs and example step numbers.
Counts there are repeated observations, not unique product defects.
Per-map evidence is in `docs/{pipelines,social,assessment}-journeys/`.
Detailed step results, screenshots and command output for this continuation
are under `.scratch/journeys/` and `.scratch/resume-2026-10-31/`.

Budget defaults and AWS rollout work remain in the original backlog document;
this continuation does not decide those product/money choices or apply cloud
changes.
