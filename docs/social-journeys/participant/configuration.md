surface: configuration
role: participant
user: u-sana
url: /social/configuration
pages: portal/src/pages/social/ConfigurationPage.tsx
audited: 2026-09-30 12:38Z → 12:40Z, Chromium 1672×941 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api, DynamoDB Local, host SFU), Vite :5183
session: /api/session/me sub u-sana, tenant social, role participant
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1424px (an ordinary page: the shell's 24px ring and crumbs); no horizontal scroll (scrollWidth 1672 = innerWidth 1672); the capability table (one library DataTable) is 1424px wide at x=224 — the full content width — its label column 1263px, rows 45px, so every label sits on one line; the table starts at y 311, above the fold
keyboard: pass — 0 Tab stops in main against 0 visible controls: the page is read-only and says so
empty-state: n/a — the page always has the viewer's own role and grant to show
realtime: n/a — nothing on it is live
role-gating: no ManageSocialConfig: "Only a community admin can change this workspace's configuration. You can see how it is set up."; columns CAPABILITY, PARTICIPANT (YOU) — the other roles' columns come from the Cedar-derived role registry, which this role may not read: "This is what your role may do. The other roles' permissions are shown to people who manage this workspace's users."
notes: Rows: Read channels, rooms, teams and recordings Yes | Post in channels and direct messages Yes | Start and join calls Yes | Create channels and rooms No | Create teams and change who is on them No | Share and delete recordings No | Change this workspace's configuration No. People: People13 Participant · 10 people Moderator · 1 person Community admin · 1 person Admin · 1 person. Where the data lives: Where the data lives Rooms platform-api Teams platform-api Recordings platform-api Call log platform-api. Fixed on this walk: the capability list was a KeyValue whose ~220px label column wrapped each label onto three lines.
