surface: computer-lab
role: sme
user: u-nora (Nora DaSilva) — GET /api/session/me on this sign-in: sub u-nora, tenant orgiq, role sme
url: /admin/devbox
pages: portal/src/pages/admin/DevboxPage.tsx
audited: 2026-10-06 12:10 local, headless Chromium 1680x940 (Playwright), Tilt app :5183 / BFF :3001 dev:mock, ui-components 2.413.0, one cookie per role (POST /api/session/login once per role), mock scenarios touched per fixture and restored to default
screenshot: computer-lab.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px (plain Build shell, no nested rail), no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly one <main>; clipped-text sweep clean. h1 "Computer Lab" under the "Build › Computer Lab" trail; one framed lab with a status strip (1 needs you · 1 running · 0 errors), a 300px computers/agents list and the pane area. first-row-top: 323px (observability-1 under the Observability Platform group)
keyboard: pass — document-order `.focus()` sweep (headless): 55 of 57 controls accept focus; the refusals are the disabled send (⏎) button and the +N chip. Computers / Agents are tabs, the list rows are real rows
empty-state: pass — "zzznoexist" in Find computer or agent… leaves the list at "Nothing matches." (checked on the filter box of the lab list); the fleet itself is populated for this role (3 computers, 2 agents) so the "No computers in the lab" pane was not observed here
role-gating: can drive the fleet: "Computer" and "Keys" buttons, Shell and Nudge menus, an instruction box; no "you can see the fleet but not drive it" notice
notes: Simulated shell only ("AgentCore devbox · simulated shell, no runtime attached"). No computer was provisioned or nudged. Screenshot before the keyboard sweep.
