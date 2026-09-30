surface: configuration
role: community-admin
user: u-mira
url: /social/configuration
pages: portal/src/pages/social/ConfigurationPage.tsx
audited: 2026-09-30 12:36Z → 12:38Z, Chromium 1672×941 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api, DynamoDB Local, host SFU), Vite :5183
session: /api/session/me sub u-mira, tenant social, role community-admin
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1424px (an ordinary page: the shell's 24px ring and crumbs); no horizontal scroll (scrollWidth 1672 = innerWidth 1672); the capability table (one library DataTable) is 1424px wide at x=224 — the full content width — its label column 783px, rows 45px, so every label sits on one line; the table starts at y 311, above the fold
keyboard: pass — 0 Tab stops in main against 0 visible controls: the page is read-only and says so
empty-state: n/a — the page always has the viewer's own role and grant to show
realtime: n/a — nothing on it is live
role-gating: ManageSocialConfig: "Nothing here is editable yet — retention and room policy use platform-api's defaults. Your role may configure this workspace, so you will be one of the people who changes them."; columns CAPABILITY, PARTICIPANT, MODERATOR, COMMUNITY ADMIN (YOU), ADMIN — every social role's column, from the Cedar-derived role registry (GET /api/identity/roles?tenant=social)
notes: Rows: Read channels, rooms, teams and recordings Yes Yes Yes Yes | Post in channels and direct messages Yes Yes Yes Yes | Start and join calls Yes Yes Yes Yes | Create channels and rooms No Yes Yes Yes | Create teams and change who is on them No Yes Yes Yes | Share and delete recordings No Yes Yes Yes | Change this workspace's configuration No No Yes Yes. People: People13 Participant · 10 people Moderator · 1 person Community admin · 1 person Admin · 1 person. Where the data lives: Where the data lives Rooms platform-api Teams platform-api Recordings platform-api Call log platform-api. Fixed on this walk: the capability list was a KeyValue whose ~220px label column wrapped each label onto three lines.
