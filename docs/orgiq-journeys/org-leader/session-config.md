surface: session-config
role: org-leader
user: u-vera (Vera Green); re-checked GET /api/session/me on arrival (sub u-vera, tenant orgiq, role org-leader)
url: /iq/release
pages: portal/src/pages/release
audited: 2026-09-05 20:22 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: session-config.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; not an L surface (no first-row-top rule; for reference the first Bundled-skills row sits at 515px under one description line, one 4-tile stat strip and the Hooks card); the Settings card and the Pending bundle card follow below the fold; no horizontal scroll (1552 = 1552)
keyboard: pass — 26 tabbable (all in the shell — the page body has no interactive control for this role), all 26 reached in one 60-Tab sweep with nothing missing on the diff; the hook command "lab recall" is rendered as static text, not an editable input, so there is nothing to trap focus
empty-state: n/a — no filter or search on the page; every stat tile reads a real value (LIVE VERSION v12 · SESSIONS AFFECTED 0 · BUNDLED SKILLS 3 · DRIFT 1 skill stale)
role-gating: org-leader can read the live bundle (hooks, three bundled skills with stale/current status, the four settings) and the pending "sb-2026-09-refresh" bundle prepared by Layla Hassan; the publish control is absent from the DOM and replaced by the sentence "Publishing this bundle needs Manage devbox." (ManageDevbox false for this role) — the gated action is explained, not silently missing
notes: The page answers "what is the fleet running and is it drifting" in one strip ("DRIFT 1 skill stale" — Triage a flaky test v2 live vs v3 pending). A person in this role notices the rail group is named RELEASE and the release manager cannot release: the only write on the page needs Manage devbox, which Cedar gives to sme and hr-admin but not org-leader — consistent with `org-leader.cedar`, but it makes "Session config" a read-only surface for the role the operating model calls the release manager (not filed; a role-design question, not a page defect). The Settings card shows `ANTHROPIC_MODEL us.anthropic.claude-haiku-4-5…` — the documented devbox-only Bedrock exception, correctly labelled as such by the page's own first line.
