surface: recordings
role: participant
user: u-sana
url: /social/recordings
pages: portal/src/pages/social/RecordingsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/RecordingsPane.tsx
audited: 2026-10-24 14:13–14:16 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-sana (u-sana-clone-bba97303), second context none for this seeded unavailable-media walk; Tilt stack: Vite :5183 over middleware :3001 (dev:mock), Social platform-api :23002, SFU :3902; mock not reset (shared stack)
session: /api/session/me sub u-sana-clone-bba97303 (a clone of u-sana), tenant social, role participant
screenshot: recordings.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=200, y=44, height 847px (primary rail open); content (SectionContent) starts x=500, width 1180px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940
keyboard: pass — 8 distinct Tab stops against 8 visible interactive controls (first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-shelf-activity); Enter on the focused Design reviews row opened ?recording=2026-10-24T16-38-54-409Z-journeydd14a9
empty-state: pass — a browser-side stub of GET /api/social/recordings answering zero rows (this context only) rendered "No recordings yet A recorded call lands here for everyone who was on it. Nothing you were on has been recorded in this workspace."; ?recording=no-such-recording rendered "This recording is not available It does not exist, or you were not on the call."
realtime: n/a — the list polls every 30s; no push delivery is claimed
role-gating: no ManageRecordings: Share controls 0, Delete controls 0 in the DOM with two recordings listed; POST /api/social/recordings/<a listed id>/share → 403, DELETE /api/social/recordings/<a listed id> → 403
list: 2 recordings from source "platform"; rows: "Failed 5m 12s Mira Okafor 2 Oct 24, 1:44 PM Failed 12m 34s design-reviews 2 Oct 24, 12:38 PM"
player: opened 2026-10-24T16-38-54-409Z-journeydd14a9: "design-reviews Summarize 10/24/2026, 12:38:54 PM Nothing to play There is no playable file for this recording. Length 12m 34s People Sana Iqbal, Mira Okafor Started by u-sana-clone-bba97303 Expires 11"; the player area read "Nothing to play There is no playable file for this recording." (GET …/playback → 200 {"recordingId":"2026-10-24T16-38-54-409Z-journeydd14a9","playlistUrl":null,"mediaState":"unavailable"}); facts "Length 12m 34s People Sana Iqbal, Mira Okafor Started by u-sana-clone-bba97303 Expires 11/23/2026"; Summarize disabled ("The transcript is not ready yet.")
seeded: the two rows on this walk were seeded (seed.sh, through platform-api's CallRecordingRepository.putRecording into the Social DynamoDB): 2026-10-24T16-38-54-409Z-journeydd14a9, 2026-10-24T17-44-03-905Z-journey023f0b; they carry no media and composeStatus failed, so the stage reads failed and the player has nothing to play. This is not a media playback. Both rows were removed afterwards with unseed-recordings.ts.
real-path: Real capture and playback are tracked separately in .scratch/social-handoff-2026-10-24/real-recording.json; this log exercises rows intentionally seeded without media.
notes: Not exercised: real media playback (these seeded rows have no media), the Summarize run (disabled while the stage is not ready). 84 /api/social requests on this walk.
