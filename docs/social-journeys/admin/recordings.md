surface: recordings
role: admin
user: u-operator
url: /social/recordings
pages: portal/src/pages/social/RecordingsPage.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/RecordingsPane.tsx
audited: 2026-10-24 15:52–15:53 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-operator (u-operator-clone-b41d291d), second context none for this seeded unavailable-media walk; Tilt stack: Vite :5183 over middleware :3001 (dev:mock), Social platform-api :23002, SFU :3902; mock not reset (shared stack)
session: /api/session/me sub u-operator-clone-b41d291d (a clone of u-operator), tenant social, role admin
screenshot: recordings.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=200, y=44, height 847px (primary rail open); content (SectionContent) starts x=500, width 1180px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940
keyboard: pass — 12 distinct Tab stops against 12 visible interactive controls (first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-shelf-activity); Enter on the focused Design reviews row opened ?recording=2026-10-24T18-17-43-705Z-journey36ae93; Enter on Delete opened the confirm dialog (its text was not captured by the walker), Escape closed it and focus went to social-recording-delete
empty-state: pass — a browser-side stub of GET /api/social/recordings answering zero rows (this context only) rendered "No recordings yet A recorded call lands here for everyone who was on it. Nothing you were on has been recorded in this workspace."; ?recording=no-such-recording rendered "This recording is not available It does not exist, or you were not on the call."
realtime: n/a — the list polls every 30s; no push delivery is claimed
role-gating: ManageRecordings: Share on 2 rows, Delete on 2 rows (Delete shows only where this user started the recording, platform-api's owner rule); Share answered "Share link ready (valid until 10/31/2026): /recordings/share/fINWYswmBgYghR1MSDG7SFJaHMB1CbGq ✕";  Delete through the confirm dialog (the first Delete in the list) removed 1 seeded row(s): 2026-10-24T19-22-43-743Z-journeyd07290 (the list then held 1 of this user's recordings)
list: 2 recordings from source "platform"; rows: "Failed 5m 12s Sana Iqbal 2 Oct 24, 3:22 PM Share Delete Failed 12m 34s design-reviews 2 Oct 24, 2:17 PM Share Delete"
player: opened 2026-10-24T18-17-43-705Z-journey36ae93: "design-reviews Summarize 10/24/2026, 2:17:43 PM Nothing to play There is no playable file for this recording. Length 12m 34s People Operator, Sana Iqbal Started by u-operator-clone-b41d291d Expires 11"; the player area read "Nothing to play There is no playable file for this recording." (GET …/playback → 200 {"recordingId":"2026-10-24T18-17-43-705Z-journey36ae93","playlistUrl":null,"mediaState":"unavailable"}); facts "Length 12m 34s People Operator, Sana Iqbal Started by u-operator-clone-b41d291d Expires 11/23/2026"; Summarize disabled ("The transcript is not ready yet.")
seeded: the two rows on this walk were seeded (seed.sh, through platform-api's CallRecordingRepository.putRecording into the Social DynamoDB): 2026-10-24T18-17-43-705Z-journey36ae93, 2026-10-24T19-22-43-743Z-journeyd07290; they carry no media and composeStatus failed, so the stage reads failed and the player has nothing to play. This is not a media playback. 2026-10-24T19-22-43-743Z-journeyd07290 was deleted through the UI's Delete; the other seeded row was removed afterwards with unseed-recordings.ts.
real-path: Real capture and playback are tracked separately in .scratch/social-handoff-2026-10-24/real-recording.json; this log exercises rows intentionally seeded without media.
notes: Not exercised: real media playback (these seeded rows have no media), the Summarize run (disabled while the stage is not ready). 53 /api/social requests on this walk.
