surface: configuration
role: lead-assessor
user: u-jonas
url: /assessment/configuration
pages: portal/src/pages/assessment/ConfigurationPage.tsx
audited: 2026-09-05 08:10 local, Chrome 1440px, gateway mode (VITE_GATEWAY_URL=http://localhost:18080), middleware dev:mock
screenshot: configuration.jpg
verdict: pass
console errors: 0 (checked on initial navigation and again after a full location.reload() — the "missing key" React warning from assessor/DEFECTS.md #6 did not reproduce here on either load; appears fixed since that pass)
layout: pass — content col left 200px w 1272px; scrollWidth 1472 = innerWidth 1472 (no horizontal scroll); body scrollHeight 845 = innerHeight 845
keyboard: pass — 26 interactive elements, identical to the assessor count; the "Target level" select and 9 cohort-motion text inputs are all confirmed disabled via the DOM (element.disabled === true, not merely styled), consistent with the read-only banner.
empty-state: n/a — program-lead-only page always has fixture content; nothing here has an empty state.
role-gating: lead-assessor (a program-lead-only surface) reaches this page directly via URL — it is NOT in the lead-assessor's nav rail (confirmed absent from document.body's nav links) — and sees every field rendered but disabled, plus the same explicit banner assessor sees: "Only a program lead can change these settings — everything below is read-only for your role." No Save button in the DOM.
notes: Identical page and identical gating to the assessor pass — lead-assessor's extra authority (exceptions, publish) does not extend to configuration, matching the CLAUDE.md contract that only program-lead can edit it. The console error assessor found here is gone on a hard reload, so it appears to have been fixed since that audit.
re-verified 2026-09-05 03:38: console 0, layout content col left 200px w 1272px / scrollWidth 1472 = innerWidth 1472 / body scrollHeight 845 = innerHeight 845 (unchanged), screenshot retaken (Target level correctly reads "Level 3" — matches the value the admin pass restored it to earlier in this session); spot-checked keyboard/gating programmatically — `select.disabled === true`, all 9 cohort inputs `.disabled === true`, no "Save" text anywhere on the page.
re-verified 2026-09-05 08:10 (gateway mode, freshness re-sweep after a subsequent portal edit): console 0, layout main left 200px w 1240px / scrollWidth 1440 = innerWidth 1440 / body scrollHeight 758 = innerHeight 758 (no scroll), screenshot retaken; 26 interactive controls; read-only banner and disabled fields unchanged for this role.
