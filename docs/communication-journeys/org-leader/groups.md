surface: groups
role: org-leader
user: u-vera
url: /iq/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-08 06:52–06:54 local, Chromium 1680×940 headless (Playwright), a fresh signed-in context per identity, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-vera, tenant orgiq, role member; grants orgiq: org-leader, member; social: participant
screenshot: groups.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=44, y=70, height 823px; content (SectionContent) starts x=344, width 1336px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=894–940; section label "MY INITIATIVES"; rows: # · Auth Migration · #auth-migration
keyboard: pass — 2 distinct Tab stops against 2 visible interactive controls (first stops: rail-section-header-toggle, conversation-row); Enter on the first row: bound row opened the channel conversation (/iq/communication/channels/auth-migration), composer present (true)
empty-state: pass — an unknown group id rendered "Not one of your groups This plane lists your own initiatives. Open the page itself to read its discussion. Open page"
realtime: n/a — a page discussion's unread arrives through GET /api/discussions/unread (and a bound channel is the chat surface walked in rail.md); nothing live changed on this surface
role-gating: the bound row is available to every participant; Bind controls in the DOM: 0
open: pass — bound row opened the channel conversation (/iq/communication/channels/auth-migration), composer present (true)
notes: Rows: # · Auth Migration · #auth-migration. No live-call dot: no call was live. 'Link your account to a person' row present: false.
