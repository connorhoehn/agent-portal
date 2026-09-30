surface: calls
role: community-admin
user: u-mira
url: /social/calls
pages: portal/src/pages/social/CallsPage.tsx,portal/src/pages/social/useSocialCall.ts,portal/src/pages/social/socialCallLog.ts
audited: 2026-09-30 04:42Z → 04:42Z, Chromium 1552×958 (Playwright headless, one fresh context per user — not the shared Chrome tab), middleware dev:mock:social on :3001 with the `social` compose profile up (platform-api :23001, DynamoDB Local :8000, host SFU :3901), Vite :5183
session: /api/session/me sub u-mira, tenant social, role community-admin
screenshot: calls.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; no horizontal scroll (scrollWidth 1552 = innerWidth 1552); the call log is the library DataTable under a SegmentedControl (All / Missed)
keyboard: pass — 8 Tab stops in main = 8 visible controls (:Call someone, social-calls-filter-all:All, social-call-back:Open room, social-call-back:Open room…); the toast's Decline was pressed by keyboard-reachable button; the Missed segment filters to undefined row(s) and All restores
empty-state: pass — this user's log is not empty (Town hall Joined Answered Sep 30, 12:42 AM 10s Open room Town hall Joined Answer…); the empty state observed live the same minute as u-farah (a participant with no calls in the partition): "No calls yet — Calls you place or receive in this workspace, and the ones you missed, are listed here." with Call someone
realtime: pass — 0.11s: u-sana (Sana Iqbal) pressed Call on this user's Contacts row and the shell's IncomingCallToast ("Sana Iqbal is calling Video call Decline Accept") appeared on /social/calls with no reload; Decline removed it (1ms). A second ring left unanswered timed out at 26ms (the library's 60s ring timeout) and the caller's report wrote this user's "Incoming · Missed" row; the page then shows the "1 missed" chip
role-gating: every social role holds StartCall — Call back (a DM call rings the same people) and Open room (a room is walked back into) render for each row; "Call someone" goes to Contacts
notes: Rows come from platform-api's /api/calls/log through GET /api/social/calls, which keeps social: lobbies only. A declined ring leaves no row: useConversationCall fires no callback for a decline (only for answered, ended and no-answer), so nothing reports it.
