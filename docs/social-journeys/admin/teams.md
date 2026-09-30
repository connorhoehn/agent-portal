surface: teams
role: admin
user: u-operator
url: /social/teams?channel=social:team:community:events
pages: portal/src/pages/social/TeamsPage.tsx
audited: 2026-09-30 04:47Z → 04:47Z, Chromium 1552×958 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api :23001, DynamoDB Local :8000, host SFU :3901), Vite :5183
session: /api/session/me sub u-operator, tenant social, role admin
screenshot: teams.jpg
verdict: pass
console errors: 0 — the only one logged is the unknown-id probe's own "Failed to load resource: 404" for GET /api/social/teams/no-such-team, the correct answer to a made-up id, counted apart
layout: pass — content col left 224px w 1304px; no horizontal scroll (scrollWidth 1552 = innerWidth 1552); the empty state full width
keyboard: pass — 2 Tab stops in main (social-create-team:New team, social-empty-create-team:New team); New team opened the library CreateTeamDialog anchored to its button (true) and Escape closed it (true)
empty-state: pass — this user is on no team: "You are not on a team yet A team groups people and their channels. Create one and add the people it is for. New team"
realtime: n/a — not on any team, so there is no team channel to watch
role-gating: ManageTeams (the admin wildcard) and New team offered; on no team, so nothing to manage
notes: The admin holds a social grant but no team membership — platform-api lists a person's own teams only. Teams are platform-api's (team Community, owner u-mira, members u-lena and u-sana, channels General and Events — seeded over REST for this walk); a team's channel conversation is social:team:<team>:<channel> on the BFF gateway.
