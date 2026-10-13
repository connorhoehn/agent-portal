# Approver walk defects — 2026-10-13 (u-omar)

1. request.md — Every request record load logs a console 400: `GET /api/conversations/agent/waiting?channel=access:req:req-<id>` is refused (RequestRecordPage.tsx composer/conversation owner). Reproduces on req-0001, 0002, 0003, 0007 and on every list-row open.
2. new-request.md — Two `<h1>` on /access/requests/new: the page title (14/600) and the step PageSection title (20/600, “Who is it for?”). The only 20px text in the tenant; type oscillates 14 → 20.
3. audit.md — An approver sees audit events for req-0004 (Nora Kessler, outside his read rule); the row opens a “Request not found” page. The scope notice is only inside the “About these results” popover.
4. Observations, not failed verdicts: page titles render 14/600 on every route (also /pipelines/approvals) against the protocol's 20/600; the wizard's policy pre-check reads the approver's own grants, not the report's; “Recorded: approve on step 1.” copy; `show work catalog items` notice reads “Filter: orgiq.”; `PUT /api/access/policies/*` returns 403 before validating the id; GET /audit ignores an unknown `event`; no configuration API exists server-side.
