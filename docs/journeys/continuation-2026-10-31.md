# Journey continuation — 2026-10-31

Resumed from `7dd22dc9` and `docs/local-backlog-goal-2026-10-28.md`.
The initial checkpoint below is the pushed `aae11cda` baseline. Subsequent
repairs are recorded later in this document. No expectation or audit burn-down
entry was relaxed.

Latest application UI: **2.488.0**, with the Work/Brief/catalog refinement and
its targeted validation recorded at the end of this document. Historical journey
freshness below is scoped to its recorded source revision.

## Journey checkpoint — 2026-11-01

| Family | Complete passing maps | Failed | Held |
|---|---:|---:|---:|
| Pipelines | 55 / 55 | 0 | 0 |
| Social | 48 / 48 | 0 | 0 |
| Assessment | 57 / 57 | 0 | 0 |

All 160 target logs have a passing verdict and the complete step count of
their current map. Seventy-six targeted renewals completed after the last
assertion changes; already-valid completed evidence was retained. The final
renewal batch found and repaired the Artifacts long-title overflow (`3e8dd398`),
then passed every remaining walk. Shared UI is pinned to 2.485.0.

Assessment's cursor stretch proof is renewed with two directions, movement,
leave cleanup and outsider refusals, screenshots and JSON diagnostics
(`6c2ced65`). Its older chat/call/edit history is preserved separately and is
not claimed as renewed. All 364 maps validate, all 49 runner tests pass, and
the static coverage report is current (355 runnable maps across all families;
that number is not an execution count).

Final measurement for the Artifacts change passed. All 160 target records are
sealed and fresh, and the Assessment, Pipelines and Social judges pass with
`--quick --no-time`. This local journey goal is complete. The product/money
defaults, deploy-machine AWS work and broader deep-audit follow-ups recorded
below remain open; no cloud rollout was performed.

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

At this checkpoint the broader Work item deep audit was **not clean**: eight cases, ten findings,
zero unclassified composer policies. Seven cases could not settle a loading
state, and the one measured case showed the existing 13px Add criterion
control, h1→h3 outline jump and duplicate Breadcrumb navigation name. These
are recorded in `.scratch/journey-repair-2026-10-31/work-composer-deep`; the
focused call/prompt fixes did not clear these broader page issues. Their later
repairs and confirming matrices are recorded in the broader follow-up below.

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

Assessment's first full map walk was stopped after 18 complete results: 15
passed, with 39 maps not written. The three failures were the administrator
scorecard's populated graph and two reader maps using native `selectOption`
on the shared custom Zoom dropdown. The maps now open and choose its actual
options, retaining sheet-scale and Fit width assertions. UI-components 2.484.2
(`e0176631`, release `644dec46`) gives graph summaries the full card width and
effort titles a 16px line box. All 11,251 owner tests, lint and build passed;
the packed artifact is installed, Vite refreshed, and all 17 administrator
scorecard steps now pass with zero DOM findings. The assessor's 16-step
Enterprise reader and lead assessor's eight-step Enterprise editor both pass;
the reader opens the custom dropdown, verifies 50% on the sheet, then verifies
Fit width and a changed sheet scale. Portal typecheck and 17 map tests pass.
Final contract measurement is running on this frozen application source;
unfinished maps must still be walked.

A provisional cursor rerun passed
both directions, leave cleanup and both outsider refusals; an earlier run
missed the second movement. Keep that failure visible, retain cursor frame
diagnostics, and repeat the proof after the final contract measurement before
renewing its durable record. No final tenant acceptance or seal is claimed.

### Document header alignment follow-up (2026-11-01 UTC)

The 2.484.2 rail measurement passed, and all six type-scale tests passed with
zero new offenders. The cascade sweep exposed four Assessment document
headers after the duplicate hidden headings were removed. The title is a
FileKindMark/title group, like the existing back-action/title variant; the
judge now measures that declared leading group and a browser fixture rejects
both a shifted group (including the actual 4px offset) and an ordinary shifted
heading. No tolerance or route exemption changes.

