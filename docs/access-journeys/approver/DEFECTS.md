# Approver walk defects — re-walk 2026-10-13 (u-omar)

None of the eight surfaces fails. The three defects of the first walk (request-record console 400, second h1 on the wizard, audit events for an unreadable request) no longer reproduce.

Observations that are not failures:
- GET /api/access/configuration answers 200 to the approver (ViewAccess); the UI hides the page and the write is 403.
- The audit scope notice sits in the header description / “About these results” popover, not as a visible line.
- “Recorded: approve on step 1.” reads “approve”, not “approved”.
- `show work catalog items` echoes the tenant key (“Filter: orgiq.”).
- The wizard's policy pre-check evaluates the approver's grants, not the report's; a non-report beneficiary is only reachable by API (refused 403).
- Shared mock: other lanes' writes (a Rhea-filed req-0007, sod-001 policy toggles) showed up mid-walk.
