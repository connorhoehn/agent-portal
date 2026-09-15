surface: local-compute
role: program-owner
user: u-mia (Mia Singh) — GET /api/session/me on this surface: sub u-mia, tenant orgiq, role program-owner
url: /iq/local-compute
pages: portal/src/pages/local-compute
audited: 2026-09-15 08:22 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (first audit of this surface)
screenshot: local-compute.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px; breadcrumb "Build › Local compute"; no horizontal scroll (scrollWidth 1692 = innerWidth 1692). Not a list surface for this persona: the page is the title, one description line and the empty state
keyboard: pass — 20 tabbable controls and all 20 accept focus (`.focus()` walk asserting `document.activeElement`); no dialog for this role
empty-state: pass — "No paired machines / Pairing a machine needs the ConnectLocalCompute capability; ask a platform operator to pair one for you." — the gated copy, with no button, rather than a call to action that would 403
role-gating: program-owner is the one org role whose Cedar seed does NOT list ConnectLocalCompute (member, sme, org-leader and hr-admin all hold it, and the route test uses program-owner as the negative case on purpose), so the page hides "Pair a machine" and says why; GET /api/session/capabilities reports ConnectLocalCompute false. Follow-up filed in notes rather than changed here: whether a program owner should be able to pair their own laptop like a member can is a policy call — member.cedar's rationale ("pairing is personal, not fleet authority") reads as if it should apply to every signed-in role. Rail for this role: Initiatives · Budgets · Designs · Promotions · Library · Automate · Distillation · Local compute · Session config · Ask · Explore · Settings
notes: The honest gated state is a clear improvement over the previous copy, which told every role to use a pairing flow that was not on the page. The open question is the policy one above; it needs a decision, not a page change.
