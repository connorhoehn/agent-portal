surface: recordings
role: admin
user: u-operator
url: /social/recordings
pages: portal/src/pages/social/RecordingsPage.tsx
audited: 2026-09-30 04:47Z → 04:47Z, Chromium 1552×958 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api :23001, DynamoDB Local :8000, host SFU :3901), Vite :5183
session: /api/session/me sub u-operator, tenant social, role admin
screenshot: recordings.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; no horizontal scroll (scrollWidth 1552 = innerWidth 1552); the empty state full width
keyboard: pass — 0 controls in main to reach: the empty state carries no action (recordings are made by calls, not here)
empty-state: pass — "No recordings yet — A recorded call lands here for everyone who was on it. Nothing you were on has been recorded in this workspace." (GET /api/social/recordings: source platform, 0 recordings)
realtime: n/a — the list polls every 30s; nothing on it is pushed
role-gating: ManageRecordings: rows would carry Share, and Delete when this user started the recording (none to show)
notes: The walk's room calls (two people, up to 25s, platform-api reported recording "default-on") produced no recording — platform-api received no LVS recording webhook in this stack — so a recording could not be played; the list, the player's "Nothing to play" state, Share and Delete are covered by the route tests against the fixtures (routes/__tests__/social-platform.test.ts) and the e2e asserts the list renders for the tenant.
