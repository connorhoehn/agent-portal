# Initiatives detail review — 2026-10-28

## Current: revision 4, response component only

**Approved by the user:** `revision-4-response-flow/dispatch.html`, after moving
confirmation into the response box and removing the modal. The user said
“this looks good” and requested a handoff to Claude. See
`docs/claude-code-handoff-2026-10-28-ui.md` from the repository root.

The user rejected revision 5 as excessive drift. Changes must stay within one
named component at a time, preserving the surrounding page. Do not use revision
5's page structure as the next baseline. No production routes were changed.

Current preview: `revision-4-response-flow/dispatch.html`. Only the response
component changes. The four other HTML pages are byte-identical to revision 4;
the dispatch shell, existing CSS, record content, settings, sidebars, discussion
pane and four-stage readiness indicator are preserved. Added CSS selects only
`.request-flow*`. The existing gallery points to this component correction.

The user's requested interaction:

1. Press **1** to request budget (or **2** to take the Save for later branch).
2. Switch from choices to a prefilled, editable message addressed to Sienna.
3. **Enter** replaces the draft with confirmation inside the same response box; **Shift+Enter** adds
   a line. The edited message appears in the confirmation. There is no modal, backdrop,
   or overlay; all request stages remain inside the response component.
4. **Enter** confirms. Escape/back returns to the draft without discarding it.
5. Show completion and the traversed decision path. This remains a local
   prototype; no request or job is sent and funding is not silently granted.

Source: `budget-request-flow.tsx` and its scoped CSS own the new interaction;
`dispatch-response-flow.tsx` preserves the revision 4 page while hosting it.
The ordinary builder defaults to revision 4. For this component preview:

```sh
node portal/prototypes/initiatives-review/build-response-flow.cjs
portal/node_modules/.bin/tsc --project portal/prototypes/initiatives-review/tsconfig.json
node portal/prototypes/initiatives-review/check-response-flow.mjs
open .scratch/initiatives-mockups-2026-10-28/revision-4-response-flow/dispatch.html
```

Validation covers 18 states at 1440/900px, exact surrounding geometry/text,
unchanged baseline styles, four identical sibling pages, keyboard transitions,
blank messages, held Enter, edited-message review, backtracking, and discussion
input isolation. No network calls. This does not certify production behavior.

## Revision 5 — rejected; retained for comparison

The user reconfirmed the **run** page. Its original approved HTML remains byte
identical in revisions 3, 4 and 5. Revision 4 remains available for comparison.

- **Dispatch:** move settings, funding, codebase and the preview-state selector
  into the second sidebar. Put the pending response immediately after the job
  instruction, rather than docking it at the bottom of a sparse settings page.
  Use the installed `ComposerPromptDeck` with an explicit response-surface
  input binding and focus lifecycle. Revision 4 supplied neither, so typing `1`
  on arrival did nothing. Shortcuts now work on arrival and after answers; text
  fields, number inputs and discussion retain ordinary typing. Escape hides,
  Ctrl/Cmd+Down restores, and disabled choices ignore shortcuts.
- **Budget:** select an initiative in the second sidebar; show a single detail
  pane with allocation totals, people/envelopes, and compact automation details.
  All initiatives is a separate overview. Use library avatars, 13px semibold
  names, tabular amounts, and 12px italic Georgia activity metadata. Activity
  ages are illustrative snapshot values. Keep unknown costs visible.
- **Initiative work:** interpret the user's “advicte sprint” as **Active sprint**.
  All open work and Active sprint are sibling initiative views. Status filters
  and sprint funding also live in the sidebar. There are no nested tabs. The
  four open items in this example all belong to its active sprint.

Source: `v5.tsx`, `dispatch-v5.tsx`, `revision5.css`; `v4-pages.tsx` holds reusable
work/discussion components. At that checkpoint, the builder and `check.mjs` targeted 5. `check.mjs` still
records that rejected prototype; use the component check above for current work.
Use `REVIEW_REVISION=4` or `3` with the corresponding archived check if rebuilding
an older gallery. No production route or shared-library package was modified.

Validation: typecheck and 51 measured light-theme states at 1440 and 900px;
zero geometry findings, browser errors or network requests. Keyboard assertions
first reproduce the revision 4 failure, then verify number choices, Enter,
Escape/restore, typed numbers, instruction editing, draft preservation and stale
forecast blocking in revision 5. The overlap audit visits the inline response
through its content ancestor once; standalone composers remain separate roots.
The captured application shell and backend behavior are outside this scope.

## Revision 4 record

The user approved revision 3's **run** page. The builder copies that HTML
unchanged into revision 4, and the check verifies byte equality. Do not redesign
it while iterating on the other pages.

Revision 4 addresses the next review:

- **Work:** expand the second sidebar into the work-status and budget navigator,
  using the installed `RailNavList`. Move the initiative metadata into a sidebar
  disclosure. The main area shows one selected view; opening a work item updates
  the local URL. Remove the duplicate status group controls above/in the table.
