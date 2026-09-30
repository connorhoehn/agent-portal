surface: teams
role: admin
user: u-operator
url: /social/teams
pages: portal/src/pages/social/TeamsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialConversation.tsx
audited: 2026-09-30 12:42Z → 12:44Z, Chromium 1672×941 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api, DynamoDB Local, host SFU), Vite :5183
session: /api/session/me sub u-operator, tenant social, role admin
screenshot: teams.jpg
verdict: pass
console errors: 0 — the unknown-team probe's own "Failed to load resource: 404" for GET /api/social/teams/no-such-team, the correct answer to a made-up id, counted apart
layout: pass — chat rail (library ConversationRail) 300px at x=200, flush against the 200px shell rail (content col left 200, 0px from content start), top 70 = content top 70, 871px tall = the full content height (no page header, shell crumbs off); pane 1172px at x=500; no horizontal scroll (scrollWidth 1672 = innerWidth 1672)
keyboard: pass — 18 distinct Tab stops from the rail's Find box through main (first: Find a chat, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle…) against 23 visible controls in main — the rail's conversation rows and the tree sit behind roving tabindexes (ArrowDown walks them), so fewer stops than controls is the design
empty-state: pass — this user is on no team: "You are not on a team yet A team groups people and their channels. Create one and add the people it is for. New team"; /social/teams?team=no-such-team renders "This team is not available It does not exist, or it is private and you are not on it."
realtime: n/a — this user is on no team, so there is no team channel to receive a message in
role-gating: ManageTeams: TEAMS' + opened the library CreateTeamDialog (True), Escape closed it (True)
notes: The TEAMS group in the rail shows its heading and + with no teams under it.
