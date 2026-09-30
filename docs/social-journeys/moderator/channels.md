surface: channels
role: moderator
user: u-lena
url: /social/channels/general
pages: portal/src/pages/social/ChannelsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialConversation.tsx,portal/src/pages/social/socialChat.ts
audited: 2026-09-30 12:40Z → 12:42Z, Chromium 1672×941 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api, DynamoDB Local, host SFU), Vite :5183
session: /api/session/me sub u-lena, tenant social, role moderator
screenshot: channels.jpg
verdict: pass
console errors: 0
layout: pass — chat rail (library ConversationRail) 300px at x=200, flush against the 200px shell rail (content col left 200, 0px from content start), top 70 = content top 70, 871px tall = the full content height (no page header, shell crumbs off); pane 1172px at x=500; no horizontal scroll (scrollWidth 1672 = innerWidth 1672); composer at y 871–913px of 941, in view with no body scroll (scrollHeight 941)
keyboard: pass — 27 distinct Tab stops from the rail's Find box through main (first: Find a chat, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle…) against 48 visible controls in main — the rail's conversation rows and the tree sit behind roving tabindexes (ArrowDown walks them), so fewer stops than controls is the design; Enter on the focused #general row opened /social/channels/general; Escape closed the New channel dialog
empty-state: pass — POST /api/__mock/scenario {scenario:empty, fixture:social.channels} → 200: "No channels yet Channels are where a community talks in the open. None exist in this workspace yet — create the first one. Create a channel" with a Create a channel action; restored with POST /api/__mock/reset {fixture:social.channels} → 200; /social/channels/no-such-channel renders "#no-such-channel is not available This channel does not exist, or it is private and you are not a member."
realtime: pass — <0.01s: Sana Iqbal's message, posted from their own context on #general, appeared in this one with no reload; this role's own reply was still there after a reload (found in <0.01s — stored, not just relayed)
role-gating: can create channels: the Channels section's + (social-create-channel) opened the library CreateChannelDialog anchored to it (True) and Escape closed it (True); join, leave (⋯ menu), post. Rail rows under CHANNELS: #general, #auth-migration, #moderators, #design-reviews
notes: the conversation header (library WrappedConversationSurface) carries the tabs Chat | Documents | Pinned | Calls; Documents → URL ?view=documents (the view is in the URL), Chat restores it; audio-call 1 + video-call 1 actions; the ⋯ menu lists Leave #general and Escape closed it (yes). The whole page is the chat workspace: shelf (Activity, Mentions, Calls, Recordings), Active now, Teams, Rooms, Direct messages, Channels in one rail.
