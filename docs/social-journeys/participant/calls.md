surface: calls
role: participant
user: u-sana (Sana Iqbal)
url: /social/calls (plus a DM call from /social/dms/social%3Adm%3Au-mira%3Au-sana)
pages: portal/src/pages/social/CallsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/CallLogPane.tsx,portal/src/pages/social/useSocialCall.ts,portal/src/pages/social/socialCallLog.ts
audited: 2026-10-08 11:43Z → 2026-10-08 11:44Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, fake capture devices, second context u-mira; Tilt stack: Vite :5183 over middleware :3001 (mock providers) with the real SFU :3902 and platform-api :23001
session: /api/session/me sub u-sana, tenant social, role participant
screenshot: calls.jpg
verdict: pass
console errors: 0 — plus 8 expected browser resource error line(s) (404 while a call leg is torn down / refusal probes)
layout: pass — content column x=200px, width 1480px, top 70px, bottom 893px; rail 300px at x=200, y=70, height 823; pane x=500, width 1180; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / viewport height 940; footer row y=894–940px (1680px wide)
type: title 16/400; sizes in main (size/weight×text nodes): 14/400×407, 12/600×103, 10/600×103, 11/600×12, 13/600×12, 11/400×11, 12/400×11, 13/500×10, 15/600×7, 16/400×5, 11/500×4, 14/500×3, 20/600×1
keyboard: pass — physical Tab sweep from the start of main reached 124 distinct controls against 124 Tab stops (144 really-visible interactive elements); first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-options, social-chat-rail-shelf-activity, social-chat-rail-shelf-mentions, social-chat-rail-shelf-calls, social-chat-rail-shelf-recordings, rail-section-header-toggle
empty-state: pass — the Missed filter shows 2 row(s); All shows 101 row(s) (the live platform-api log; the empty list itself was not forced because that needs a mock scenario on the shared stack)
realtime: pass — real DM call: the callee's incoming-call toast appeared in 0.19s, Accept + Join drew the call dock on both sides (0.10s); second ring: caller hung up before an answer, the callee's toast appeared in 0.28s and cleared in 0.00s
role-gating: StartCall: the DM header's audio and video call buttons are enabled; the call log is readable; Create channel controls 0, New team 0, New room 1
call-log: source platform; 101 rows before the walk, 102 after; newest: ["Mira Okafor Outgoing Answered Oct 8, 7:44 AM 4s Call back","Mira Okafor Incoming Answered Oct 8, 7:42 AM 4s Call back","Lena Brandt Incoming Answered Oct 8, 7:42 AM 4s Call back"]; page: Calls Call someone Calls you placed, answered or missed in this workspace. Start a new one from a person or a conversation, or join a room. All Missed (2) WHO DIRECTION OUTCOME WHEN LENGTH ACTIONS Mir
media: callee toast: “Sana Iqbal is calling Audio call Decline Accept”. with fake devices both docks drew (0.10s after Join), dock reads “Mira Okafor 2 people · 00:03 Share People 2 Leave You Mira Okafor”, 8 tile/video element(s) on the caller's side, mic control present: 1. Real SFU media with fake capture devices; no audio content is verifiable headless. After Leave the dock shows its ended state (1) and Dismiss clears it.
notes: Every field above was observed in this pass, not carried forward. Recording playback is a separate surface (recordings logs).
