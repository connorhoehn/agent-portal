# Approver walk defects — re-walk 2026-10-13 15:03–15:07 (u-omar, ui-components 2.442.2)

Failing a log:
1. **request.md — the justification is clipped, unreadable.** On `/access/requests/req-0001` the summary's "Why" value is a `white-space: nowrap; text-overflow: clip` span (scrollWidth 652 in a 479px box) that ends at the Discussion pane's edge mid-word ("…need to dispatch agent work a"), with no ellipsis, no wrap and no title. It is the field an approver reads first.
2. **policies.md — the policy record page is off the type scale.** `/access/policies/sod-001` renders the record title "Spend and allocate" at 18/400, the record body (id, Holding / Must not hold / Updated / Severity / Why) at 13/400, the list-rail rows at 13/500 and the rail group heads at 11/600; the page also carries two titles (h1 "Policies" and the record title). `/access/policies/:id` is not in `portal/e2e/route-inventory.ts`, so no sweep measures it. (The access-admin walk recorded the title and rail as a non-failing note; the 13px record body is additional.)

Not failing a log:
- The review record's trail stops at "Govern › Reviews" and does not name the campaign.
- The request Discussion pane's empty-state text sits flush against the pane's left edge.
- "Recorded: approve on step 1." reads "approve", not "approved".
- `show work catalog items` echoes the tenant key ("Filter: orgiq.").
- The audit scope sentence lives in the About popover / description, not as a visible line.
- GET /api/access/configuration answers 200 to the approver (ViewAccess); the UI hides the page and the write is 403.
- The wizard's Report select lists only reports who already have a request; the policy pre-check evaluates the approver's grants, not the report's. A non-report is reachable only by API (403).

Checked and fine: policies open as a record page with no Save for the approver (no drawer); catalog rows open the wizard for the item; the wizard's radios are 14/500 labels with 12/400 descriptions; the request record's section headings are 14/600; 409 on decision replay.

Not exercised: collection toolbars swapping controls on row selection — no access table offers row selection to the approver (0 row checkboxes on catalog, requests, approvals, policies, reviews, audit).

Shared mock: my writes (req-0007 filed for Rhea; step 1 of req-0001 approved) were reset by me at 15:05:44.
