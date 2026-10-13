# requester walk defects, 2026-10-13 re-walk (14:56–15:03; not fixed, walk only)

Fails a surface:
- request (`RequestRecordPage.tsx`, the summary's description list): the "Why" value is `white-space: nowrap; text-overflow: clip` inside an `overflow: hidden` `<dd>` (scrollWidth 652 > clientWidth 560 at 1680px with the Discussion pane open). The justification — the first thing an approver reads — is cut mid-word ("…against the sp") with no ellipsis, wrap or tooltip. Seen on req-0001 and req-0008.

Minor, still open, not verdict-changing:
- policies record page (`/access/policies/:id`): the h1 stays "Policies" and the policy's own name sits one line lower as the DetailHeader at 18/400, so the page shows two titles; the description list below is 13/400 and the list rail 13/500 · 11/600 · 11/500 — the library's DetailHeader/list-rail sizes, between the 12 and 14 steps (existing burn-down classes). The record route is not in the sweep inventory, so no sweep measures it.
- request record: the audit count pill reads "1 events".
- composer filter notices name the internal value, not the label: catalog "Filter: orgiq." for the Work workspace, policies "Filter: block." for Blocking.
- new-request and the review campaign record: the title row starts at left 264 because a back link takes 224–264.

Fixed since the 07:04 walk: the wizard's radio labels are on the scale (14/500 options, 12/400 hint; were 13/500); the request record's section headings are 14/600; policies open as a record page instead of a drawer; catalog rows open the wizard.
