surface: session-config
role: program-owner
user: u-mia (Mia Singh, p-030); confirmed via GET /api/session/me (sub u-mia, tenant orgiq, role program-owner) before the surface
url: /iq/release
pages: portal/src/pages/release
audited: 2026-09-15 11:20 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-audit after the page went table-first — the Bundled skills table now sits directly under the stat strip with Hooks and Settings below it — and the publish gate copy changed; signed in as u-mia via /select → Sign in as → Mia Singh → Org → Program Owner; every field re-observed)
screenshot: session-config.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px; not an L surface (no first-row-top rule), but the Bundled skills table's first row now sits at 372px (was 515px) directly under the H1, one description line and the 4-tile Live-bundle strip (Live version / Sessions affected / Bundled skills / Drift); the Hooks card and the Settings card follow the table, and the Pending bundle card sits last; no nested rail; no horizontal scroll (scrollWidth 1692 = innerWidth 1692)
keyboard: pass — 20 tabbable controls and all 20 accept focus (`.focus()` walk); no Publish control for this role — the gate line reads "Publishing this bundle needs Manage devbox — an SME or HR admin can publish it from this page."
empty-state: n/a — no search or filter on this page
role-gating: program-owner reads the live bundle (v12, published Aug 27 by Eli Garcia, 3 skills, DRIFT "1 skill stale"), the Hooks card, the Settings block and the pending bundle "sb-2026-09-refresh" (prepared by Layla Hassan · 20h ago); the "Publish to fleet" button sme saw is absent from the DOM (main has zero buttons) and the page states why in one line under the pending bundle: "Publishing this bundle needs Manage devbox." (ManageDevbox is false for this role)
notes: The page is honest about the gate, but the person it names as able to publish is nowhere on the page — a program owner reading "1 skill stale" and "Pending — sb-2026-09-refresh … would affect 0 sessions on publish" cannot hand it to anyone from here. The page description says "Claude Code devbox session" and the Settings block lists ANTHROPIC_MODEL us.anthropic.claude-haiku-4-5… — accurate for the devbox exception in CLAUDE.md. Re-audit 2026-09-15 11:20: table-first now — first skill row at 372px. The gate no longer dead-ends: it names who can publish ("an SME or HR admin can publish it from this page"), the same shape Knowledge uses for its Manage KB gate. Console errors 0.
