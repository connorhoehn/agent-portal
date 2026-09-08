surface: configuration
role: assessor
user: u-asha
url: /assessment/configuration
pages: portal/src/pages/assessment/ConfigurationPage.tsx
audited: 2026-09-05 07:57 local, Chrome 1440px, gateway mode (VITE_GATEWAY_URL=http://localhost:18080), middleware dev:mock
screenshot: configuration.jpg
verdict: pass
console errors: 0 — confirmed on both a fresh navigation and a genuine full navigate/reload; the "missing key" React warning (DEFECTS.md #6) did not reproduce on either pass. This closes DEFECTS.md #6.
layout: pass — content col left 200px w 1272px; scrollWidth 1472 = innerWidth 1472 (no horizontal scroll); body scrollHeight 845 = innerHeight 845
keyboard: pass — 26 interactive elements; the "Target level" select and 9 cohort-motion text inputs are native, correctly disabled (`disabled: true` confirmed via DOM, not merely styled) rather than removed, consistent with the visible "read-only for your role" banner.
empty-state: n/a — program-lead-only page always has fixture content to show; nothing here has an empty state.
role-gating: what assessor gets: the page reaches it directly via URL (still NOT in assessor's nav rail — confirmed absent from this pass's own rail screenshot, same as before), renders every field read-only with the blue banner "Only a program lead can change these settings — everything below is read-only for your role", and has no "Save" button in the DOM (confirmed `saveExists: false` via querySelector) — the `canManage` gate correctly hides both the write controls and the mutation affordance for this role. Target level correctly reads "Level 3" (the value program-lead's pass restored it to after testing Level 4), confirming this role sees the real, current, shared configuration state, not a stale cache.
notes: This re-audit closes assessor/DEFECTS.md #6 — not reproducible on this pass. Otherwise identical to the original assessor pass: well-designed gated view (read-only render + explanatory banner rather than a 403 or hidden page).
re-verified 2026-09-05 07:57 (gateway mode): console 0, layout main left 200px w 1240px / scrollWidth 1440 = innerWidth 1440 / body scrollHeight 758 = innerHeight 758 (no scroll), screenshot retaken; 26 interactive controls counted; spot-checked keyboard — "Only a program lead can change these settings" banner still present, all fields still disabled (read-only) for this role. Target level unchanged at "Level 3", cohort motions unaffected by other roles' passes.
