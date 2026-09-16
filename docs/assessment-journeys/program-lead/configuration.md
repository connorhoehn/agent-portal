surface: configuration
role: program-lead
user: u-farah
url: /assessment/configuration
pages: portal/src/pages/assessment/ConfigurationPage.tsx
audited: 2026-09-05 07:31 local, Chrome 1440px, gateway mode (VITE_GATEWAY_URL=http://localhost:18080), middleware dev:mock
screenshot: configuration.jpg
verdict: pass
console errors: 0 — checked on both a fresh navigation and a genuine `location.reload()`-equivalent (full navigate) after saving; the "missing key" React warning from assessor/DEFECTS.md #6 / lead-assessor's copy did not reproduce, consistent with both roles' later re-tests marking it Closed.
layout: pass — main left 200px w 1272px; scrollWidth 1472 = innerWidth 1472 (no horizontal scroll); body scrollHeight 845 = innerHeight 845
keyboard: pass — 28 visible interactive controls (Target level select, 9 cohort-motion text inputs, Save, plus rail/nav); all native and enabled for this role.
empty-state: n/a — program-lead-only page always has fixture content to show; nothing here has an empty state.
role-gating: program-lead is the ONLY role with "Configuration" in the rail's SYSTEM group (confirmed absent for assessor/lead-assessor navs in their own passes) and is the only role that can write here — the Target level select and all 9 cohort text inputs are enabled (not disabled), and "Save" is present and enabled, unlike assessor's read-only rendering of this same page.
notes: |
  Did a real end-to-end write test as required: changed Target level from Level 3 to Level 4 via the native select, clicked Save — a "Configuration saved" toast fired — then did a full page navigation (equivalent to reload) to `/assessment/configuration` and confirmed the select still read "Level 4", proving the write is a genuine server-side persist, not client-only state. Then set it back to Level 3, saved again, and reloaded once more to confirm it returned to the original value — the setting is restored to its pre-audit state.

  Cohort motions section (White Glove/HIGH-TOUCH/#141C7C, Self-Service/GUIDED/#2E5BFF, General/STANDARD/#5B6472) was left untouched — not part of the required test — and renders identically to the read-only copy assessor saw, just editable here.
re-verified 2026-09-05 07:31 (gateway mode): console 0, layout main left 200px w 1240px / scrollWidth 1440 = innerWidth 1440 / body scrollHeight 758 = innerHeight 758 (no scroll), screenshot retaken; spot-checked keyboard — Target level select and the 9 cohort-motion inputs remain enabled native controls, Tab moves focus through them in order; 28 interactive controls counted (unchanged). Target level still reads "Level 3" (the pre-audit value the earlier pass restored) — no stray write persisted. Re-audit 2026-09-16 05:40: The configuration GET is a useFetch read (abort on unmount, error/degraded branches); the PUT stays an explicit write. Code-verified. Console errors 0.