That classification exposed a real spacing defect: EditorShell's fixed 20px
header inset is 4px left of the host's 24px breadcrumb gutter. The additive
`headerInset="page"` option shipped in 2.485.0 (`968eb7ad`, release `8625d56c`)
and is adopted by Assessment's DocumentShell. The older editor inset stays
the default. The owner passed all 11,251 tests (two existing skips), lint and
build; the consumer typecheck and component-discipline judge pass.

The packed confirming sweep passed all 16 Assessment slash routes, including
the four headers, and the positive/negative geometry fixture. The cursor
preflight also passed in 15.5s with persisted diagnostics: both directions,
leave cleanup, two outsider refusals, zero disclosed cursors, blocked writes
or console errors. Its earlier missed-movement observation remains above.
The full 2.485.0 rendered-contract measurement is now running; final map walks
and the post-measurement cursor proof remain before sealing.

### Final-walk checkpoint (2026-11-01 04:05 UTC)

The full 2.485.0 measurement passed: 19 rail routes, 19 layout tests and six
typography tests. No route values changed from the accepted contract baseline.
All 364 maps validate, all 49 runner tests pass, and static coverage is current.
The official sealer accepted 84 complete target records and refused 26 older
passing records whose assertions changed after their walks. Those 26 join
50 failed/incomplete records in a 76-map targeted renewal queue.

The final cursor proof passed in 14.6s after measurement and was sealed.
Both directions, movement, self-pointer exclusion, leave cleanup and outsider
refusals are recorded with current screenshots and JSON evidence. The former
mixed historical log is preserved verbatim under `docs/history/assessment-stretch/`;
its older chat/call/edit observations are explicitly outside the renewed cursor
verdict, as they were in the previous 2026-10-24 active record.

The targeted walks then found a new Artifacts overflow: a long run title made
the Run column 5,267px wide. `ArtifactsPage` now uses the existing `T` primitive
to bound Artifact and Run text, preserving complete values in their titles and
the row's run navigation. Its confirming administrator map passes all 13 steps;
the screenshot shows all six columns again. Portal typecheck and component
discipline pass. The application changed after the measurement above, so it
needs another measurement after the remaining provisional walks and any repairs.
Do not treat this checkpoint as final tenant acceptance.

## Final local acceptance — 2026-11-01

- Final rendered contracts all match source digest
  `e7a7ca072559d590e461250a5f9f1558c26ac442e5f36fea7d3f7fd376a1f78e`:
  rail at 04:40:48 UTC, cascade at 04:48:35 UTC and typography at 04:54:51 UTC.
  All 19 rail routes, all 19 layout tests and all six typography tests passed.
  No route contract values changed from the accepted baseline. Typography has
  zero new offenders; the granted Communication "Pinned" marker remains a
  report-only observation, not a newly cleared finding.
- All 76 required renewals completed. The Artifacts overflow failed on its
  first attempt, was fixed, and passed confirmation; the earlier failing
  screenshot/result and log remain under `.scratch/journey-repair-2026-10-31/`.
  Existing valid walks were retained. Every one of the 160 target logs has a
  passing verdict and the full current map step count.
- The official sealer accepts Pipelines 55/55, Social 48/48 and Assessment
  57/57, with zero remaining walks. Assessment's renewed cursor stretch proof
  is also fresh; its older accessibility and agent-run stretch contracts still
  match their existing evidence.
- `validate-assessment-tenant.sh`, `validate-pipelines-tenant.sh` and
  `validate-social-tenant.sh` all exit 0 with `--quick --no-time`. Social's
  Assessment, navigation and retired-tenant sibling checks are green too.
  These are quick local judges, not cloud or full infrastructure acceptance.
- All 364 maps validate, all 49 runner tests pass, and coverage drift is zero.
  Final portal typecheck and component-discipline checks pass. The shared
  2.485.0 library release passed 11,251 tests (two existing skips), lint and
  build. Earlier portal and middleware verification details, including the
  corrected middleware test fixtures and confirming runs, remain above.

Scope remains local Chromium 148 at 1680×940, light theme, real local services
and disposable clone identities (with explicit cookie-less demo probes).
The original Work toolbar/composer fixes also have their separate responsive
light/dark fixture and live keyboard proof described above. The broader Work
deep-audit findings and Pipelines configuration deep-probe follow-ups were not
silently cleared by these map passes. No budget default changed and no AWS
rollout or SFU media validation is claimed.

