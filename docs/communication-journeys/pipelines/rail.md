surface: rail
role: author
user: u-tomas
url: /pipelines/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-08 06:55–06:56 local, Chromium 1680×940 headless (Playwright), a fresh signed-in context per identity, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-tomas, tenant pipelines, role author; grants pipelines: author; social: participant
screenshot: rail.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=200, y=70, height 823px; content (SectionContent) starts x=500, width 1180px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=894–940; shelf of 4 icon buttons (Activity; Mentions; Calls; Recordings), data-layout=bar; sections in order: Active now, groups, Teams, Rooms, Channels
keyboard: pass — 18 distinct Tab stops against 32 visible interactive controls (first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-options); the find button opens the search field (focused input true), Escape closes it and focus returns to social-chat-rail-search-toggle
empty-state: pass — /pipelines/communication/channels/no-such-channel rendered "Runs › Communication Communication Your work #no-such-channel is not available This channel does not exist, or it is private and you are not" with the rail still mounted (true); the mock's registered empty scenario was not applied to the plane: it would blank the other tenants' shared state during the walk
realtime: pass — u-mira's line in #general reached this user's open conversation 0.010s after the gateway ack (gateway ack); the rail row preview of that open conversation followed it 0.019s after the ack
role-gating: controls in the rail header: Find a chat, New message, Rail options, New room (no 'New channel' or 'Create team channel'); 8 conversation rows
notes: 71 /api/social requests so far in this identity's walk (count only). Join of #general via POST /api/social/plane/channels/general/join answered 200 (idempotent for members; a mock write, not reset).