- **Discussion:** render the captured messages through the installed `ChatPanel`
  with `postRhythm="chat"` and `alignOwnMessages={false}`. This removes the channel
  post boundaries (12px margin + 12px padding + border). The preview has no
  reaction/pin/forward handlers, so it also no longer reserves an unused action
  toolbar in each message header. Its own `RichChatComposer` is at the bottom of
  the discussion pane. Hiding the pane preserves the draft. No shared library
  source or production discussion route was changed.
- **Budget:** retain the child table's own headings and indentation, but compact
  its rows to approximately 32px, put the unknown-cost note inline, use a single
  automation-reserve line and disclose the calculation explanation. The open
  Auth Migration child section measures 255.5px at desktop width.
- **Sprints:** the second sidebar selects the sprint and its Work or Envelopes
  section. Each section gets the full main area. No table contains another view's
  tabs or work table. All sprints is still a compact overview table.
- **Dispatch:** keep editable settings in the record and one next decision in
  the response area. Offer two relevant actions when funding is absent. The
  explicit **Preview state** selector exercises an illustrative funded state
  and queue confirmation. Changing models invalidates the forecast and disables
  queueing; the example does not pretend to recalculate it. No request, message
  or job leaves the local prototype.

The source for revision 4 is `v4.tsx`, `v4-pages.tsx`, `dispatch-v4.tsx` and `refinement.css`.
`revision3.tsx` and `main-v3.tsx` preserve the earlier compositions. The default
builder at that checkpoint targeted revision 4; `check-v4.mjs` and `check-v3.mjs`
retain the earlier acceptance checks.

Validation covers 39 rendered states at 1440 and 900px, sidebar navigation,
record selection, compact discussion, draft preservation, sprint section
switching, budget disclosure, and dispatch choices. No browser errors or network
requests occurred. This is prototype validation, not certification of the
untouched application shell or production behavior.

## Revision 3 record

Revision 3 responds to the user's review of the interrupted mockup batch.
The compact overview tables were acceptable. The drill-ins needed stronger
hierarchy, readable work titles and identifiers, orderly nesting, an execution
timeline, and a composer that changes with the kind of response requested.

This is a local interactive prototype, not a production implementation. The
existing captures supply the surrounding application shell. The record body
and dispatch response area are replaced with React compositions using the
installed `@connorhoehnslalom/ui-components` 2.481.2 package. No service is
called, no envelope request is sent, and no job is dispatched.

## Decisions

- **Budget hierarchy:** keep initiative figures in the parent row. Place
  envelopes in one indented child section with their own column headings.
  Separate the automation reserve from the people table. Avoid blank cells
  that pretend an envelope is another initiative.
- **Work:** give the title the largest column. Place the unbroken ID, type and
  points below it. Keep owner, agent execution state and cost in fixed columns.
  Put blocking context under the work title. Group headings describe work
  status; the agent column describes execution status.
- **Run:** show the outcome before the execution record. Use the library's
  `WorkflowStepper` for completed stages and a connected chronological list
  with green completion markers. Technical execution steps are disclosed
  within their owning phase. Do not fabricate per-tool billing precision.
- **Dispatch:** keep editable settings in the record. The response area uses
  `ComposerPromptDeck` and replaces the rich editor while a choice is pending.
  Text/number answers use the same area. Switching to discussion restores the
  library `RichChatComposer`, including its preserved draft. Missing funding
  offers a request or a saved draft, not an enabled Dispatch action.
- **Sprint:** retain compact parent rows. Use separate Work and Envelopes tabs
  inside the selected sprint rather than stacking unrelated tables into a
  large, undifferentiated expansion.
- **Money labels:** use “Unassigned” for the amount not assigned to automation
  or envelopes. It is distinct from spend. Derive envelope balances from grant,
  reservation and recorded spend. Spending outside envelopes stays separate;
  unknown costs remain visible and are excluded from the displayed balance.
- **Narrow preview:** fold the captured primary navigation and discussion pane,
  release the primary pane's fixed percentage width, and retain the secondary
  navigation. This is preview composition, not a change to the shared shell.

## Build and verify

From the repository root, with the original gallery captures present:

```sh
node portal/prototypes/initiatives-review/build.cjs
portal/node_modules/.bin/tsc --project portal/prototypes/initiatives-review/tsconfig.json
node portal/prototypes/initiatives-review/check.mjs
open .scratch/initiatives-mockups-2026-10-28/revision-5/dispatch.html
```

The builder adds a revision link to the existing gallery and produces five
self-contained HTML pages. Avatar files are embedded, so the finished pages
do not depend on the development server. Original mockups are retained.

The check uses the `ui-dom-audit` skill's real `measureDOM` collector. Set
`UI_DOM_AUDIT_SKILL` if it is installed outside `~/.codex/skills/ui-dom-audit`.
It measures text overlap, cramped and clipped text, table typography and
containment, identifier wrapping, and response dock clearance. It also checks
nesting, filtering, drill-in navigation, timeline disclosure, tabs, prompt
choices, cap/model changes, mode switching and draft preservation. Screenshots
and `audit.json` are written alongside the HTML.

The acceptance scope is these five light-theme prototypes at 1440 and 900 px,
including scrolled, expanded and dialogue states. Captured navigation controls
and untouched application-shell regions are static reference material, not
certified application behavior. Dark theme and production routes remain
outside this review batch.
