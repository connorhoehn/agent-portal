surface: rooms
role: participant
user: u-sana
url: /social/rooms?room=town-hall
pages: portal/src/pages/social/RoomsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialRoomsSection.tsx,portal/src/pages/social/RoomPane.tsx,portal/src/pages/social/useSocialCall.ts
audited: 2026-09-30 12:38Z → 12:40Z, Chromium 1672×941 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api, DynamoDB Local, host SFU), Vite :5183
session: /api/session/me sub u-sana, tenant social, role participant
screenshot: rooms.jpg
verdict: pass
console errors: 0
layout: pass — chat rail (library ConversationRail) 300px at x=200, flush against the 200px shell rail (content col left 200, 0px from content start), top 70 = content top 70, 871px tall = the full content height (no page header, shell crumbs off); pane 1172px at x=500; no horizontal scroll (scrollWidth 1672 = innerWidth 1672); the call dock is drawn above the page by the shell (SocialLayout)
keyboard: pass — 18 distinct Tab stops from the rail's Find box through main (first: Find a chat, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle…) against 26 visible controls in main — the rail's conversation rows and the tree sit behind roving tabindexes (ArrowDown walks them), so fewer stops than controls is the design; the ROOMS section's + (new-room-button) opened "Rooms are opened by moderators Anyone here can join a room. Opening a new one takes a mode" and Escape closed it (True)
empty-state: pass — /social/rooms?room=no-such-room renders "This room is not available It does not exist, or it is private and you are not one of its members."
realtime: pass — second arrival 0.39s: from Mira Okafor's Join in their own context to this dock reading "2 people"; this user's Join → live took 0.05s; when u-mira left, this dock read "1 person" after <0.01s. In the call the dock read "Town hall 2 people Share People 2 Leave You Mira Okafor". Both joined social:room:town-hall
role-gating: no ManageChannels: the ROOMS section's + (new-room-button) opened "Rooms are opened by moderators Anyone here can join a room. Opening a new one takes a mode" and Escape closed it (True) — for this role the + opens a Modal saying who can open rooms (a control shown deliberately with its reason, queued: createHangoutRoomsSection has no canCreate); GET /api/social/rooms lists town-hall (org); joins and leaves calls
notes: The rooms are the ROOMS section of the chat rail (the library's hook-bound rooms list): "▸ ROOMS + # Town hall"; the room opens in the pane: "Who can join Everyone in this workspace Opened by Platform Operator Call Audio and video Recording Off Lobby social:room:town-hall".
