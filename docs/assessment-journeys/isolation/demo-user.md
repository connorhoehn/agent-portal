role: demo-user (cookie-less fallback identity, dev only)
user: demo-user
audited: 2026-09-05 07:15 local, Chrome 1512px, middleware dev:mock
scenario: the original report — "a sme shouldn't see the assessment pages" — reproduced on the demo path, not a seeded user
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
picker-before-choice: all 3 workspaces / 13 roles offered (permissive demo identity)
after Assessment · Program Lead: session grants {assessment:[program-lead]}, rail = the 4 assessment groups only, /api/session/me tenant=assessment role=program-lead
after Org · SME (from the same picker, no sign-out): session grants {orgiq:[sme]}, landed on /iq/work, rail has zero /assessment anchors
api-status: 403                    # fetch /api/assessment/teams as the demo SME
direct-route-result: redirect      # /assessment/teams → /iq/projects ("Initiatives")
picker-after-choice: still offers all 13 personas (from `switchable`), while the session itself stays narrowed — a demo can move between personas without signing out
verdict: pass
notes: Two fixes made this true. (1) demoScopedGrants narrows the demo cookie to the persona it picks (before, "demo as SME" kept every tenant's grants — the reported leak). (2) switchableGrants validates the picker's two-step /tenant → /role against what the persona may become, and /me exposes it as `switchable` so the picker keeps offering every persona; without that the demo dead-ended at one tile with Sign out as the only way back. Real users are unaffected: their `switchable` equals their grants.
