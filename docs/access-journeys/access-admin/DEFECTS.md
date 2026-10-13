# access-admin walk defects (re-walk 2026-10-13, u-priya, ui-components 2.441.8)

Open: none that fails a log. Verified fixed since the first walk:
- Request record no longer logs a 400 (`GET /api/conversations/agent/waiting` answers 200); 0 console errors on every record.
- Policy Save writes a `policy-updated` audit event (actor, before/after severity, reason change) and the Audit page lists it.
- Configuration has real GET/PUT routes; Save works for access-admin with a success toast; invalid input answers 400.
- A step with no eligible decider shows an "escalated" chip and its reason (req-0007: platform admins; req-0002 step 2: access admins).
- Reviews are a real collection: seeded rev-0001, New campaign (rev-0002 created), record with Keep/Revoke, a decided item (409 on replay).
- Page titles measure 20/600 again.

Still true, not failing a log:
1. The wizard's "Who" step cannot name an arbitrary person (only people who already have a request on file), while `POST /api/access/requests` lets an access admin file for anyone (201 for u-theo).
2. The SoD override control could not be observed: a blocked request cannot be filed (409), so no record ever renders it. `POST .../sod-override` on a clear request answers 409 as designed. Revoke was observed (req-0004, req-0002 after approval) but not clicked.
3. On a review record the composer phrase is `search review items for <name>`; `search items for <name>` searches the whole string literally.
4. During the first pass of the audit surface the page read 20 events while the API read 15 moments later; the re-walk agreed (17 = 17). Probably another lane reset the mock mid-walk, not a page defect.
