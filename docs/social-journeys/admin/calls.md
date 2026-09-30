surface: calls
role: admin
user: u-operator
url: /social/calls
pages: portal/src/pages/social/CallsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/CallLogPane.tsx,portal/src/pages/social/useSocialCall.ts,portal/src/pages/social/socialCallLog.ts
audited: 2026-09-30 12:42Z → 12:44Z, Chromium 1672×941 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api, DynamoDB Local, host SFU), Vite :5183
session: /api/session/me sub u-operator, tenant social, role admin
screenshot: calls.jpg
verdict: pass
console errors: 0
layout: pass — chat rail (library ConversationRail) 300px at x=200, flush against the 200px shell rail (content col left 200, 0px from content start), top 70 = content top 70, 871px tall = the full content height (no page header, shell crumbs off); pane 1172px at x=500; no horizontal scroll (scrollWidth 1672 = innerWidth 1672); the call log (library DataTable under a SegmentedControl) fills the pane
keyboard: pass — 20 distinct Tab stops from the rail's Find box through main (first: Find a chat, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle…) against 29 visible controls in main — the rail's conversation rows and the tree sit behind roving tabindexes (ArrowDown walks them), so fewer stops than controls is the design; the Missed segment filtered to 1 row(s) and All restored the log
empty-state: pass — this user's log is not empty (4 rows, 1 missed); the Missed filter with no missed rows reads "No missed calls.", and an empty log renders "No calls yet — Calls you place or receive in this workspace, and the ones you missed, are listed here." with Call someone (observed as u-operator, admin log)
realtime: pass — 0.03s: Sana Iqbal pressed the new audio-call action in the DM's conversation header and the shell's IncomingCallToast ("Sana Iqbal is calling Audio call Decline Accept") appeared on /social/calls with no reload; Decline by keyboard (focus + Enter) removed it (True)
role-gating: every social role holds StartCall — 4 Call back / Open room controls render; "Call someone" goes to Contacts. The shelf's Calls is the selected rail item on this route, with the missed count as its badge
notes: Rows come from platform-api's /api/calls/log through GET /api/social/calls, which keeps social: lobbies only. The page is the chat workspace with the shelf's Calls destination open; the ring came from a DM header's audio-call action (SocialConversation → useSocialCall.callPeople, audioOnly).
