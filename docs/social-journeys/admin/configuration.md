surface: configuration
role: admin
user: u-operator
url: /social/configuration
pages: portal/src/pages/social/ConfigurationPage.tsx
audited: 2026-10-22 18:57–18:58 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-operator (u-operator-clone-083f8c6b), second context none (nothing on the page is live); Tilt stack: Vite :5183 over middleware :3001 (dev:mock), Social platform-api :23002, SFU :3902; mock not reset (shared stack)
session: /api/session/me sub u-operator-clone-083f8c6b (a clone of u-operator), tenant social, role admin
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — content column x=224px, width 1432px; the capability table is 1432px wide at x=224, top y=261, rows 44px; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940
keyboard: pass — 0 distinct Tab stops against 0 visible interactive controls (first stops: ); the controls in main are none: the page is read-only and says so
empty-state: n/a — the page always has the viewer's own role and grant to show
realtime: n/a — nothing on it is live
role-gating: ManageSocialConfig: "Nothing here is editable yet — retention and room policy use platform-api's defaults. Your role may configure this workspace, so you will be one of the people who changes them."; columns CAPABILITY, PARTICIPANT, MODERATOR, COMMUNITY ADMIN, ADMIN (YOU)
notes: Rows: Read channels, rooms, teams and recordings Yes Yes Yes Yes | Post in channels and direct messages Yes Yes Yes Yes | Start and join calls Yes Yes Yes Yes | Create channels and rooms No Yes Yes Yes | Create teams and change who is on them No Yes Yes Yes | Share and delete recordings No Yes Yes Yes | Change this workspace's configuration No No Yes Yes. People 17 Participant · 14 people Moderator · 1 person Community admin · 1 person Admin · 1 person. Where the data lives Rooms platform-api Teams platform-api Recordings platform-api Call log platform-api.
