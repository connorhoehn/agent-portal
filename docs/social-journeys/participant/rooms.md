surface: rooms
role: participant
user: u-sana (walked as its clone u-sana-clone-0b953a9d)
url: /social/rooms
pages: portal/src/pages/social/RoomsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialRoomsSection.tsx,portal/src/pages/social/RoomPane.tsx,portal/src/pages/social/useSocialCall.ts
audited: 2026-10-23 23:53–23:53 local, headless Chromium 1680×940 (Playwright) with fake capture devices, a fresh signed-in clone of u-sana (u-sana-clone-0b953a9d), second context u-mira (real seed persona, its own Playwright context); Tilt stack: Vite :5183 over middleware :3001 (dev:mock), Social platform-api :23002, SFU :3902; mock not reset (shared stack)
session: /api/session/me sub u-sana-clone-0b953a9d (a fresh clone of u-sana), tenant social, role participant
screenshot: rooms.jpg
verdict: fail — 13 console errors (4xx: 403 GET /api/calls/<id>/chat; 403 POST /api/video/sessions/<id>/<id>)
console errors: 13 — the failing requests: 403 GET /api/calls/<id>/chat; 403 POST /api/video/sessions/<id>/<id>
layout: pass — rail 300px at x=200, y=44, height 847px (primary rail open); content (SectionContent) starts x=500, width 1180px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940
keyboard: pass — 14 distinct Tab stops against 14 visible interactive controls (first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-shelf-activity); Escape closed the New room explanation dialog (true)
empty-state: pass — this context's GET /api/social/rooms stubbed empty (page.route, this context only): pane "Pick a room Choose a room under Rooms on the left to see who can join it, then join its call. A room stays open between calls, so a group can gather in the same"; rail "No rooms yet Create one to start an ongoing hangout. Create room"; an unknown room id (?room=no-such-room-…) rendered "This room is not available It does not exist, or it is private and you are not one of its members."
realtime: pass — real room call on the local SFU/platform-api with fake devices: the dock read 1 joined 0.08s after Join; u-mira's join showed "2 joined" 0.10s after she pressed the room's Join call (her pre-join dialog followed it); her leave showed "1 joined" 0.07s after her Leave
role-gating: ManageChannels capability false, StartCall true; New room control present (rail) — for this role it opens no create form (0 name fields) but an explanation: "Rooms are opened by moderators Anyone here can join a room. Opening a new one takes a moderator or a community admin — ask one in #general. OK" and absent (pane); POST /api/social/rooms {} → 403 (expected 403, not allowed to open rooms)
room-detail: journey-admin-mvkfovtr Open to the workspace Join call Who can join Everyone in this workspace Opened by u-operator-clone-f5ff2673 Call Audio and video Recording Off Lobby social:room:journey-admin-mvkfovtr (room opened by u-operator-clone-f5ff2673 earlier in this walk); lobby social:room:journey-admin-mvkfovtr shown: true
call-tiles: 2 tile element(s): "You Mira Okafor"
media: join enabled: true; the dock with both in it read "journey-admin-mvkfovtr huddle 00:02 2 joined 2 Message"; peer joined: true; after Leave the footer returned to its idle row (true): "Social SI 2 online Huddle Message". Real SFU media with fake capture devices; no audio content is verifiable headless.
huddle-chat: during the room call the huddle chat pane read "This call requires an OrgIQ or assessment session"; visible Leave controls while in the call: 2
notes: Every field was observed in this pass. "Opened by" names the walking clone by its raw id, because a clone is not in the people directory; a seed persona shows its display name. The room joined was left in platform-api (it has no reset). The second context is the real seed persona u-mira; no mock reset (shared stack).
