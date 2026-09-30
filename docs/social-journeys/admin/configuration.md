surface: configuration
role: admin
user: u-operator
url: /social/configuration
pages: portal/src/pages/social/ConfigurationPage.tsx
audited: 2026-09-30 04:52Z → 04:52Z, Chromium 1552×958 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api :23001, DynamoDB Local :8000, host SFU :3901), Vite :5183
session: /api/session/me sub u-operator, tenant social, role admin
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; no horizontal scroll (scrollWidth 1552 = innerWidth 1552); three PageSections (People, What you can do, Where the data lives) of library KeyValue rows
keyboard: pass — 0 controls in main: the page is read-only and says so
empty-state: n/a — the page always has the viewer's own role and grant to show
realtime: n/a — nothing on it is live
role-gating: ManageSocialConfig held: "Nothing here is editable yet — retention and room policy use platform-api's defaults. Your role may configure this workspace, so you will be one of the people who changes them."; the rail offers Configuration to every role (every page is ViewSocial)
notes: People13 Participant 10 people Moderator 1 person Community admin 1 person Admin 1 person. What you can do as Admin Read channels, rooms, teams and recordings Yes Post in channels and direct messages Yes Start and join calls Yes Create channels and rooms Yes Create teams and change who is on them Yes Share and delete recordings Yes Change this workspace's configuration Yes. Where the data lives Rooms platform-api Teams platform-api Recordings platform-api Call log platform-api.
