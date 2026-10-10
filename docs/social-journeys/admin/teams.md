surface: teams
role: admin
user: u-operator (operator)
url: /social/teams?channel=social%3Ateam%3Ajourney-admin-mux1oqe9%3Ageneral
pages: portal/src/pages/social/TeamsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialConversation.tsx
audited: 2026-10-08 11:06Z → 2026-10-08 11:06Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, second context u-sana; Tilt stack: Vite :5183 over middleware :3001 (mock providers) with the real SFU :3902 and platform-api :23001
session: /api/session/me sub u-operator, tenant social, role admin
screenshot: teams.jpg
verdict: pass
console errors: 0
layout: pass — content column x=200px, width 1480px, top 70px, bottom 893px; rail 300px at x=200, y=70, height 823; pane x=500, width 1180; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / viewport height 940; composer y=824–864px, in view: true; footer row y=894–940px (1680px wide); h1 count 1
type: title 16/400; sizes in main (size/weight×text nodes): 13/600×10, 13/500×9, 12/400×9, 11/400×8, 15/600×7, 14/500×5, 16/400×5, 11/600×5, 11/500×5, 12/600×4, 14/400×3, 8/600×1, 13/400×1, 14/600×1, 20/600×1
keyboard: pass — physical Tab sweep from the start of main reached 32 distinct controls against 31 Tab stops (49 really-visible interactive elements; roving-focus members are not Tab stops); first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-options, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle
empty-state: pass — /social/teams?channel=social%3Ateam%3Ano-such-team%3Ageneral rendered: Pick a channel Choose a team's channel on the left to read it, or open a team's ⋯ menu to see who is on it.
realtime: pass — u-operator's message reached u-sana in 0.176s, the reply came back in 0.177s, no reload; own message present after reload: true
role-gating: can manage channels/teams: Create channel controls in DOM 1, New team 1, New room 1, New message 1; POST /api/social/channels {} → 400, POST /api/social/teams {} → 400 (403 = refused by Cedar, 400 = validation past the gate); message actions: own row Edit 1 / Delete 1, u-sana's view of that row Edit 0 / Delete 0
header: JA Journey admin mux1oqe9 · General 2 members Chat Documents Pinned Calls Work graph; tabs present [chat, documents, pins, calls] = [true,true,true,true]
team-tree: JA Journey admin mux1oqe9 ⋯ # General
team-detail: team “Journey admin mux1oqe9” (role owner, 1 channel(s)) chosen because both u-operator and u-sana are members
notes: Every field above was observed in this pass, not carried forward. Not exercised in this pass: pins, forward, slash commands, attachments (covered by the pin/summarize specs, not by this surface log).
