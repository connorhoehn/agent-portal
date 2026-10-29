# Claude handoff — approved dispatch response component, 2026-10-28

Start in `/Users/connorhoehn/Projects/aws-agentcore`.

The user reviewed the final preview, said **“this looks good”**, and asked
Codex to **“hand it off to claude.”** The approved artifact is:

`.scratch/initiatives-mockups-2026-10-28/revision-4-response-flow/dispatch.html`

Codex stops implementation at this handoff. No owned build/test process is left
running. Production integration has not been performed. No request, message,
grant or job was submitted; this is a local interactive prototype.

## Scope and explicit user decisions

The user corrected the scope: **“your really supposed to be only changing
singular components within the page.”** Continue with the approved dispatch
response/composer component, preserving the surrounding page.

Revision 5 was rejected for excessive drift. Do not carry over its relocated
settings, replacement sidebar/navigation, removed discussion pane, relocated
composer, or reorganized budget/sprint pages. Do not turn this into another
page redesign or a batch of unrelated component changes.

The approved preview uses revision 4's page structure: settings, header,
four-stage readiness indicator, discussion pane and composer position remain.
The four sibling HTML pages (`budget`, `work`, `run`, `sprints`) are byte-identical
to revision 4. This preservation is not blanket approval of those designs.
Explicit approvals are this dispatch preview and the earlier run timeline.

## Approved interaction

**All stages stay inside the same response box, including confirmation.** The
user rejected a confirmation modal and said there should not be one. No modal,
backdrop, overlay, or page navigation for this decision.

1. Numbered choices: `1` requests budget; `2` saves for later on a separate branch.
2. Request budget replaces choices with a prefilled, editable message. Example:
   Sienna is the recipient, Nora the holder, and ORG-OBS-11 the work item. These
   are sample values, not production constants.
3. Focus moves to the editor; number keys type normally. `Enter` continues to
   review; `Shift+Enter` inserts a newline. Empty messages cannot advance.
4. Inline confirmation replaces the editor and displays the actual edited
   message. `Enter` or Confirm request confirms; `Escape` or Back to message
   returns to the retained draft.
5. Show completion within the box. A visible path tracks Choose → Draft request
   → Confirm → Done, with completed stages marked. Save for later has its own
   path. Choices route progressively, rather than presenting disconnected prompts.

Holding Enter must not skip confirmation. IME composition must not confirm.
Other controls retain normal keyboard behavior. Switching to discussion restores
its original editor and preserves its draft. Choice/confirmation states have no
rich-text formatting toolbar.

The prototype explicitly says nothing was sent. Confirming a funding request
does not grant funding or queue a job. When integrating, show submission success
only after the real operation succeeds; preserve the existing permission and
funding gates.

## Source and existing integration owners

Under `portal/prototypes/initiatives-review/`:

- `budget-request-flow.tsx` and `.css`: approved flow, inline confirmation,
  progression and focus/keyboard behavior. Styles select only `.request-flow*`.
- `dispatch-response-flow.tsx`: revision 4 host with the response integration,
  existing settings, discussion mode and funding/forecast gates.
- `main-response-flow.tsx`: entry point.
- `build-response-flow.cjs`: preserves revision 4 HTML and original styles,
  replaces its prototype application script, adds only component styles, and
  copies the four other pages unchanged.
- `check-response-flow.mjs`: **current** acceptance checks. `check.mjs` exercises
  rejected revision 5 and is not the current check.
- `README.md`: current scope and historical review record.

The ordinary `build.cjs` defaults to revision 4, not this component variant.
Use `build-response-flow.cjs`. Do not copy the full mock page or captured shell
into production.

Existing production entry points found by source search, not modified:

- `portal/src/pages/projects/InitiativeComposer.tsx`
- `portal/src/pages/project-detail/usePrepareJobDeck.ts`
- `portal/src/pages/project-detail/prepareJobModel.ts`
- `portal/src/pages/ProjectDetailPage.tsx`
- `portal/src/pages/work/workAttentionPrompts.ts`

Read these owners and their current contracts before integrating. Use existing
application data, request services, permissions and UI components; do not invent
endpoints or assume the sample request is wired. The portal consumes
`@connorhoehnslalom/ui-components` 2.481.2. No production route or shared-library
package changed in this UI review.

## Validation and reproduction

Last validation: TypeScript clean; **18 rendered states at 1440 and 900px,
0 findings, 0 browser errors, 0 network requests**. Includes edited-message
review, inline containment, no dialogs/backdrops, held Enter, blank messages,
backtracking, draft persistence, discussion isolation, and stale-forecast gating.

Checks also verify surrounding record/sidebar/discussion geometry and text,
original HTML/style preservation, and identical sibling page files. They use the
real `ui-dom-audit` collector. This does not certify backend behavior, static
captured-shell controls, dark theme, or production routes.

```sh
node portal/prototypes/initiatives-review/build-response-flow.cjs
portal/node_modules/.bin/tsc --project portal/prototypes/initiatives-review/tsconfig.json
node portal/prototypes/initiatives-review/check-response-flow.mjs
open .scratch/initiatives-mockups-2026-10-28/revision-4-response-flow/dispatch.html
```

Evidence beside the HTML: `response-audit.json`, `request-draft-1440.png`,
`request-confirm-1440.png`, `request-done-1440.png`, and 900px counterparts.
Confirmation screenshots show the inline state. The check needs
`~/.codex/skills/ui-dom-audit` or `UI_DOM_AUDIT_SKILL` pointing to that directory.

## Workspace and other work

HEAD at handoff: `873829eb` (`feat(cost): price Claude usage and ledger direct
project runs`). That earlier pricing/ledger batch is committed. UI prototype
source is **untracked**; this document, its CLAUDE.md pointer and the prototype
README update are also uncommitted. Preserve them. Generated `.scratch` artifacts
are local and required by the builder; source alone is not a portable snapshot
bundle. No owned process is being left for Claude to manage.

The earlier approved run timeline is unchanged. Budget/sidebar/avatar/typography
and Active sprint feedback remain separate unfinished design topics. Rejected
revision 5 is not an approved implementation of them. A possible earlier DE-33
follow-up was deferred; no DE-33 code was started during the UI task.

Continue from the accepted component, not the interrupted broad mockup pipeline.
Preserve the shared Tilt stack; no reset, deployment or library release was part
of this work. The general deployment/chassis handoff remains
`docs/claude-code-handoff-2026-10-26.md`; this document governs UI continuation.
