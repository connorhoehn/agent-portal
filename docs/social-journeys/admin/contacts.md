surface: contacts
role: admin
user: u-operator
url: /social/contacts
pages: portal/src/pages/social/ContactsPage.tsx
audited: 2026-09-30 04:46Z → 04:47Z, Chromium 1552×958 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api :23001, DynamoDB Local :8000, host SFU :3901), Vite :5183
session: /api/session/me sub u-operator, tenant social, role admin
screenshot: contacts.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; no horizontal scroll (scrollWidth 1552 = innerWidth 1552); "Here now" (library PresenceAvatars in a PageSection) above the roster DataTable, both full width
keyboard: pass — 25 Tab stops in main = 25 visible controls (the search box, then Message and Call per row); typing a first name in the search box left 1 row; Enter on Message opened /social/dms/social:dm:u-operator:u-sana
empty-state: n/a — the roster always holds the viewer (a session stands in social only with a social grant); the page's "Nobody here yet" state is for a tenant with no grants and cannot be reached from inside it
realtime: pass — 0.37s: u-sana (Sana Iqbal) opened /social/channels in their own context and "Here now" went from 1 to 2 with no reload; their row reads "SI Sana Iqbal Participant Here now Message Call"
role-gating: Message (PostMessage) and Call (StartCall) on every other person's row — every social role holds both; none on your own row
notes: Presence is the workspace channel social:lobby, which SocialLayout joins on every social page; the roster is GET /api/social/people (13 people holding a social grant).
