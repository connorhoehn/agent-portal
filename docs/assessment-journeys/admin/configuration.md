surface: configuration
role: admin
user: u-operator
url: /assessment/configuration
pages: portal/src/pages/assessment/ConfigurationPage.tsx
audited: 2026-09-05 07:44 local, Chrome 1440px, gateway mode (VITE_GATEWAY_URL=http://localhost:18080), middleware dev:mock
screenshot: configuration.jpg
verdict: pass
console errors: 0 — checked on initial load and a genuine full-navigate reload
layout: pass — content col left 200px w 1272px; scrollWidth 1472 = innerWidth 1472 (no horizontal scroll); body scrollHeight 845 = innerHeight 845
keyboard: pass — 28 interactive controls (Target level select, 9 cohort-motion text inputs, Save, plus rail/nav); all native and enabled for admin.
empty-state: n/a — always has fixture content; nothing here has an empty state.
role-gating: the protocol calls this surface "program-lead only; other roles: what they see instead" — admin, the cross-tenant wildcard, also has full write access here (same as program-lead): the Target level select and all 9 cohort text inputs are enabled, and "Save" is present and enabled. Configuration is also visible in admin's rail (SYSTEM group), unlike assessor/lead-assessor where it is absent.
notes: Did a real end-to-end write test. Changed Target level from Level 3 to Level 4 via the native select, clicked Save — "Configuration saved" toast fired — then did a full page navigation to `/assessment/configuration` and confirmed the select still read "Level 4" (value="4"), proving a genuine server-side persist, not client-only state. Set it back to Level 3, saved again — "Configuration saved" fired a second time and the select shows "Level 3" — restoring the pre-audit value. Cohort motions section (White Glove/HIGH-TOUCH/#141C7C, Self-Service/GUIDED/#2E5BFF, General/STANDARD/#5B6472) left untouched, renders identically to the program-lead pass.
re-verified 2026-09-05 07:44 (gateway mode): console 0, layout main left 200px w 1240px / scrollWidth 1440 = innerWidth 1440 / body scrollHeight 758 = innerHeight 758 (no scroll), screenshot retaken; 28 interactive controls (unchanged); spot-checked keyboard — Target level select and all 9 cohort inputs remain enabled and reachable. Target level still "Level 3" — no stray writes from other roles' passes leaked in. Re-audit 2026-09-16 05:40: The configuration GET is a useFetch read (abort on unmount, error/degraded branches); the PUT stays an explicit write. Code-verified. Console errors 0.
