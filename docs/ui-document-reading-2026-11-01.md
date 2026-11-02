# Document reading layout

Brief preview, frozen briefs and runbooks use the workspace's CanvasDocumentView.
The right pane is a continuous, normal-size reading surface with a vertical
contents block inside the paper, after its title and introduction. Section numbers
match the headings (1, 1.1, 2); nested entries are indented and italic. The paged
view uses dotted leaders and measured page numbers, while the continuous pane
uses section links without invented page numbers. The page view keeps the workspace's page and zoom controls.
Both navigate by real document headings and keep Back to contents available.
Brief sources, installed skills and assembly details are numbered sections in
the same document and table of contents. They follow the instructions. Runbook
bundle files and provenance remain available below the reader.

## Names and typography

Use a short subject or action phrase for a navigation title. Put the scope in
breadcrumbs or metadata, the purpose in the summary, and detailed instructions
in the body. Avoid generated IDs, entire instructions and repeated collection
titles in the reading header. The shared reading title is 28px, section headings
22px and body text 16px. Narrow panes retain normal-size text and wrap headings. Horizontal rules divide
major sections; muted ink and italic context distinguish supporting information.

The original runbook catalog has concise editorial display names, matched by
original title so that user-authored renames win. This changes presentation only:
stored versions, checksums and Copy markdown remain exact. Briefs show Session
brief as their reading title and keep their generated identifiers in Assembly
details. The original full markdown remains available through Copy markdown.

## Implementation

The app adapter guards markdown with the existing image and URL policy, parses
GFM, and seeds an ephemeral local Y.Doc with the canonical workspace schema.
There is no collaboration provider, save endpoint or new backend mutation.
The existing workspace also uses the shared reading navigation when read-only.

Owner handoff: `../ui-components/docs/document-reading-handoff-2026-11-01.md`.
Storybook: Doc-Editor/CanvasDocumentView, Read Only Pane and Read Only Page.

## Proposal navigation

Runbook proposals remain application pages with their existing review controls
and diff viewer. A numbered contents list below the breadcrumb and title opens
each available section; a persistent Back to contents control returns to it.
The contents heading uses the same 16px scale as section headings. Runbook and
Runbook proposal type chips distinguish published entries from proposed changes.

## Verification

UI package 2.489.3: source commit `92d6c6c5`, release `14c7028f`.
The portal installs the packed archive, and its Vite dependency cache was rebuilt.

- UI owner: 11,262 tests passed, 2 skipped; source/demo type checks and build passed.
- Portal: 1,822 tests passed; type check, production build and component-discipline gate passed.
- Four Storybook browser cases passed: pane 390/900, page 1440 and application review navigation.
- Live portal checks passed in light/dark at 900/1440/1680: embedded contents,
  heading focus and scrolling, sources/assembly inside paper, readonly behavior,
  proposal section navigation, equal contents/section heading sizes, type labels
  and no business writes or page errors.
- Brief route deep audit: 34 cases, zero findings and no unclassified composer policies.
  Captured at `.scratch/document-reader-2026-11-01/audit-brief/report.json`.
- The audit skill's mutation tests and skill validator passed.

The broader runbook and proposal audits are not clean. The runbook sweep reported
four command-help alignment findings and a loading-state gap (the latter was
subsequently replaced with an inline loading row). The proposal sweep exposed
collection-table rules being applied to code-diff tables, plus existing review
label contrast, small code controls, inline prose and spacing findings. Its
missing loading/error page headings were repaired. Remaining findings stay open;
no broad code-table exemption or relaxed contrast threshold was introduced.
Reports are under `.scratch/document-reader-2026-11-01/audit-final-runbook` and
`audit-proposal`. These are UI checks, not refreshed journey seals or AWS deploy
validation; the earlier journey/AWS backlog remains separate.


## Follow-up: section controls, Details and people

Shared UI 2.489.4 adds previous/next section controls, a section position count,
and Back to contents to the existing document navigation. Page and pane readers
track manual scrolling as well as clicks. Runbook proposals use the same controls
without adopting a paper canvas. Controls stop at the first/last section and the
document status bar wraps at phone widths.

Initiative Details now uses a compact labeled facts list, names every SME, and
separates the next work item with a plain rule. Its action names the work key;
opening it closes the pane and focuses the work item, even if already selected.
Docs and Activity are named actions instead of unexplained tab-bar icons.

The combined Decisions/Designs record rail uses divided rows and sentence-case
groups. Decisions includes initiative context under each title. Decision people
receive their authorized photo URL through both mock and Aurora providers; the
shared review thread and sign-off panel now accept photos too. Designs uses
existing contributor photos and only resolves legacy author names when the
contributor match is unique. No synthetic replacement is assigned to an unknown
person and no application-wide avatar lookup bypasses existing read permissions.

### Follow-up verification

UI package 2.489.4 is pushed: source `8e24cfb3`, release `8f145413`.
The application installs its packed archive.

- UI owner: 11,265 tests passed, 2 skipped; lint, source/demo types and build passed.
- Six Storybook browser cases passed: section navigation, manual scrolling,
  first/last bounds, 390px controls, initiative facts and review portraits.
