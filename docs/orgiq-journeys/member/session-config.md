surface: session-config
role: member
user: u-theo
url: /iq/release
pages: portal/src/pages/release
audited: 2026-09-05 20:52 local, Chrome 1552px, middleware dev:mock
screenshot: session-config.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; no horizontal scroll (scrollWidth 1552 = innerWidth); one live-version stat strip (Live version / Sessions affected / Bundled skills / Drift), then Hooks, then the Bundled skills table (first row at 515px), then Settings and the Pending bundle — a configuration report, not a worklist
keyboard: pass — 18 controls, all of them shell rail navigation and none with tabIndex -1; `<main>` contains no interactive control at all for this role, and the skill rows are plain text that does not claim to be clickable, so nothing is silently dead
empty-state: n/a — a fixed report of the live bundle with no filter, search or id-addressable detail route
role-gating: member sees the live bundle (v12, session-start hook, 3 bundled skills with per-skill drift, the raw settings dump) and the pending draft bundle read-only; the page states "Publishing this bundle needs Manage devbox." in place of a publish button — the explained-gate pattern the other surfaces should copy
notes: the Drift tile's "1 skill stale" and the table's "stale" badge on "Triage a flaky test" agree, so the answer the page exists for is visible without scrolling. The settings dump still shows the devbox's ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL keys — existing devbox configuration being displayed, not a suggestion.
