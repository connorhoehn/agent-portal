surface: rooms
role: admin
user: u-operator (walked as its clone u-operator-clone-2d06cde5)
url: /social/rooms
pages: portal/src/pages/social/RoomsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialRoomsSection.tsx,portal/src/pages/social/RoomPane.tsx,portal/src/pages/social/useSocialCall.ts
audited: 2026-10-24 08:50–08:52 local, headless Chromium 1680×940 (Playwright) with fake capture devices, a fresh signed-in clone of u-operator (u-operator-clone-2d06cde5), second context u-mira-clone-f4a434c0 (a second fresh clone, its own Playwright context); Tilt stack: Vite :5183 over middleware :3001 (dev:mock), Social platform-api :23002, SFU :3902; mock not reset (shared stack)
session: /api/session/me sub u-operator-clone-2d06cde5 (a fresh clone of u-operator), tenant social, role admin
screenshot: rooms.jpg
verdict: pass — real SFU media (fake devices) observed
console errors: 0
layout: pass — rail 300px at x=200, y=44, height 847px (primary rail open); content (SectionContent) starts x=500, width 1180px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940
keyboard: pass — 16 distinct Tab stops against 16 visible interactive controls (first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-shelf-activity); Escape closed the New room dialog (true)
empty-state: pass — this context's GET /api/social/rooms stubbed empty (page.route, this context only): pane "Pick a room Choose a room under Rooms on the left to see who can join it, then join its call. A room stays open between calls, so a group can gather in the same"; rail "No rooms yet Create one to start an ongoing hangout. Create room"; an unknown room id (?room=no-such-room-…) rendered "This room is not available It does not exist, or it is private and you are not one of its members."
realtime: pass — real room call on the local SFU/platform-api with fake devices: the dock read 1 joined 0.07s after Join; u-mira-clone-f4a434c0's join showed "2 joined" 0.11s after she pressed the room's Join call (her pre-join dialog followed it); her leave showed "1 joined" 0.10s after her Leave
role-gating: ManageChannels capability true, StartCall true; New room control present (rail) and present (pane); created "journey-admin-mvmeeiew", listed 1×; POST /api/social/rooms {} → 400 (expected 400, validation: the role may open rooms)
room-detail: journey-admin-mvmeeiew Open to the workspace Join call Who can join Everyone in this workspace Opened by u-operator-clone-2d06cde5 Call Audio and video Recording Off Lobby social:room:journey-admin-mvmeeiew; lobby social:room:journey-admin-mvmeeiew shown: true
call-tiles: 0 tile element(s): "You Mira Okafor"
media: join enabled: true; the dock with both in it read "journey-admin-mvmeeiew huddle 00:02 2 joined Message"; peer joined: true; after Leave the footer returned to its idle row (true): "Social PO 1 online Huddle Message". Real SFU media with fake capture devices; no audio content is verifiable headless.
huddle-chat: during the room call the huddle chat pane read "(no error)"; visible Leave controls while in the call: 2
notes: Every field was observed in this pass. "Opened by" names the walking clone by its raw id, because a clone is not in the people directory; a seed persona shows its display name. The room made by this walk was left in platform-api (it has no reset). The second context is fresh clone u-mira-clone-f4a434c0; no mock reset (shared stack).
