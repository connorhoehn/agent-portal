surface: session-config
role: program-owner
user: u-mia (Mia Singh, p-030); confirmed via GET /api/session/me (sub u-mia, tenant orgiq, role program-owner) before the surface
url: /iq/release
pages: portal/src/pages/release
audited: 2026-09-05 20:18 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: session-config.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; not an L surface (the Bundled skills table's first row sits at 515px under one 4-tile stat strip and the Hooks card); no nested rail; no horizontal scroll (1552/1552)
keyboard: pass — 20 tabbable (no tabindex -1; the main region contains no interactive control at all for this role — the 20 are ⌘K, the account menu and the rail), all 20 reached in one 26-Tab sweep with nothing missing on the diff; hook, skill and setting rows are read-only text
empty-state: n/a — no search or filter on this page
role-gating: program-owner reads the live bundle (v12, published Aug 27 by Eli Garcia, 3 skills, DRIFT "1 skill stale"), the Hooks card, the Settings block and the pending bundle "sb-2026-09-refresh" (prepared by Layla Hassan · 20h ago); the "Publish to fleet" button sme saw is absent from the DOM (main has zero buttons) and the page states why in one line under the pending bundle: "Publishing this bundle needs Manage devbox." (ManageDevbox is false for this role)
notes: The page is honest about the gate, but the person it names as able to publish is nowhere on the page — a program owner reading "1 skill stale" and "Pending — sb-2026-09-refresh … would affect 0 sessions on publish" cannot hand it to anyone from here. The page description says "Claude Code devbox session" and the Settings block lists ANTHROPIC_MODEL us.anthropic.claude-haiku-4-5… — accurate for the devbox exception in CLAUDE.md.
