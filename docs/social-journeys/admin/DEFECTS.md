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

## Closed in lane E (re-walk on realtime-modules 0.99.3, 2026-09-30 08:01Z)

- #1 teardown 404s — closed: Leave's DELETEs now go to the SFU (http://localhost:3901/api/channels/arn%3Alocal%3Aivs%3Achannel%2F<id>/whep/<id>; http://localhost:3901/api/channels/arn%3Alocal%3Aivs%3Achannel%2F<id>/whip/<id>); 0 console errors, no WHIP/WHEP response ≥400.
- #2 second arrival ~3s — closed: 0.10s from the peer going live to “2 people” on this dock (bar 2s).
- #3 tiles named by SFU id — closed: the remote tile reads the display name (“Town hall 2 people Share People 2 Leave You Mira Okafor”).

## Re-walk note (2026-10-06, after ui-components 2.422.0)

A first re-walk of Rooms and Calls failed with 21 and 1 console errors while the
middleware on :3001 refused connections mid-run (an outside restart; the second
was an SFU `setRemoteDescription` error in the same window). The repeat on the
stable stack logged 0 console errors, room "2 joined" and a real DM call; the
logs record that repeat.

## Re-walk note (2026-10-07, message edit/delete)

- Minor, open: after Delete the row reads "This message was deleted." but names its sender as the raw client id (e.g. "c_muxlx1", avatar "C_") instead of the person, in channel, DM and team panes, for the author and the peer. Repro: post in #general, hover the row, Delete, confirm. Not fixed here (no code changes in a re-walk); the same row appears in the assessment, orgiq and pipelines panels (see assessment-journeys/lead-assessor/DEFECTS.md).
- The four recordings logs remain `limited` (platform-api holds no recordings in this stack).

## 2026-10-07 01:30 re-walk (deleted-row sender, Forward)

- Closed, deleted-row sender: after Delete the row now names the person, not a client id. Observed for the author and the watching peer in the channel, DM and team panes as u-sana ("SI Sana Iqbal 01:29 This message was deleted."), u-lena ("LB Lena Brandt 01:30 ..."), u-mira ("MO Mira Okafor 01:31 ...") and u-operator ("PO Platform Operator 01:31 ..."); participant/teams was author-only (u-sana is not on the walked team, so no peer watched) and still read "SI Sana Iqbal 01:30 ...". The assessment pane shows the same ("JL Jonas Lindqvist 01:10 ...").
- Forward observed once, u-sana from #general to her DM with u-lena: delivered as a new "Forwarded from #general — Sana Iqbal" message in 0.025 s; see participant/channels.md. In the assessment pane the picker reads "Nowhere to send this" for an assessment session.
- The four recordings logs remain `limited` (platform-api holds no recordings in this stack).
- Residue: forwarded and deleted walk messages remain in #general and the u-lena/u-sana DM; the mock was not reset.

## Open — 2026-10-08 re-walk

1. `/social/channels`, `/social/dms`, `/social/teams`, `/social/calls` · type scale · chat rail and conversation use 11/400, 11/500, 11/600, 13/500, 13/600, 15/600 (contract offenders "scale rail …"), plus 8/600 and 5/600 badge text and 10/600 labels; the conversation page has no 20/600 title (its h1 measures 16/400).
2. Call dock · after Leave the dock stays in an "ended" state until Dismiss is clicked (new behaviour; the earlier logs expected it to vanish). Recorded, not a failure.
3. `/social/channels/general` as admin (`u-operator`) · the admin is not a member, so the pane reads "You are not in #general" with a Join button; the walk joined to test chat (membership write left in place).

# Defects — re-walk of 2026-10-22 (all nine surfaces, headless clones)

Walked as identity clones of the seed personas, with the real u-sana / u-mira / u-theo as second
contexts. These are the defects that keep calls, rooms and recordings from passing; the other
surfaces pass. They are the same for every role unless a role is named.

1. **Social calls draw a broken huddle chat** [middleware]. Every DM and room call opens the
   huddle chat pane reading "This call requires an OrgIQ or assessment session": `GET
   /api/calls/<id>/chat` answers 403 because `middleware/src/lib/call-access.ts:24` admits only
   orgiq and assessment sessions, and platform-api's `POST /api/video/sessions/<id>/call-binding`
   answers 403 too. ~11 console errors per calls walk, 13 per rooms walk. Seed personas see it
   as well (a real u-mira → u-sana call).
2. **The caller cannot leave a call from the DM it runs on** [portal]. The dock above the
   composer hides its header (`social-call-dock-header` is `display:none`), so there is no
   Leave, mic or camera control, and the DM header still offers "Join the call with audio". The
   same dock on /social/calls shows all of them. Regression since the 2026-10-08 walk.
3. **A ring cancelled before an answer leaves no call-log row** [portal / realtime-modules]. The
   callee's bell gets "Missed call from …", but neither call log gets a row and the callee's
   Missed filter stays empty: the caller's page posts no invite or missed event to
   `/api/calls/log/events` for that ring.
4. **Recordings never offer Delete** [platform-api]. The portal shows Delete only when the row's
   `startedBy` is the viewer (`portal/src/pages/social/socialPlatform.ts:233`), but platform-api's
   per-user list is read from the participant index, whose rows carry no `startedBy`
   (`CallRecordingRepository.ts` `participantIndexItems` / `listByUser`). `DELETE
   /api/social/recordings/:id` from the starter answers 204, so only the UI is cut off.
   Moderator, community-admin and admin fail on it.
5. **A recording without media logs a console error when opened** [middleware]. platform-api
   answers the playback-token 404 and the BFF passes it through, so Chromium logs it; the BFF
   could answer `mediaState: 'unavailable'` as its mock path does. The participant's recordings
   log fails on this alone.
6. **Real recorded calls cannot be played** [platform-api / SFU]. A real DM call is now listed
   (the webhook arrives), but with stage failed, `callBindingReason: missing-recorded-participant`,
   no `startedBy`, and playback 404 although the SFU wrote the media under
   `/tmp/orgiq-media-validation-recordings`. With no `startedBy` nobody may delete those rows.
7. **New message picker: Escape drops focus on the page body** instead of returning it to the
   New message button, and the picker lists the viewer's own persona [portal].
8. **An unknown team URL shows no "not found"** (`?channel=social:team:no-such-team:general` reads
   "Pick a channel" or "You are not on a team yet"), unlike unknown channels and DMs [portal].
9. **The room pane's title has no left gutter**: it sits flush at x=500 against the rail [portal].

Walker-only (dev:mock identity clones, not seen by real users): a clone gets no Edit/Delete on
its own messages and its composer keeps the sent text (the gateway stamps the persona, the page
compares the clone id); a clone cannot be added to a team (not in the Social roster); room
detail reads "Opened by u-…-clone-…". A clone's channel joins are recorded for its persona,
which is how the admin walk put u-operator (the layout sweep's user) into #general and moved
the Communication landing; that membership was removed after the walk.
