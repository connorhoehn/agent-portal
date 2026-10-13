# requester walk defects — re-walk 2026-10-13 15:54–15:59 (u-rhea, ui-components 2.442.3; not fixed, walk only)

Failing a log:
- request.md — on a provisioned request (req-0002 after this walk's approvals) the Audit row "Provisioned" shows its reason as a raw machine timestamp, "Expires 2026-11-12T19:58:07.706Z". The server writes it that way (`middleware/src/lib/access-provision.ts:205`, `Expires ${expiresAt}`) and the record prints the reason verbatim, so it disagrees with the summary's "Expires Nov 12, 2026" two rows above.
- policies.md — the policy record page's list rail has sibling headings at two sizes: its h2 "Policies 4" at 12/600 next to the group headings "Blocking" / "Warning" at h3 14/600. The type-scale sweep records it as `siblings rail 12|14` on /access/policies/:id and there is no burn-down row for it.

Fixed and verified this walk: the request's "Why" wraps (two lines, nothing clipped); an active grant's Expires reads an absolute date; the policy record page is 20/600 title, 14/600 record heading, 14/400 values, 12/400 labels (no 18/400 or 13px text).
