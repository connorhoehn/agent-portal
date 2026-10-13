# approver walk defects — re-walk 2026-10-13 15:55–15:59 (u-omar, ui-components 2.442.3)

Failing a log:
1. request.md — once a request is provisioned (req-0002), its Audit row "Provisioned" reads "Expires 2026-11-12T19:58:07.706Z", a raw ISO timestamp written by `middleware/src/lib/access-provision.ts:205`, under a summary that says "Expires Nov 12, 2026".
2. policies.md — on `/access/policies/:id` the list rail's h2 "Policies 4" is 12/600 while its sibling group headings "Blocking" / "Warning" are h3 14/600; the type-scale sweep records `siblings rail 12|14` for the route with no burn-down row.

Fixed and verified this walk: the justification ("Why") wraps and reads in full; the policy record page is on the scale (20/600 title, 14/600 record heading, no 18/400 or 13px text); approve on step 1 of req-0001 recorded, replay 409.

Mock: my write (step 1 of req-0001 approved at 15:56:57) was reset at 15:59:37.