## Broader Work and Configuration follow-ups — 2026-11-01

Application commit `92728a36` adopts ui-components 2.486.3 (source
`e7d143bf`, release `87bb34b9`). Choice and confirmation prompts now replace
the discussion composer with their numbered answers. They receive keyboard
focus directly; manual answers get a plain input only when the prompt permits
them. Hiding the prompt restores the unsent discussion draft. Shared component
stories cover model selection, a custom run cap, an instruction and confirmation.
The meeting toolbar's spacing and count badges also have responsive coverage.

Brief preview opens the existing right pane with its own scrolling and keeps
the brief available while switching between Discussion and Agent. Today has a
drag handle and header/footer drop zones; clicking or keyboard-activating the
handle also moves it. Its placement persists on this device, and focus follows
the handle after a move. Shared stories cover both positions.

The broader audit repairs include bounded brief text and runbook links,
non-overlapping code-copy controls, stable side-pane headers, named navigation
landmarks, heading semantics, and Configuration loading/error/read-only states.
The readiness probe now waits for the actual destination record after lazy
navigation. The audit engine recognizes only declared, exercised prompt and
nonmodal focus profiles; broken fixtures and ordinary neighboring controls
remain checked.

Accepted evidence is indexed in
[broader-audit-2026-11-01.json](broader-audit-2026-11-01.json). All three strict
matrices report zero findings and zero unclassified states: Work detail 26,
Brief pane 28, and Pipelines Configuration 23 cases. These are 77 executed cases
in light/dark at 1440/900, not a claim that every application route was deeply
audited. Every report has visual reviews covering default, layer, data and narrow
states. The initial Configuration discovery failure remains historical rather
than being counted as a verified case; its current ready and denied/read-only
states were executed successfully.

Validation on the packed release:

- 14 application browser interaction checks and five Storybook checks pass.
  The latter include 390px layouts, actual light/dark contrast, restored drafts,
  direct numeric selection, manual input and both ticker positions. Live Work
  checks include dragging, reload persistence, keyboard relocation and no
  business writes or console errors.
- Owner tests: 11,254 passed, two existing skips; lint and build pass. The
  archive matches all 340 packed build files. Portal tests: 1,816 passed;
  typecheck, 16 audit-policy tests and component discipline pass.
- Audit engine self-test passes all 55 mutation checks plus its additional
  fixtures; skill validation passes. The final serial owner gate supersedes
  an earlier export-surface failure caused by reading an in-progress build.
- Raw accepted reports, screenshots and logs are retained under
  `.scratch/broader-audit-2026-11-01/`. Failed attempts are retained too,
  including the first Brief-pane cold-navigation timeout and initial Storybook
  theme/animation measurement failures. The accepted runs exercise their
  corrected readiness and theme behavior.

All accepted matrices share rendered source digest
`9853f346d0a59cff30cf34d50e91a24f0b325ca6294074a34c8e5747fceec1e3`.
Their pre-commit revision metadata is preserved; it describes the exact content
subsequently committed as `92728a36`.

The first contract renewal exposed a legacy breadcrumb probe that depended on
the literal accessible label. The shared probe now also recognizes ScopeHeader's
declared breadcrumb marker with an ordered list; an unrelated location label
alone is rejected. Browser fixtures retain missing-trail and shifted-trail
failures, with no geometry tolerance or route exemption changes. Final rendered
contract renewal passed on the digest above: 19 rail routes at 14:37:38 UTC,
20 layout tests at 14:45:29 UTC and six typography tests at 14:51:49 UTC. The
layout and typography sweeps each judged 143 inventoried routes, also recording
their additional observed routes. No accepted route contract value changed.
The granted Communication "Pinned" observation remains report-only. The
optional realtime-examples server was not running and was not measured.

The official sealer required 15 Pipelines renewals because the Configuration
readiness assertions changed: four Configuration roles and 11 outsider checks.
All 15 were walked again and passed. Final seal checks accept all 160 target
records: Pipelines 55/55, Social 48/48 and Assessment 57/57, with no remaining
walks. Existing valid walks were retained. All 364 maps validate, all 49 runner
tests pass, and coverage drift is zero.

