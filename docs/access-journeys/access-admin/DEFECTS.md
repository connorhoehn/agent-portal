# access-admin walk defects (re-walk 2026-10-13 14:52–15:01, u-priya, ui-components 2.442.2)

Open, failing a log:
1. **Expiry in the future reads "just now"** (request.md). After req-0002 was approved and provisioned, the record's summary showed `Expires just now` while the API's `expiresAt` was 2026-11-12. `RequestRecordPage.tsx:240` renders it with `relativeTime`, which has no future branch (`portal/src/lib/relativeTime.ts`: a negative difference falls into `mins < 2`). Any active grant with a fixed duration shows it.

Open, not failing a log:
2. The policy record page (`/access/policies/sod-001`) renders the record's own title "Spend and allocate" at 18/400 and the list-rail rows at 13px, off the 20/14/12 scale. `/access/policies/:id` is not in `portal/e2e/route-inventory.ts`, so no sweep measures it.
3. An audit `policy-updated` row opens `/access/policies` (the list), not the policy's own record page, now that one exists (`accessRequests.ts:259`).
4. The review record's trail stops at "Govern › Reviews" and does not name the campaign; the request and policy records name theirs.
5. The wizard's "Who" step still cannot name an arbitrary person (only reports with a request on file), while the API lets an access admin file for anyone (from the previous walk; not re-probed).
6. The SoD override control is still unobservable: a blocked request cannot be filed, so no record renders it.

Checked and fine this walk: policies open as a record page with Save there (no drawer); catalog rows open the wizard for the item; the wizard's radios are 14/500 labels with 12/400 descriptions; the request record's section headings are 14/600; Save on policies writes a `policy-updated` event; Configuration Save/restore; review Keep with a 409 on replay.

Not exercised: the toolbar swapping its controls when rows are selected — none of the access tables offers row selection (0 row checkboxes on catalog, requests, policies, reviews, audit).

Environment: another lane reset the mock at about 15:00:08 mid-walk (the audit page's first pass read 22 events while the API read 15); the logged audit pass was re-walked after it. My own reset: 15:01:13.
