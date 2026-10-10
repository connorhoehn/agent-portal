surface: calls
role: admin
user: u-operator (operator)
url: /social/calls (plus a DM call from /social/dms/social%3Adm%3Au-operator%3Au-sana)
pages: portal/src/pages/social/CallsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/CallLogPane.tsx,portal/src/pages/social/useSocialCall.ts,portal/src/pages/social/socialCallLog.ts
audited: 2026-10-08 11:45Z → 2026-10-08 11:45Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, fake capture devices, second context u-sana; Tilt stack: Vite :5183 over middleware :3001 (mock providers) with the real SFU :3902 and platform-api :23001
session: /api/session/me sub u-operator, tenant social, role admin
screenshot: calls.jpg
verdict: pass
console errors: 0 — plus 9 expected browser resource error line(s) (404 while a call leg is torn down / refusal probes)
layout: pass — content column x=200px, width 1480px, top 70px, bottom 893px; rail 300px at x=200, y=70, height 823; pane x=500, width 1180; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / viewport height 940; footer row y=894–940px (1680px wide)
type: title 16/400; sizes in main (size/weight×text nodes): 14/400×55, 12/600×15, 10/600×13, 11/600×11, 12/400×9, 13/500×8, 11/400×8, 13/600×8, 15/600×7, 16/400×5, 14/500×3, 11/500×2, 20/600×1
keyboard: pass — physical Tab sweep from the start of main reached 35 distinct controls against 35 Tab stops (49 really-visible interactive elements); first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-options, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle
empty-state: pass — the Missed filter shows 1 row(s); All shows 13 row(s) (the live platform-api log; the empty list itself was not forced because that needs a mock scenario on the shared stack)
realtime: pass — real DM call: the callee's incoming-call toast appeared in 0.22s, Accept + Join drew the call dock on both sides (0.12s); second ring: caller hung up before an answer, the callee's toast appeared in 0.28s and cleared in 0.04s
role-gating: StartCall: the DM header's audio and video call buttons are enabled; the call log is readable; Create channel controls 1, New team 1, New room 1
call-log: source platform; 13 rows before the walk, 14 after; newest: ["Sana Iqbal Outgoing Answered Oct 8, 7:45 AM 4s Call back","Sana Iqbal Outgoing Answered Oct 7, 9:38 AM — Call back","Sana Iqbal Outgoing Answered Oct 6, 11:13 PM — Call back"]; page: Calls Call someone Calls you placed, answered or missed in this workspace. Start a new one from a person or a conversation, or join a room. All Missed WHO DIRECTION OUTCOME WHEN LENGTH ACTIONS Sana Iq
media: callee toast: “Platform Operator is calling Audio call Decline Accept”. with fake devices both docks drew (0.12s after Join), dock reads “Sana Iqbal 2 people · 00:03 Share People 2 Leave You Sana Iqbal”, 8 tile/video element(s) on the caller's side, mic control present: 1. Real SFU media with fake capture devices; no audio content is verifiable headless. After Leave the dock shows its ended state (1) and Dismiss clears it.
notes: Every field above was observed in this pass, not carried forward. Recording playback is a separate surface (recordings logs).
