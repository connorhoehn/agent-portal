# requester walk defects, 2026-10-13 (not fixed; walk only)

D1. Page title renders 14px/600, not the documented 20/600 (docs/layout-cascade.md, type-scale-sweep.spec.ts). Every access surface measured by h1 computed style at 1680x940 and 1680x1300; /pipelines/runs as u-ines is also 14px/600, so this is platform-wide (shell density), not access-specific. Affects layout/type of catalog, requests, new-request, request, policies, reviews, audit.

D2. Every readable request record (req-0001, 0002, 0005, 0008) logs a console error on arrival: GET /api/conversations/agent/waiting?channel=access%3Areq%3A<id> -> 400. RequestRecordPage.tsx / the discussion pane asks the agent-waiting endpoint for a channel it rejects.

D3 (minor). Request record text sizes 13/400 (x12) and 11/400 (x3) are off the 12/14 scale; new-request has one 20/600 text node that is not the h1; new-request title is indented to left 264 where the list pages start at 224.

D4 (minor). Escape on the catalog Filters popover returns focus to the page container, not the Filters button.
