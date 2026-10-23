surface: configuration
role: moderator
user: u-lena
url: /social/configuration
pages: portal/src/pages/social/ConfigurationPage.tsx
audited: 2026-10-22 23:39–23:39 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-lena (u-lena-clone-d73835fb), second context none (nothing on the page is live); Tilt stack: Vite :5183 over middleware :3001 (dev:mock), Social platform-api :23002, SFU :3902; mock not reset (shared stack)
session: /api/session/me sub u-lena-clone-d73835fb (a clone of u-lena), tenant social, role moderator
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — content column x=224px, width 1432px; the capability table is 1432px wide at x=224, top y=261, rows 44px; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940
keyboard: pass — 0 distinct Tab stops against 0 visible interactive controls (first stops: ); the controls in main are none: the page is read-only and says so
empty-state: n/a — the page always has the viewer's own role and grant to show
realtime: n/a — nothing on it is live
role-gating: no ManageSocialConfig: "Only a community admin can change this workspace's configuration. You can see how it is set up."; columns CAPABILITY, MODERATOR (YOU); "This is what your role may do. The other roles' permissions are shown to people who manage this workspace's users."
notes: Rows: Read channels, rooms, teams and recordings Yes | Post in channels and direct messages Yes | Start and join calls Yes | Create channels and rooms Yes | Create teams and change who is on them Yes | Share and delete recordings Yes | Change this workspace's configuration No. People 17 Participant · 14 people Moderator · 1 person Community admin · 1 person Admin · 1 person. Where the data lives Rooms platform-api Teams platform-api Recordings platform-api Call log platform-api.
