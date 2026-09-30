surface: dms
role: community-admin
user: u-mira
url: /social/dms/social%3Adm%3Au-mira%3Au-sana
pages: portal/src/pages/social/DmsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SocialConversation.tsx,portal/src/pages/social/socialChat.ts
audited: 2026-09-30 12:36Z → 12:38Z, Chromium 1672×941 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api, DynamoDB Local, host SFU), Vite :5183
session: /api/session/me sub u-mira, tenant social, role community-admin
screenshot: dms.jpg
verdict: pass
console errors: 0
layout: pass — chat rail (library ConversationRail) 300px at x=200, flush against the 200px shell rail (content col left 200, 0px from content start), top 70 = content top 70, 871px tall = the full content height (no page header, shell crumbs off); pane 1172px at x=500; no horizontal scroll (scrollWidth 1672 = innerWidth 1672); composer at y 794–913px of 941, in view with no body scroll (scrollHeight 941)
keyboard: pass — 26 distinct Tab stops from the rail's Find box through main (first: Find a chat, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle…) against 47 visible controls in main — the rail's conversation rows and the tree sit behind roving tabindexes (ArrowDown walks them), so fewer stops than controls is the design; Enter on the focused row opened /social/dms/social%3Adm%3Au-mira%3Au-sana; Escape closed the New message picker
empty-state: pass — POST /api/__mock/scenario {scenario:empty, fixture:social.channel-messages} → 200: "No direct messages yet A direct message is visible only to the people in it. You have not started one here. New message"; restored with POST /api/__mock/reset → 200; a lobby that does not name this user (/social/dms/social%3Adm%3Au-farah%3Au-theo) renders "This conversation is not yours A direct message opens only for the people it names."
realtime: pass — <0.01s out to u-sana, <0.01s back, both without a reload
role-gating: every social role may DM (PostMessage); nothing on this page is role-gated. New message (the rail caption's +, and the DIRECT MESSAGES section's +) → the roster picker → POST /api/social/dms → the sorted lobby social:dm:u-mira:u-sana
unread: pass — while this user was on /social/channels, u-sana wrote again; on /social/dms the row read "SI Sana Iqbal 08:36 walk community-admin unread 1790771815794 1" with the library's unread badge (conversation-unread:1; GET /api/social/dms unreadCount 1); opening the DM (POST /api/social/dms/read) took it to 0
notes: the conversation header (library WrappedConversationSurface) carries the tabs Chat | Documents | Pinned | Calls; Documents → URL ?view=documents (the view is in the URL), Chat restores it; audio-call 1 + video-call 1 actions; the DM carries no ⋯ menu (nothing to leave). The DM row carries the peer's avatar with a presence dot (online while they stand in the workspace).
