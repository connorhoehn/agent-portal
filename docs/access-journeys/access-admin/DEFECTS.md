# access-admin walk defects — re-walk of request.md 2026-10-13 15:57–15:59 (u-priya, ui-components 2.442.3)

Failing a log:
1. request.md — the provisioned grant's Audit row "Provisioned" gives its reason as "Expires 2026-11-12T19:58:07.706Z", a raw ISO timestamp (`middleware/src/lib/access-provision.ts:205`), while the record's summary reads "Expires Nov 12, 2026".

Fixed and verified this walk: an active grant's Expires reads "Nov 12, 2026" (not "just now"); a policy-updated audit row opens that policy's record (`/access/policies/sod-003`, by click and by Enter); the review record's trail names the campaign ("Govern › Reviews › rev-0001 · Q4 SME certification — Work"); approve on step 2 of req-0002 → active, replay 409.

Mock: my writes (req-0002 step 2 approved 15:58:09, req-0007 filed 15:58:45, sod-003 reason edited) were reset at 15:59:37.
