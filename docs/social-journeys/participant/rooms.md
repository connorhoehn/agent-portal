surface: rooms
role: participant
user: u-sana
url: /social/rooms?room=town-hall
pages: portal/src/pages/social/RoomsPage.tsx,portal/src/pages/social/useSocialCall.ts
audited: 2026-09-30 08:00Z, Chromium 1552×958 (Playwright headless from portal/node_modules, one fresh context per user with --use-fake-device-for-media-stream — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api :23001, DynamoDB Local :8000, host SFU :3901), Vite :5183, realtime-modules 0.99.3 (085580ab) in both packages — the lane-E re-walk of the S2 failures
session: /api/session/me sub u-sana, tenant social, role participant
screenshot: rooms.jpg
verdict: pass — the three S2 failures are fixed on 0.99.3: teardown DELETEs go to the SFU, the second arrival reads in well under 2s, and the remote tile carries the person's name
console errors: 0 — before joining, in the call, after the peer left and after this user's own Leave; no WHIP/WHEP response ≥400 on either side (0)
layout: pass — content col left 224px w 1304px; no horizontal scroll (scrollWidth 1552 = innerWidth 1552, also in the call: 1552 = 1552); the rooms list (library WrappedHangoutRoomsList in a Card) at the content start, the room detail beside it; the call dock is drawn above the page by the shell (SocialLayout)
keyboard: pass — 3 enabled visible controls in main on the list view, 3 accept focus (`.focus()` walk): ▸ ROOMS, New room and the room row(s); Join call / Leave call are buttons in the room detail
empty-state: pass — /social/rooms?room=no-such-room renders “This room is not available It does not exist, or it is private and you are not one of its members.”
realtime: pass — second arrival 0.11s: from u-mira's own dock going live (their Join → live 0.25s) to this dock reading “2 people”; this user's Join → live took 0.32s; when u-mira left, this dock read “Town hall 1 person Share People 1 Leave You” after 16ms. In the call the dock reads “Town hall 2 people Share People 2 Leave You Mira Okafor” — the remote tile is labelled with the person's display name, not an SFU participant id. Leave's DELETE target: http://localhost:3901/api/channels/arn%3Alocal%3Aivs%3Achannel%2F<id>/whep/<id>; http://localhost:3901/api/channels/arn%3Alocal%3Aivs%3Achannel%2F<id>/whip/<id> — the SFU (:3901), resolved against the WHIP/WHEP POST URL; 0.99.3 fixed the relative-Location teardown and dropped the STUN wait. Both joined social:room:town-hall — one platform-api session, one SFU channel.
role-gating: cannot open rooms (no ManageChannels): POST /api/social/rooms answers 403; the section’s + (the library always draws it — queued) opens the “Rooms are opened by moderators” notice instead of a form; GET /api/social/rooms lists town-hall (org) — the private Moderators desk is absent for a non-member; joins and leaves calls
notes: Second person: u-mira (community-admin). The walk's joins wrote call-log rows to platform-api (SocialLayout's RoomCallLog). DEFECTS.md #1–#3 closed on this walk.
