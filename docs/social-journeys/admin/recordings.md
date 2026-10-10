surface: recordings
role: admin
user: u-operator
url: /social/recordings
pages: portal/src/pages/social/RecordingsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/RecordingsPane.tsx
audited: 2026-10-07 03:11Z → 03:12Z, Chromium 1680×940, Playwright headless, a separate signed-in context per user (second context u-sana); Tilt stack: Vite :5183 over middleware :3001 (mock providers) with the real SFU :3902 and platform-api :23001
session: /api/session/me sub u-operator, tenant social, role admin
screenshot: recordings.jpg
verdict: limited — the surface renders and its empty state, role gating and keyboard were observed; the recording list, playback, Share/Delete and Summarize could not be observed because platform-api holds no recordings in this stack
console errors: 0
layout: pass — content column x=200px, width 1480px, top 70px, bottom 893px; rail 300px at x=200 (0px from content start), y=70, height 823; pane x=500, width 1180; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / viewport height 940; footer row y=894–940px (1680px wide)
keyboard: pass — physical Tab sweep reached 28 distinct controls in main against 38 visible enabled interactive elements (roving-focus rows and disabled controls are skipped by Tab); first stops: social-new-dm, social-rail-search, social-chat-rail-shelf-activ, social-chat-rail-shelf-menti, social-chat-rail-shelf-calls, social-chat-rail-shelf-recor, rail-section-header-toggle, social-active-now-person-u-j, social-team-tree-heading-tog
empty-state: pass — the list (platform-api source "platform", 0 recordings) renders: Recordings 0 recordings Recorded calls you were on, and who they are shared with. No recordings yet A recorded call lands here for everyone who was on it. Nothing you wer
realtime: n/a — the list polls every 30s; no push delivery is claimed
role-gating: Share controls 0, Delete controls 0 in DOM (nothing to act on); POST /api/social/recordings/no-such/share → 404
runtime-limit: platform-api returned zero recordings for this user, so the recording list, player, Share/Delete and the Summarize action (docs/agentic-flows-migration.md slice 7) could not be observed against real data; the earlier mock fixtures are not used while the platform source is configured. Open: platform-api receives no LVS recording webhook from the local SFU (DEFECTS #5)
environment: Tilt stack, DEV_OFFLINE with registered mock providers for chat/directory; rooms, calls and recordings come from the real platform-api and SFU. Mock state was reset per fixture after the walk; walk-created rooms/teams were left for the reviewer.
