# access-admin walk defects (2026-10-13, u-priya)

1. Request record page: `GET /api/conversations/agent/waiting?channel=access:req:<id>` answers 400 on every record load, a console error each time (req-0001, req-0002, req-0007). Fails `request.md`. The agent-waiting probe does not accept the `access:req:` channel.
2. Saving a policy (`PUT /api/access/policies/:id`, 200) writes no audit event: `/api/access/audit` stays at 15 events with none of kind policy-*, although the Audit Event filter offers "Policy updated".
3. `/access/configuration` copy still says "Read-only in lane A0" (page notice and Save tooltip) after A1 landed. Cosmetic, matches the page's intent of read-only.
4. Wizard "Who": access-admin sees "Someone who reports to me" with no way to pick an arbitrary person, while `POST /api/access/requests` lets an access admin file for anyone (201 for u-theo). The UI cannot do what the API allows.
5. A step whose eligible list is empty ("No one is eligible yet", req-0007's Steward step for Operator in Pipelines) leaves a request waiting on nobody; no surface tells the admin.
6. Protocol drift, not a page defect: titles measure 14/600 (compact density, same on /pipelines/*), not 20/600; the discussion composer is live, not disabled.