The final Assessment, Pipelines and Social judges all exit 0 with
`--quick --no-time`, including Social's sibling checks. The broader follow-up
goal is complete. This is local browser and quick-judge acceptance; the budget
decisions and deploy-machine work remain open in the backlog. No AWS rollout
or live SFU media proof is claimed.

## Work rail, document pane and catalog refinement — 2026-11-01

Shared UI 2.488.0 (source `38b025e5`, release `34e0cd27`) follows the screenshot
feedback. The Work rail replaces the large status/Views/segmented controls with
a compact initiative selector, underline tabs and a small overflow menu. Sort is
a compact menu. Six-pixel indicators and a separate metadata line leave more
room for titles. The reader can drag the rail edge, use arrow keys on its divider,
or widen/reset it from the header; the width persists on the device.

Brief preview is a dedicated document pane without initiative tabs. Its trigger
shows the open state and toggles it closed. Wide layouts preserve at least 640px
for the page; below 1240px of split space the document takes the column, with the
mounted page and draft restored on close. Document tables wrap their prose and
align cells at the top. Open work in initiative Details closes the pane and
selects the item, including when it was already selected. A new item's active
question may take keyboard focus, as the prompt interaction requires.

Designs combines its status selector and record list in one rail. Its record
uses plain summary, discussion and context sections that stack by available
column width. Decisions uses the same 264px rail and 24px content inset as
Initiatives. The Chat/Agent mode dropdown contains no formatting section.

[Retained refinement evidence](layout-refinement-2026-11-01.json) indexes five
strict deep matrices: Work 26, Brief 25, Designs 24, Decisions 27 and Initiatives
32 cases. All **134 cases have zero findings and zero unclassified composer
policies**, in light/dark at 1440/900. Visual samples include narrow, dark,
long-data and open-layer states; interaction screenshots also show the expanded
Work rail. These targeted matrices do not certify every application route.

Validation:

- Owner: 11,259 tests pass with two existing skips; lint and build pass. Four
  Storybook checks cover resizing, persistence, document width, narrow content,
  plain review sections and the mode dropdown. Seven packaging checks pass;
  all 339 archived build files match owner `dist`.
- Portal: 1,816 tests and typecheck pass. Five application interaction tests
  cover the above behavior, compact prompts and Today relocation; one browser
  mutation fixture retains ordinary and adjustable column checks. Nineteen
  policy/rail unit tests, component discipline and static rail checks pass.
- Rendered rail parity confirms Designs and Decisions match Initiatives. The
  audit self-test passes its 56 mutations plus additional transition/fixture
  checks; the skill validates. No tolerances were widened.
- Optional owner static-style and raw-node-control guards still fail on the
  exact same entries as baseline `87bb34b9`, verified against an isolated archive.
  Hex-color checks pass. Those existing guard findings were not suppressed.

The audit now measures the logical children of an adjustable split, keeps
content-row tables on an explicit document profile, and resets the keyboard
walk's starting point. Snapshot preparation finishes finite CSS transitions:
a fading selected Brief button had appeared in only one of two fingerprints.
The endpoint is still checked and recurring script-driven movement still fails.
Each profile has valid and deliberately broken fixture coverage; ordinary
neighboring tables, dividers and toolbars remain checked.

Raw reports, screenshots, self-tests and failed attempts remain under
`.scratch/layout-refinement-2026-11-01/`. The final reports are `verified-*`;
`audit-*` and `accepted-*` retain earlier failures. The original Brief Details
cases were unstable, so the comparison correctly leaves their four old findings
unverified rather than calling them resolved. Both current Details cases were
executed and pass. Earlier interaction failures assumed focus must leave a new
item's active question; the corrected assertions verify its selected item,
visible title and closed pane while preserving prompt focus.

The source digest for the UI is recorded per matrix. This change did not rewalk
or reseal all 160 journeys against the new digest; the earlier complete journey
acceptance remains historical evidence. Budget defaults and deploy-machine AWS
steps remain open, and no cloud rollout was performed.
