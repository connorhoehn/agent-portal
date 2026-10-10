surface: channels
role: admin
user: u-operator (operator)
url: /social/channels/general
pages: portal/src/pages/social/ChannelsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialConversation.tsx,portal/src/pages/social/socialChat.ts
audited: 2026-10-08 11:12Z → 2026-10-08 11:13Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, second context u-sana; Tilt stack: Vite :5183 over middleware :3001 (mock providers) with the real SFU :3902 and platform-api :23001
session: /api/session/me sub u-operator, tenant social, role admin
screenshot: channels.jpg
verdict: pass
console errors: 0
layout: pass — content column x=200px, width 1480px, top 70px, bottom 893px; rail 300px at x=200, y=70, height 823; pane x=500, width 1180; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / viewport height 940; composer y=824–864px, in view: true; footer row y=894–940px (1680px wide); h1 count 1
type: title 16/400; sizes in main (size/weight×text nodes): 12/400×90, 12/600×24, 14/400×23, 13/500×8, 11/400×8, 13/600×8, 15/600×7, 14/500×5, 16/400×5, 11/600×5, 11/500×5, 14/600×1, 20/600×1, 10/600×1, 8/600×1
keyboard: pass — physical Tab sweep from the start of main reached 50 distinct controls against 49 Tab stops (184 really-visible interactive elements; roving-focus members are not Tab stops); first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-options, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle
empty-state: pass — /social/channels/no-such-channel rendered: #no-such-channel is not available This channel does not exist, or it is private and you are not a member.
realtime: pass — u-operator's message reached u-sana in 1.807s, the reply came back in 1.812s, no reload; own message present after reload: true
role-gating: can manage channels/teams: Create channel controls in DOM 1, New team 1, New room 1, New message 1; POST /api/social/channels {} → 400, POST /api/social/teams {} → 400 (403 = refused by Cedar, 400 = validation past the gate); message actions: own row Edit 1 / Delete 1, u-sana's view of that row Edit 0 / Delete 0
header: #g #general 14 members · Announcements and anything that does not have a home yet. Chat Documents 1 Pinned Calls Work gr; tabs present [chat, documents, pins, calls] = [true,true,true,true]
rail-sections: Chat Activity Mentions Calls Recordings ACTIVE NOW 3 Jonas Sana Theo TEAMS ROOMS 37 DIRECT MESSAGES Sana Iqbal 07:05 reply u-sana dms rndgnx ⋯ CHANNELS # general 07:12 reply u-sana channels fvtnpd ⋯ # plane-walk-muzdqdrf
notes: Every field above was observed in this pass, not carried forward. The walker was not a member of this channel (the pane read “You are not in …” with a Join button), so it clicked Join #general first: a membership write for this identity, left in place. Not exercised in this pass: pins, forward, slash commands, attachments (covered by the pin/summarize specs, not by this surface log).
