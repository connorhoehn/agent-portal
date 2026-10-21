surface: groups
role: assessor
user: u-asha
url: /assessment/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-21 10:00–10:02 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-asha (u-asha-clone-4ca4b34b) with seed persona u-mira as the second context, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-asha-clone-4ca4b34b (a clone of u-asha), tenant assessment, role assessor; grants assessment: assessor; social: participant
screenshot: groups.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=200, y=44, height 847px (primary rail open); content (SectionContent) starts x=500, width 1180px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940; section label "MY TEAMS"; rows: # Checkout Experience Team discussion || # Fraud Detection ML Team discussion || # Northstar Payments Team discussion
keyboard: pass — 2 distinct Tab stops against 4 visible interactive controls (first stops: rail-section-header-toggle, conversation-row); Enter on the first row: unbound row opened the page discussion in the plane (/assessment/communication?group=team%3ATEAM-003)
empty-state: pass — an unknown group id (?group=team:NO-SUCH-TEAM) rendered "Not one of your groups This plane lists your own teams. Open the page itself to read its discussion. Open page"
realtime: n/a — a page discussion's unread arrives through GET /api/discussions/unread (and a bound channel is the chat surface walked in rail.md); nothing live changed on this surface
role-gating: the binding strip is not in the DOM (0 elements, so 0 Bind controls); Bind a Social channel is a ManageChannels holder's, which this role does not hold
open: pass — unbound row opened the page discussion in the plane (/assessment/communication?group=team%3ATEAM-003): group pane true, discussion thread true, Open page link true, no binding strip is drawn (nothing is bound and this role holds no ManageChannels)
notes: Rows: # Checkout Experience Team discussion || # Fraud Detection ML Team discussion || # Northstar Payments Team discussion. Live-call dots: 0 (no call was live). 'Link your account to a person' row present: false. The walker is a clone and keeps its persona's person link.
