surface: dms
role: moderator
user: u-lena
url: /social/dms/social%3Adm%3Au-lena%3Au-sana
pages: portal/src/pages/social/DmsPage.tsx,portal/src/pages/social/SocialConversation.tsx,portal/src/pages/social/socialChat.ts
audited: 2026-09-30 03:31Z → 03:32Z, Chromium 1552×958 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 (memory chat store, fixture-backed), Vite :5183
session: /api/session/me sub u-lena, tenant social, role moderator
screenshot: dms.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; conversation list (library ConversationRail, a list inside the page — not a navigation rail, no StackedRail) 288px at 224px (0px from content start); no horizontal scroll (scrollWidth 1552 = innerWidth 1552); composer at y 666–706px of 958, in view with no body scroll (scrollHeight 958)
keyboard: pass — 7 distinct Tab stops inside main (New message, the list's tabbable row, the message history, the composer and its formatting toolbar) against 6 visible controls counted outside the composer toolbar, the list's other rows behind its roving tabindex (ArrowDown); Enter on the focused row opened /social/dms/social%3Adm%3Au-lena%3Au-sana; Escape closed the New message picker
empty-state: pass — POST /api/__mock/scenario {scenario:empty, fixture:social.channel-messages} → 200: "No direct messages yet" — "A direct message is visible only to the people in it. You have not started one here." with a New message action; restored with POST /api/__mock/reset {fixture:social.channel-messages} → 200; a lobby that does not name this user (/social/dms/social%3Adm%3Au-farah%3Au-theo) renders "This conversation is not yours"
realtime: pass — 0.01s out to u-sana, 0.01s back, both without a reload
role-gating: every social role may DM (PostMessage); nothing on this page is role-gated. New message → the roster picker (GET /api/social/people, this user left out) → POST /api/social/dms → the sorted lobby social:dm:u-lena:u-sana
unread: pass — while this user was on /social/channels, u-sana wrote again; on /social/dms the row read "SISana Iqbal23:31walk unread moderator 17907391182811…" with the library's unread badge (conversation-unread:1:; GET /api/social/dms unreadCount 1); opening the DM (POST /api/social/dms/read) took it to 0
notes: DM list before: social:dm:u-lena:u-mira, social:dm:u-lena:u-sana; after the round trip and a reload the list carries social:dm:u-lena:u-sana with the reply as its preview (the conversations index). The header bell also counts the DM ("Activity, 1 unread") and is not cleared by opening the DM — the bell's own read state, lane N's.
