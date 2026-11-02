# Social collection controls

The Chat rail no longer advertises Browse hangouts on unrelated destinations.
Hangouts remains in primary navigation. New message stays in the conversation
rail; the Hangouts directory retains its own parent/back and overflow navigation.
Calls retains Call someone because choosing a person is the next step in that
task. Message/Call actions on Contacts remain tied to the selected person.

Contacts now keeps its presence count and portraits in the filter row. Collection
page trails use the compact inset, reducing the gap before the title and roster.
Search, filters and Refresh share one control group through the library owner.
The Calls All/Missed filter uses the corrected intrinsic SegmentedControl width;
explicit full-width controls remain available elsewhere.

Shared owner: ui-components source `98dc0338`, packed release 2.498.1. The portable
audit now rejects stretched content-width segments and Refresh actions stranded
outside their query controls. Semantic cross-context action review is documented
in the same shared skill, available to both Codex and Claude through the existing
links. No frontend-only control CSS or copied component implementation is added.

Remaining debt: context relevance cannot be reliably inferred from an action's
label or click handler. Continue the explicit action inventory when adding new
collection/rail headers; preserve contextual record actions and parent links.
The existing joined-channel transcript inset audit item in ui-components-queue.md
remains separate from this collection-layout change.

Validation: 13 navigation/embedded-chat browser cases, four populated Calls cases
(light/dark at 1440/900px, including keyboard selection), the cloned-session
Contacts behavior/geometry check, and six audit-readiness checks passed. The
Contacts deep sweep passes 36 cases with zero findings and zero unclassified
composer policies. Calls, Channels and Teams add 12 passing resting-state cases
across both themes and widths. Its first run found raw error copy, a table-only readiness
assumption and theme comparisons opening different people as presence reordered
the roster; all three were corrected and the same matrix rerun. Portal typecheck
passes. All 339 installed distribution files match the packed archive; the app
was restarted and rendered the new shared component markers.

Archive SHA-256: `afd52a500fd57b2f96b51a166d5b2644f1e8078e11e5aa7ddcd349e32d2087ba`.
Library release commit: `25f6c776`.
