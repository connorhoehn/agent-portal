surface: channels
role: participant
user: u-sana
url: /social/channels/general
pages: portal/src/pages/social/ChannelsPage.tsx,portal/src/pages/social/SocialConversation.tsx,portal/src/pages/social/socialChat.ts
audited: 2026-09-30 03:31Z → 03:31Z, Chromium 1552×958 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 (memory chat store, fixture-backed), Vite :5183
session: /api/session/me sub u-sana, tenant social, role participant
screenshot: channels.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; conversation list (library ConversationRail, a list inside the page — not a navigation rail, no StackedRail) 288px at 224px (0px from content start); no horizontal scroll (scrollWidth 1552 = innerWidth 1552); composer at y 704–744px of 958, in view with no body scroll (scrollHeight 958)
keyboard: pass — 7 distinct Tab stops inside main (the list's one tabbable row, Leave, the message history, the composer and its formatting toolbar); the page counts 5 visible controls outside the composer toolbar, the list's other rows among them behind a roving tabindex — ArrowDown walks them (#general → #moderators → #design-reviews, checked on the moderator's list) and Enter on the focused #general row opened /social/channels/general
empty-state: pass — POST /api/__mock/scenario {scenario:empty, fixture:social.channels} → 200: "No channels yet" — "Channels are where a community talks in the open. None exist in this workspace yet; a moderator can create one.", no create action for this role; restored with POST /api/__mock/reset {fixture:social.channels} → 200; /social/channels/no-such-channel renders "#no-such-channel is not available"
realtime: pass — 0.01s: u-mira's message, posted from their own context on #general, appeared in this one with no reload; this role's own reply was still there after a reload (1 match — stored, not just relayed)
role-gating: cannot create channels — New channel is absent from the DOM (0 matches) and the empty state offers no create action (Cedar forbids ManageChannels); can join, leave, post. Private #moderators is absent from the list (not a member); list rows: general, design-reviews
notes: Presence avatars in the header (3 presence nodes) show who has the channel open.
