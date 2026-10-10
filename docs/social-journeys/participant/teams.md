surface: teams
role: participant
user: u-sana (Sana Iqbal)
url: /social/teams?channel=social%3Ateam%3Ajourney-community-admin-muwuu6wu%3Ageneral
pages: portal/src/pages/social/TeamsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialConversation.tsx
audited: 2026-10-08 11:05Z → 2026-10-08 11:05Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, second context u-mira; Tilt stack: Vite :5183 over middleware :3001 (mock providers) with the real SFU :3902 and platform-api :23001
session: /api/session/me sub u-sana, tenant social, role participant
screenshot: teams.jpg
verdict: pass
console errors: 0
layout: pass — content column x=200px, width 1480px, top 70px, bottom 893px; rail 300px at x=200, y=70, height 823; pane x=500, width 1180; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / viewport height 940; composer y=824–864px, in view: true; footer row y=894–940px (1680px wide); h1 count 1
type: title 16/400; sizes in main (size/weight×text nodes): 13/600×17, 13/500×12, 12/400×11, 11/400×10, 11/500×8, 15/600×7, 11/600×6, 14/500×5, 16/400×5, 12/600×4, 14/400×3, 8/600×3, 13/400×3, 10/600×2, 14/600×1, 20/600×1
keyboard: pass — physical Tab sweep from the start of main reached 33 distinct controls against 32 Tab stops (60 really-visible interactive elements; roving-focus members are not Tab stops); first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-options, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle
empty-state: pass — /social/teams?channel=social%3Ateam%3Ano-such-team%3Ageneral rendered: Pick a channel Choose a team's channel on the left to read it, or open a team's ⋯ menu to see who is on it.
realtime: pass — u-sana's message reached u-mira in 0.824s, the reply came back in 0.223s, no reload; own message present after reload: true
role-gating: cannot manage channels/teams: Create channel controls in DOM 0, New team 0, New room 1, New message 1; POST /api/social/channels {} → 403, POST /api/social/teams {} → 403 (403 = refused by Cedar, 400 = validation past the gate); message actions: own row Edit 1 / Delete 1, u-mira's view of that row Edit 0 / Delete 0
header: JC Journey community-admin muwuu6wu · General 2 members Chat Documents Pinned Calls Work graph; tabs present [chat, documents, pins, calls] = [true,true,true,true]
team-tree: JA Journey admin mux1oqe9 ⋯ # General JM Journey moderator muwxanes ⋯ # General JC Journey community-admin muwuu6wu ⋯ # General
team-detail: team “Journey community-admin muwuu6wu” (role member, 1 channel(s)) chosen because both u-sana and u-mira are members
notes: Every field above was observed in this pass, not carried forward. Not exercised in this pass: pins, forward, slash commands, attachments (covered by the pin/summarize specs, not by this surface log).
