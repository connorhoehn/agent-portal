# Journey continuation — 2026-10-31

Resumed from `7dd22dc9` and `docs/local-backlog-goal-2026-10-28.md`.
The initial checkpoint below is the pushed `aae11cda` baseline, before the
active repair batches described later in this document. Its rendered contracts
were measured at that checkpoint. The repair source still needs final measurement
and sealing; passing maps alone are eligible for sealing. No expectation or audit burn-down entry was relaxed.

## Initial execution checkpoint (before active repairs)

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

## Findings at the initial checkpoint

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

## Initial checkpoint validation

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

## Repair plan from the initial checkpoint

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

## Active repair goal (2026-10-31)

The next goal is to repair the 91 failed maps, establish isolated write proofs
for the four held Social activity maps and DM receipts, renew the Assessment
realtime proof, remeasure rendered contracts, re-walk and seal complete passes,
and make the three tenant judges pass. Product/money defaults and deploy-machine
AWS work remain open; this goal authorizes no cloud apply or shared mock reset.

The first application repair batch is pushed as `6af29c14`; runner, isolation,
evidence and final acceptance work remain in progress. The owning ui-components
releases are pushed: 2.483.0 (`65141352`, `0ce6ba0b`) and 2.484.0 (`eaba6a91`,
`855e01eb`), followed by 2.484.1 below. The portal consumes packed 2.484.1; its exported h2
PageHeader and ErrorState foreground were checked from the installed package.
The latest upstream gates passed: 1,022 test files, 11,249 tests, two existing
skips, lint, build, and the audit engine's valid/broken fixture self-tests.

Changes cover shared alert/activity/comment contrast and type, semantic
headings and document landmarks, missing pages, Assessment text tokens and
composer gutters. Readers regain the existing canvas status bar because they
have no formatting toolbar; their maps exercise Show outline, a heading jump,
50% zoom on the actual sheet, and Fit width. Missing-run and upload-wizard
composer policies require positive rendered/API evidence. Audit checks retain
failures on duplicate labels inside a cell and neighboring application headings.

Provisional walks on 2.483.0: all ten Pipelines author maps passed (Approvals
confirmed after explicitly waiting for its About card to close); participant
DMs passed with scoped receipts and a read-only presence peer; seven of twelve
Assessment program-lead maps passed. The remaining five identified selected-row
metadata contrast, margin comment type, and embedded scorecard/document headings;
source fixes are now awaiting the next rendered walk. These are not new seals.
The baseline execution table above remains the last fully collected result.

DM receipts have direct isolation tests. Clone-to-clone notification tests
exposed and fixed sender projection: shared records still use the persona, but
a DM naming the authenticated clone keeps that clone as author. Twenty-five
targeted gateway, ownership and cleanup tests pass. Deletion/expiry removes only
the exact clone's memory inbox and prevents late writes from repopulating it.
Health now reports the chat backend so the runner can require memory chat and
inbox stores before sending. The four activity maps now declare this isolated
scenario; all four passed in the 2.484.0 Social walk and still need final seals.

No new rendered-contract measurement or final tenant judge acceptance is claimed
yet. Configuration's initial deep matrix had 16 clean ordinary cases plus five
deep findings (error-state contrast/copy, readiness/classification, About-card
reopening); those remain visible until a confirming deep run resolves them.
Scratch validation: `.scratch/journey-repair-2026-10-31/`.

### User-reported composer follow-up (2026-10-31, 22:28)

The active goal also includes the reported Work item composer defects at
`/iq/projects/p-observability?scope=all&tab=work&item=wi-obs-e3-s1`:
call header padding removed by the portal, overflowing meeting count badges,
missing focus when the agent prompt appears, and cap buttons showing bare
digits although the mixed numeric input actually required Alt. Repairs are
pushed in the owning UI library and portal (`6af29c14`); no job or request was submitted.

The 2.484.0 Social verification walk finished **46/48 passing**, including all
four newly unheld activity maps. Only community-admin/channels and
moderator/channels fail at step 7 on rendered stability; preserve their
diagnostics and investigate before final measurement/sealing. These logs are
not yet sealed and the three tenant judges remain unfinished.

Composer repair verification: UI-components **2.484.1** is released/pushed
(`8b0c5141`, release `97fac1c5`) and adopted. Counts now occupy space inside
their buttons; call controls retain 8px top padding plus their border. New
prompts focus the composer and display contextual answer hints; typed-answer
buttons print their actual Alt shortcut. Cap presets are numbered choices;
Custom amount opens numeric entry. The competing page-level answer-button
focus loop was removed. No page redesign or dispatch-gate change.

Owner gates: 1,022 files / 11,251 tests passed, two baseline skips; lint, build,
audit self-tests (including valid/broken badge/inset fixtures) and skill
validation passed. Portal: 1,816 tests, typecheck and component discipline
passed. Nine browser interaction cases passed, then the corrected responsive
fixture passed separately at 1440/900/390 in light and dark. Actual reported
route passed as a fresh Sienna clone: open Prepare job, automatic input focus,
3 → cap, 2 → forecast, empty input afterward, **zero write attempts/errors**.
No call/recording was started; call layout uses actual packed controls and
owned canvas streams. Older e2e assumptions about hidden stack controls and
403 sprint-grant behavior were aligned with their existing source contracts.
Artifacts: `.scratch/journey-repair-2026-10-31/toolbar-*`. Deep route sweep and
remaining tenant journey work continue; this is not an overall goal completion.

The broader Work item deep audit is **not clean**: eight cases, ten findings,
zero unclassified composer policies. Seven cases could not settle a loading
state, and the one measured case showed the existing 13px Add criterion
control, h1→h3 outline jump and duplicate Breadcrumb navigation name. These
are recorded in `.scratch/journey-repair-2026-10-31/work-composer-deep`; the
focused call/prompt fixes do not claim these broader page issues are fixed.

### Confirming checks (2026-11-01 UTC)

The audit-only tab fix is pushed upstream as `59cc8d2a5`. A semantic tab is
measured in the tab family even when its selected border changes; ordinary
buttons retain their own geometry checks. Valid/broken mutation fixtures, the
skill validator, all 11,251 UI tests, lint and build pass. Both remaining
Social channel maps now pass. This gives passing observations for all 48
Social maps (46 in the full walk plus two confirming walks), pending final
contract measurement, a fresh full walk and seals.

Clone isolation is pushed as `826d18e7`. The full middleware run completed with
588 passing suites, 14 skipped suites and three failing assertions in two
suites. The health expectation now includes the observed memory chat backend.
Two older dispatch-hold fixtures omitted the maintenance reserve or crossed a
hard cap while testing soft confirmation; `fb1459e9` corrects only their setup.
Both affected suites then passed all 69 tests. Spending policy was unchanged.
Journey runner tests pass 49/49 and all 364 maps validate.

Assessment's full map walk is in progress. A provisional cursor rerun passed
both directions, leave cleanup and both outsider refusals; an earlier run
missed the second movement. Keep that failure visible, retain cursor frame
diagnostics, and repeat the proof after the final contract measurement before
renewing its durable record. No final tenant acceptance or seal is claimed.
