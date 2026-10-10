surface: groups
role: assessor
user: u-asha
url: /assessment/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-08 06:54–06:55 local, Chromium 1680×940 headless (Playwright), a fresh signed-in context per identity, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-asha, tenant assessment, role assessor; grants assessment: assessor; social: participant
screenshot: groups.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=44, y=70, height 823px; content (SectionContent) starts x=344, width 1336px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=894–940; section label "MY TEAMS"; rows: # · Northstar Payments · Page discussion · no Social channel · LIVE
keyboard: pass — 2 distinct Tab stops against 2 visible interactive controls (first stops: rail-section-header-toggle, conversation-row); Enter on the first row: unbound row opened the page discussion in the plane (/assessment/communication?group=team
empty-state: pass — an unknown group id rendered "Not one of your groups This plane lists your own teams. Open the page itself to read its discussion. Open page"
realtime: n/a — a page discussion's unread arrives through GET /api/discussions/unread (and a bound channel is the chat surface walked in rail.md); nothing live changed on this surface
role-gating: binding strip only (0 buttons in it); Bind a Social channel is a ManageChannels holder's, which this role does not hold
open: pass — unbound row opened the page discussion in the plane (/assessment/communication?group=team:TEAM-001): group pane true, discussion thread true, Open page link true, binding strip says "Social channel No Social channel bound"
notes: Rows: # · Northstar Payments · Page discussion · no Social channel · LIVE. No live-call dot: no call was live. 'Link your account to a person' row present: false.
