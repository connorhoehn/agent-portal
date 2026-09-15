surface: session-config
role: member
user: u-theo
url: /iq/release
pages: portal/src/pages/release
audited: 2026-09-15 11:20 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-audit after the page went table-first — the Bundled skills table now sits directly under the stat strip with Hooks and Settings below it — and the publish gate copy changed; signed in as u-theo via /select → Sign in as → Theo Chang; every field re-observed)
screenshot: session-config.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px; not an L surface (no first-row-top rule), but the Bundled skills table's first row now sits at 372px (was 515px) directly under the H1, one description line and the 4-tile Live-bundle strip (Live version / Sessions affected / Bundled skills / Drift); the Hooks card and the Settings card follow the table, and the Pending bundle card sits last; no nested rail; no horizontal scroll (scrollWidth 1692 = innerWidth 1692)
keyboard: pass — 19 tabbable controls and all 19 accept focus (`.focus()` walk); no Publish control for this role — the gate line reads "Publishing this bundle needs Manage devbox — an SME or HR admin can publish it from this page."
empty-state: n/a — a fixed report of the live bundle with no filter, search or id-addressable detail route
role-gating: member sees the live bundle (v12, session-start hook, 3 bundled skills with per-skill drift, the raw settings dump) and the pending draft bundle read-only; the page states "Publishing this bundle needs Manage devbox." in place of a publish button — the explained-gate pattern the other surfaces should copy
notes: the Drift tile's "1 skill stale" and the table's "stale" badge on "Triage a flaky test" agree, so the answer the page exists for is visible without scrolling. The settings dump still shows the devbox's ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL keys — existing devbox configuration being displayed, not a suggestion. Re-audit 2026-09-15 11:20: table-first now — first skill row at 372px. The gate no longer dead-ends: it names who can publish ("an SME or HR admin can publish it from this page"), the same shape Knowledge uses for its Manage KB gate. Console errors 0.
