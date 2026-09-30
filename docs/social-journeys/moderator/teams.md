surface: teams
role: moderator
user: u-lena
url: /social/teams?channel=social:team:community:events
pages: portal/src/pages/social/TeamsPage.tsx
audited: 2026-09-30 04:49Z → 04:49Z, Chromium 1552×958 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api :23001, DynamoDB Local :8000, host SFU :3901), Vite :5183
session: /api/session/me sub u-lena, tenant social, role moderator
screenshot: teams.jpg
verdict: pass
console errors: 0 — the only one logged is the unknown-id probe's own "Failed to load resource: 404" for GET /api/social/teams/no-such-team, the correct answer to a made-up id, counted apart
layout: pass — content col left 224px w 1304px; no horizontal scroll (scrollWidth 1552 = innerWidth 1552); the library TeamChannelTree in a 288px Card at the content start, the channel conversation (WrappedChatPanel + ContextComposer) beside it, composer in view with no body scroll
keyboard: pass — 4 Tab stops in main (social-create-team:New team, social-team-tree-create-team:Create a team, social-team-tree-team-01M3R9ES5GY8ZAJ56VM2AEH925:CoCommunity⋯, social-team-tree-team-01M3R9ES5GY8ZAJ56VM2AEH925-menu:More options for Community); the tree is roving: ArrowDown from the team row focused social-team-tree-channel-social:team:community:general, again social-team-tree-channel-social:team:community:events; New team opened the library CreateTeamDialog anchored to its button (true) and Escape closed it (true)
empty-state: pass — /social/teams?team=no-such-team renders "This team is not available It does not exist, or it is private and you are not on it."; a user on no team (u-operator) gets "You are not on a team yet…" (admin log)
realtime: pass — 3ms: u-sana (Sana Iqbal) posted in Community · Events (social:team:community:events) from their own context; it appeared here with no reload
role-gating: ManageTeams but not this team's owner: Members shows the roster with "Only this team's owner adds or removes people." and no Add/Remove (platform-api's rule: only the owner adds); New team offered
notes: Members: "Open channel MO Mira Okafor Owner LB Lena Brandt (you) SI Sana Iqbal". Teams are platform-api's (team Community, owner u-mira, members u-lena and u-sana, channels General and Events — seeded over REST for this walk); a team's channel conversation is social:team:<team>:<channel> on the BFF gateway.
