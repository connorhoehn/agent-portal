surface: teams
role: participant
user: u-sana
url: /social/teams?channel=social:team:community:events
pages: portal/src/pages/social/TeamsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialConversation.tsx
audited: 2026-09-30 12:38Z → 12:40Z, Chromium 1672×941 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api, DynamoDB Local, host SFU), Vite :5183
session: /api/session/me sub u-sana, tenant social, role participant
screenshot: teams.jpg
verdict: pass
console errors: 0 — the unknown-team probe's own "Failed to load resource: 404" for GET /api/social/teams/no-such-team, the correct answer to a made-up id, counted apart
layout: pass — chat rail (library ConversationRail) 300px at x=200, flush against the 200px shell rail (content col left 200, 0px from content start), top 70 = content top 70, 871px tall = the full content height (no page header, shell crumbs off); pane 1172px at x=500; no horizontal scroll (scrollWidth 1672 = innerWidth 1672); composer at y 871–913px of 941, in view with no body scroll (scrollHeight 941)
keyboard: pass — 23 distinct Tab stops from the rail's Find box through main (first: Find a chat, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle…) against 41 visible controls in main — the rail's conversation rows and the tree sit behind roving tabindexes (ArrowDown walks them), so fewer stops than controls is the design
empty-state: pass — /social/teams?team=no-such-team renders "This team is not available It does not exist, or it is private and you are not on it."; a user on no team (u-operator) gets "You are not on a team yet…" (admin log)
realtime: pass — <0.01s: Mira Okafor posted in social:team:community:events from their own context; it appeared here with no reload
role-gating: no ManageTeams: no New team + on the TEAMS heading (count 0, absent from the DOM); Members (⋯ menu) shows "Open channel MO Mira Okafor Owner LB Lena Brandt SI Sana Iqbal (you)" with 0 Add control(s) — only the team's owner adds or removes people
notes: Teams (GET /api/social/teams): Community (member; General, Events). the conversation header (library WrappedConversationSurface) carries the tabs Chat | Documents | Pinned | Calls; Documents → URL ?channel=social%3Ateam%3Acommunity%3Aevents&view=documents (the view is in the URL), Chat restores it; audio-call 1 + video-call 1 actions; the ⋯ menu lists Members and Escape closed it (yes). Enter on the focused tree row opened ?channel=social:team:community:events.