- Portal: 1,822 tests passed; types, production build and component discipline passed.
- Live portal: 18 distinct checks passed across document navigation, Details,
  work layout and people. Light/dark tests now set the real preference key and
  explicitly assert the resulting theme. Updated portrait checks confirm five
  decision participant photos, three initiative people photos, work-row owners
  and sprint photo URLs; images finish loading in both themes.
- Middleware: 62 focused avatar, decision, sprint and route checks passed.
- Brief deep audit: 34 cases, zero findings, zero unclassified policies.
- Decisions deep audit: 24 cases, no resting-layout findings; one keyboard-focus
  finding remains (DOC-AUDIT-03 below), with zero unclassified policies.

Evidence: `.scratch/section-navigation-2026-11-01/` (browser traces/screenshots,
check logs and `audit-brief` / `audit-decisions` reports). Browser checks block
business writes and use isolated cloned sessions.

### Portrait coverage

**PEOPLE-01 is closed for the seeded demo cast.** All 71 identities now have
registered synthetic photographs: the existing 19, Rhea's individual portrait,
and 51 portraits generated in one grid request and sliced into separate JPEGs.
The grid's native output was 1341 × 1173; its inspected cells yield 160–164px
square avatars without upscaling. Existing portraits are unchanged.

`portal/public/avatars/photos/personas.json` owns identity-to-photo mapping.
`node scripts/avatars/generate-local.mjs` derives the portal and middleware
indexes together. Its `--check` mode catches stale indexes, identity/name drift,
missing files and invalid paths; fixture tests require an individual JPEG for
every seeded identity. Unknown accounts and the empty fixture retain initials.
The grid prompt and crop provenance are retained in
`scripts/avatars/prompts/2026-11-01-grid.txt` and
`scripts/avatars/portraits-2026-11-01.json`.

Decision, design, initiative work-row and sprint steward photo wiring now use
already-authorized identities. No name-based global photo lookup was added.

### Technical debt retained

- **DOC-AUDIT-01 — code diff audit profile.** The previous proposal audit's
  10,066 findings include collection-table rules misapplied to code-diff rows,
  plus genuine review contrast, small controls, inline prose and spacing issues.
  Define a narrowly evidenced code-diff profile with valid/broken fixtures;
  retain ordinary table checks. Re-run proposals before calling that family clean.
- **DOC-AUDIT-02 — command help alignment.** Four 4px runbook command-help
  alignment findings remain. The loading row changed after that audit; it needs
  confirming evidence. Prior report paths are retained above.
- **DOC-AUDIT-03 — command composer keyboard focus.** The Decisions deep audit
  found no visible focus indicator on the `Decisions command` contenteditable
  textbox (`collection-command-input-input`) at Tab 18, light theme, 1440px.
  Fix the compact command composer in the shared UI owner, add a keyboard-focus
  story/assertion, release the real archive and rerun the focus walk. Report:
  `.scratch/section-navigation-2026-11-01/audit-decisions/report.json`.
- **PEOPLE-02 — stable authorship IDs.** Design posts and sign-offs carry names,
  not canonical person IDs. Unique authorized contributor matching repairs
  available portraits now; namesakes and outside contributors intentionally
  remain unresolved. Add person IDs to storage/wire contracts and migrate old
  authors before extending photo resolution. The initiative table's team column
  also receives `smeNames` without SME IDs/photo URLs; it intentionally remains
  unresolved until the summary contract supplies stable identities. Sprint
  steward and initiative work-row photo propagation are repaired in this change.
- **PEOPLE-03 — deployed avatar records.** Local demo assets and fixture mappings
  are complete. On the deploy machine, upload the portal assets and reconcile
  seeded `people.avatar_url` / unlinked `app_users.avatar_url` by canonical ID.
  Preserve real users' existing photos. No Aurora backfill or AWS rollout was
  performed here.
- **PERF-01 — portal entry bundle.** The production build passes but retains
  Vite's large-chunk warning: the main entry is 4.31 MB (1.30 MB gzip). Profile
  initial-route dependencies and split the heavy entry; do not raise the warning
  threshold to hide it.
- **JOURNEY-01 — refresh after UI source changes.** Earlier sealed journey
  acceptance belongs to its recorded UI revision. This release does not renew
  every journey's source digest. Budget choices and AWS deploy-machine items
  remain in `local-backlog-goal-2026-10-28.md`; no cloud rollout is claimed.


### Audit closure — 2026-11-02

DOC-AUDIT-01, DOC-AUDIT-02 and DOC-AUDIT-03 are now closed for their reported
Work surfaces. ui-components 2.499.4 supplies measured diff/procedure/control
profiles, readable review labels, inline prose flow and consistent spacing.
Proposals pass 24 deep cases and runbooks 25, with zero findings and zero
unclassified policies. The delayed contents-list race was reproduced and fixed
in the consumer. Composer keyboard focus was verified in both themes on Runs,
Designs and Decisions. See [the current TODO](work-social-ui-todo.md) and
[runbook validation](runbook-review-followup-2026-11-02.md); earlier failures above
remain historical evidence. Deployment and broader journey work remain open.
