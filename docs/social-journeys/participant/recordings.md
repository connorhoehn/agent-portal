surface: recordings
role: participant
user: u-sana
url: /social/recordings
pages: portal/src/pages/social/RecordingsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/RecordingsPane.tsx
audited: 2026-09-30 12:38Z → 12:40Z, Chromium 1672×941 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api, DynamoDB Local, host SFU), Vite :5183
session: /api/session/me sub u-sana, tenant social, role participant
screenshot: recordings.jpg
verdict: pass
console errors: 0
layout: pass — chat rail (library ConversationRail) 300px at x=200, flush against the 200px shell rail (content col left 200, 0px from content start), top 70 = content top 70, 871px tall = the full content height (no page header, shell crumbs off); pane 1172px at x=500; no horizontal scroll (scrollWidth 1672 = innerWidth 1672)
keyboard: pass — 17 distinct Tab stops from the rail's Find box through main (first: Find a chat, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle…) against 25 visible controls in main — the rail's conversation rows and the tree sit behind roving tabindexes (ArrowDown walks them), so fewer stops than controls is the design; the empty state carries no action (recordings are made by calls, not here)
empty-state: pass — "No recordings yet A recorded call lands here for everyone who was on it. Nothing you were on has been recorded in this workspace." (GET /api/social/recordings: source platform, 0 recordings); /social/recordings?recording=no-such-recording renders "No recordings yet A recorded call lands here for everyone who was on it. Nothing you were on has been recorded in this workspace."
realtime: n/a — the list polls every 30s; nothing on it is pushed
role-gating: no ManageRecordings: rows carry no Share/Delete (0 Share controls on screen)
notes: The page is the chat workspace with the shelf's Recordings destination open (the library RecordingList + RecordingPlayer in the pane). The walk's room calls produced no recording — platform-api received no LVS recording webhook in this stack — so the player's states are covered by the route tests against the fixtures (routes/__tests__/social-platform.test.ts).
