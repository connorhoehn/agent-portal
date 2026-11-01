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
