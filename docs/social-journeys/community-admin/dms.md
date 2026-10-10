surface: dms
role: community-admin
user: u-mira (Mira Okafor)
url: /social/dms/social%3Adm%3Au-mira%3Au-sana
pages: portal/src/pages/social/DmsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialConversation.tsx,portal/src/pages/social/socialChat.ts
audited: 2026-10-08 11:05Z → 2026-10-08 11:05Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, second context u-sana; Tilt stack: Vite :5183 over middleware :3001 (mock providers) with the real SFU :3902 and platform-api :23001
session: /api/session/me sub u-mira, tenant social, role community-admin
screenshot: dms.jpg
verdict: pass
console errors: 0
layout: pass — content column x=200px, width 1480px, top 70px, bottom 893px; rail 300px at x=200, y=70, height 823; pane x=500, width 1180; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / viewport height 940; composer y=824–864px, in view: true; footer row y=894–940px (1680px wide); h1 count 1
type: title 16/400; sizes in main (size/weight×text nodes): 12/400×16, 13/500×15, 13/600×15, 11/400×12, 11/500×9, 15/600×8, 14/500×5, 16/400×5, 12/600×5, 11/600×5, 14/400×3, 10/600×2, 14/600×1, 20/600×1
keyboard: pass — physical Tab sweep from the start of main reached 34 distinct controls against 33 Tab stops (69 really-visible interactive elements; roving-focus members are not Tab stops); first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-options, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle
empty-state: pass — /social/dms/social%3Adm%3Au-nobody%3Au-nothere rendered: This conversation is not yours A direct message opens only for the people it names.
realtime: pass — u-mira's message reached u-sana in 0.302s, the reply came back in 0.087s, no reload; own message present after reload: true
role-gating: can manage channels/teams: Create channel controls in DOM 1, New team 1, New room 1, New message 1; POST /api/social/channels {} → 400, POST /api/social/teams {} → 400 (403 = refused by Cedar, 400 = validation past the gate); message actions: own row Edit 1 / Delete 1, u-sana's view of that row Edit 0 / Delete 0
header: SI Sana Iqbal Chat Documents Pinned Calls Work graph; tabs present [chat, documents, pins, calls] = [true,true,true,true]
picker: New message picker opened: true; Escape closed it: true
notes: Every field above was observed in this pass, not carried forward. Not exercised in this pass: pins, forward, slash commands, attachments (covered by the pin/summarize specs, not by this surface log).
