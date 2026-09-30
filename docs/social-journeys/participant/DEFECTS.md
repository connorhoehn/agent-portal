# Defects — S2 walk (2026-09-30, rooms / calls / contacts / teams / recordings / configuration)

Found walking the S2 surfaces headless against dev:mock:social with the
`social` compose profile up. Numbered per this walk; owners in brackets.

1. **Room call teardown 404s on the portal origin** [realtime-modules].
   Leaving a room call logs `404 DELETE /api/channels/<arn>/whip/<id>` (own
   publish leg) and, when a peer leaves, `404 DELETE …/whep/<id>` — sent to
   the PORTAL (:5183 → the middleware), not the SFU (:3901).
   `client/video/lib/transport.js` returns the SFU's relative `Location`
   header as-is (`r.headers.get('Location')`) and `whipTeardown`/`whepTeardown`
   fetch it, so it resolves against the page. Fix: resolve it against the
   POST URL (`new URL(location, url)`). The SFU never sees the DELETE, so the
   legs linger until it times them out. `docs/social-calls-first-call.md`
   records these 404s as "the SFU had already dropped the resources" — that
   is not what happens. The rooms log fails on this (console errors: 2).
2. **A second person's arrival in a room call takes ~3s** [realtime-modules /
   SFU]. From the peer's dock going live to this dock reading "2 people":
   3.0s on every role — media arrival (the WHEP subscription), over the
   protocol's 2s bar. Signalling-level presence of the peer is not shown on
   the dock.
3. **Room-call tiles are labelled with the SFU participant id**
   (`u-sana-munmjc0n`) [realtime-modules / ui-components]. A room call rings
   nobody, so no invite frame carries display names and the dock has none.
4. **A declined ring leaves no call-log row** [realtime-modules].
   `useConversationCall` fires `onCallStarted`/`onCallEnded`/`onCallMissed`
   for answered, ended and unanswered calls only; a decline is silent, so the
   social host (SocialLayout) has nothing to report. The unanswered ring
   (60s timeout) does produce "Incoming · Missed".
5. **No recording from the local stack's room calls** [environment].
   platform-api says `recording: default-on` on session create, but received
   no LVS recording webhook for calls of up to 25s with two people; the
   Recordings page could only be walked empty. The list/player/share/delete
   paths are covered by the fixture-backed route tests.
