surface: rail
role: assessor
user: u-asha
url: /assessment/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-16 13:48–13:48 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-asha (u-asha-clone-615f89c2) with seed persona u-mira as the second context, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-asha-clone-615f89c2 (a clone of u-asha), tenant assessment, role assessor; grants assessment: assessor; social: participant
screenshot: rail.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=200, y=44, height 847px (primary rail open); content (SectionContent) starts x=500, width 1180px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940; shelf of 4 icon buttons (Activity; Mentions; Calls; Recordings), data-layout=bar; sections in order (on the plane's home with a pane open): My teams, Teams, Rooms, Channels
keyboard: pass — 16 distinct Tab stops against 28 visible interactive controls (first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-options); the find button opens the search field (focused input true), Escape closes it (true) and focus returns to social-chat-rail-search-toggle
empty-state: pass — /assessment/communication/channels/no-such-channel rendered "#no-such-channel is not available This channel does not exist, or it is private and you are not a member." with the rail still mounted (true); the mock's registered empty scenario was not applied to the plane: it would blank the other tenants' shared state during the walk
realtime: pass — u-mira's line in #general reached this user's open conversation 0.023s after she sent it (the gateway's ack to her took 0.001s); the rail row preview of that open conversation followed it 0.067s after she sent it
role-gating: controls in the rail header: Find a chat, New message, Rail options; also in the rail: New room (no 'New channel' or 'Create team channel' unless listed); 9 conversation rows
notes: 108 /api/social requests so far in this identity's walk (count only). Behaviour change since the 2026-10-08 walk: /assessment/communication opens the user's default conversation instead of drawing an overview (this walk landed on /assessment/communication/channels/general, where the rail shows only its own section: "Chat Activity Mentions Calls Recordings ACTIVE NOW 1 Mira CHANNELS # general 13:47 Rail preview 1792172879868 ⋯ # auth-m…"), so the sections above are read on /assessment/communication?person=<this clone>, the plane's home with the person pane open, where every section is drawn. Join of #general via POST /api/social/plane/channels/general/join answered 200 (idempotent for members; a mock write, not reset). The walker is a clone; its Social records are its persona's, and the second context is the seed persona u-mira, because a clone's presence is not in any viewer's roster.
