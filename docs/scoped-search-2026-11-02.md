# Scoped Search navigation

Opening `/iq/search?scope=p-llm-platform` now starts with Work. People, Decisions,
Documents and other record types are separate rail choices. All results is one
list in the server's relevance/recent order; it no longer concatenates lists by
type. Explicit `type=all` survives reload and back navigation, and text searches
without an explicit filter still search every type. Counts and pagination describe
the active collection. Empty/error/loading states retain the selected scope.

The initiative file toolbar now says Search initiative instead of Workspace.
The result renderer remains the library RecordResultList; no local row component
or additional nested content panes were introduced.

The live check also found scope expansion following members into unrelated work
and colleagues. People are now terminal nodes in initiative expansion. Scoped
results, related records, counts and graph edges stay within the resulting scope;
workspace-wide search still finds those unrelated records. Provider coverage
checks this boundary and retains the existing permission-filtered search tests.

Shared fixes ship in ui-components 2.499.1 (source e6d7d5a3, release da59b18b):
section headings follow the page title, selected rail counts retain contrast,
compact references fold before squeezing the input, message editors identify
keyboard focus, tooltips dismiss when menus open, and the header menu keeps a
stable border across themes.

Validation:

- 28 search-provider tests and 44 Search model tests passed; portal typecheck
  passed. Six existing Search presentation/navigation cases passed, followed by
  the installed-package scoped navigation and three presentation cases.
- The read-only cloned-session test checks populated Work/People/All, ordering,
  scope, back/reload, empty results, both themes and 1440/900px widths. Work results
  carry the selected initiative's source reference. No business writes occurred.
- The scoped deep audit passes 21 cases, zero findings and zero unclassified
  composer policies: `.scratch/scoped-search-2026-11-02-final/report.json`.
  Four theme/width rest states are covered; interactive/data probes run in the
  light 1440px case. Screenshots are retained beside that report.
- Actual keyboard Tab walks find the Runs, Designs and Decisions inputs in both
  themes and verify a visible outline before and after typing an unsent draft.
- Findings also passes four light/dark 1440/900px resting-state cases, including
  its formerly failing selected count: `.scratch/findings-contrast-2026-11-02`.
- Library gate: 1,028 test files / 11,301 tests passed, two existing skips, lint
  and build passed. All 339 installed distribution files match the archive.
  SHA-256: `759636f92ad563fd51626f1147892eb765a5ee2255302f00c7994b800b5cbad1`.

The historical Search judge's code checks pass. Its schema check was updated to
read the current loader manifest. Journey measurements and ten old sealed walks
remain stale; this work does not claim those historical journeys were re-walked.
The active runbook/code-diff and broader follow-ups remain in
[work-social-ui-todo.md](work-social-ui-todo.md).


## Shared package follow-up

Rechecked against ui-components 2.499.4 after the runbook review repairs:
21 deep cases pass with zero findings and zero unclassified policies across
light/dark and 900/1440px. The report is
`.scratch/scoped-search-2026-11-02-release-verified/report.json`.
The earlier Search provider/model validation remains unchanged.
