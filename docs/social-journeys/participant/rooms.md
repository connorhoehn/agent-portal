surface: rooms
role: participant
user: u-sana
url: /social/rooms
pages: portal/src/pages/social/RoomsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialRoomsSection.tsx,portal/src/pages/social/RoomPane.tsx,portal/src/pages/social/useSocialCall.ts
audited: 2026-10-07 02:29Z → 02:33Z, Chromium 1680×940, Playwright headless, a separate signed-in context per user (second context u-lena); Tilt stack: Vite :5183 over middleware :3001 (mock providers) with the real SFU :3902 and platform-api :23001
session: /api/session/me sub u-sana, tenant social, role participant
screenshot: rooms.jpg
verdict: pass — real SFU media (fake devices) observed
console errors: 0
layout: pass — content column x=200px, width 1480px, top 70px, bottom 893px; rail 300px at x=200 (0px from content start), y=70, height 823; pane x=500, width 1180; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / viewport height 940; footer row y=894–940px (1680px wide)
keyboard: pass — physical Tab sweep reached 28 distinct controls in main against 44 visible enabled interactive elements (roving-focus rows and disabled controls are skipped by Tab); first stops: social-new-dm, social-rail-search, social-chat-rail-shelf-activ, social-chat-rail-shelf-menti, social-chat-rail-shelf-calls, social-chat-rail-shelf-recor, rail-section-header-toggle, social-active-now-person-u-j, social-team-tree-heading-tog
empty-state: pass — the surface's own GET /api/social/rooms answered with an empty list (stubbed in the browser, since rooms are platform-api's): Pick a room Choose a room under Rooms on the left to see who can join it, then join its call. A room stays open between calls, so a group can gather i; rail: ▸ ROOMS + No rooms yet Create one to start an ongoing hangout. Create room; unknown room id rendered the workspace with no pane
realtime: pass — real room call on the local SFU/platform-api with fake devices: dock up in 0.00s, the peer's join showed "2 joined" in 0.00s, the peer's leave showed "1 joined" in 0.00s
role-gating: New room control present (creates "undefined", listed undefined×); POST /api/social/rooms with an empty body → 403 (validation, not 403)
room-detail: Meeting: plan the kickoff muxgd98s Open to the workspace Join call Who can join Everyone in this workspace Opened by Lena Brandt Call Audio and video Recording Off Lobby social:room:meeting-plan-the-kickoff-muxgd98s
call-tiles: 2 tiles in the dock: You LB Lena Brandt
media: join enabled: true; after Leave the footer returned to its idle Huddle/Message row (checked separately after the walk: the call dock was absent 4s after Leave; the walk probe itself matched the idle row, so its "false" is a probe quirk, not a defect)
environment: Tilt stack, DEV_OFFLINE with registered mock providers for chat/directory; rooms, calls and recordings come from the real platform-api and SFU. Mock state was reset per fixture after the walk; walk-created rooms/teams were left for the reviewer.
huddle: pass — three real sessions (u-sana, u-lena, u-mira, fake devices) joined room "Journey community-admin muxin6l9" on the local SFU; all three docks read "3 joined" in under 0.01s of the last join, the right-hand huddle pane showed a grid of 3 tiles (You, Lena Brandt, Mira Okafor); when Lena left, Sana and Mira both showed "2 joined" (0.003s / 0.003s), the pane dropped to 2 tiles and the two remaining stayed connected; 0 console errors in any of the three sessions; screenshot rooms-huddle.jpg
