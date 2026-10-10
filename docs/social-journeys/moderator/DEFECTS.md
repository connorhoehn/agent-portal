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

## Closed in lane E (re-walk on realtime-modules 0.99.3, 2026-09-30 08:00Z)

- #1 teardown 404s — closed: Leave's DELETEs now go to the SFU (http://localhost:3901/api/channels/arn%3Alocal%3Aivs%3Achannel%2F<id>/whep/<id>; http://localhost:3901/api/channels/arn%3Alocal%3Aivs%3Achannel%2F<id>/whip/<id>); 0 console errors, no WHIP/WHEP response ≥400.
- #2 second arrival ~3s — closed: 0.10s from the peer going live to “2 people” on this dock (bar 2s).
- #3 tiles named by SFU id — closed: the remote tile reads the display name (“Town hall 2 people Share People 2 Leave You Mira Okafor”).

# Defects — headless re-walk (2026-10-06, Tilt stack :5183/:3001 with the real SFU and platform-api)

Found re-observing every conversation, calls, rooms, recordings, contacts,
teams and bell log. Numbered per this walk; no product code was changed.

1. **A DM's rail row and unread badge do not update live while another
   conversation is open** [portal / realtime-modules]. With the viewer on
   `#general`, the peer's DM reached the BFF (`GET /api/social/dms` showed the
   new `lastMessagePreview` and `unreadCount: 2`), but the rail row kept its old
   preview and the shell bell stayed at its old count for 40–55s; a reload showed
   the row. The 2026-10-01 walk saw the badge arrive live. The dms log records
   the measured delay as `verdict: fail — unread`.
2. **`/summarize last banana` is refused silently** [portal / ui-components].
   The command is not run and nothing is sent; the draft stays in the composer,
   but the old "Give a range like …" explanation no longer renders anywhere
   (`portal/e2e/social-summarize.spec.ts` still expects it).
3. **"Maximum update depth exceeded" logged intermittently** [unconfirmed owner:
   shell or ui-components]. Seen five times across the walk: community-admin
   Teams and Rooms, moderator Calls and DMs, participant Teams. Each was in a
   run that also had a middleware restart (`ws://localhost:3001/ws`
   `ERR_CONNECTION_REFUSED`) or a live call/team chat in flight. NOT reproduced
   in a stable-server pass: four page loads as u-mira (`/social/teams`,
   `/social/rooms`, a team channel, a room), five loads of every Social
   route, and a full DM call + hang-up + Calls page cycle as u-lena/u-sana all
   logged 0 such errors. Logs for the affected surfaces were re-run on a stable
   server and record the result of that run.
   **Root cause found 2026-10-06 (reproduced):** a burst of `social:lobby`
   presence frames (reconnects and call joins send them) re-mirrored the roster
   from a passive effect in the shell's `ShellSocialPresence`
   (`portal/src/components/shell/EmbeddedSocial.tsx`) on every frame, and the
   ui-components `AddPeoplePicker` effect re-set its picked list on every
   workspace render. Together they chained more than 50 passive updates (measured
   up to 142). The mirror now publishes only a changed list, from the layout
   phase (chain now 2-3); regression `portal/e2e/social-presence-burst.spec.ts`.
   The `AddPeoplePicker` effect is still queued for ui-components.
4. **No recordings to observe** [environment, same as #5 above]. platform-api
   returns zero recordings for these users, so the Recordings list, player,
   Share/Delete and the Summarize action cannot be observed; the three
   recordings logs stay `verdict: limited`.
5. **Middleware restarts during walks** [environment]. Another agent's edits
   restart the BFF every few minutes; each restart drops `/ws` and fails the
   page-visible console with `ERR_CONNECTION_REFUSED`. Surfaces hit by one were
   re-run.

## Closed in the 2026-10-06 evening re-walk (headless Chromium 1680x940, two sessions, no code changes)

- #1 DM rail row / unread badge not live: closed. With u-lena on #general; u-sana DMs her, the rail row updated with no navigation in 0.15s: "SI Sana Iqbal 15:09 journey unread mux1yxj7 1" (unread badge 1). Observed in the dms log's `unread:` field (socialRailLive.ts refetch).
- #2 `/summarize last banana` refused silently: closed. The "Give a range like ..." explanation renders, the draft stays in the composer, and nothing is sent as a message (channels log, `slash-bad-range`).
- #3 "Maximum update depth exceeded": still open and now reproducible for the participant and community-admin roles on the Calls and Channels pages (participant calls 5, channels 1; community-admin calls 3, channels 1). Those four logs are `verdict: fail — console errors`. Not seen for moderator or admin in this pass.
- Environment: BFF restarts by other sessions again dropped `/ws` mid-walk (ERR_CONNECTION_REFUSED); affected surfaces were re-run on a stable server where that was possible.


## Final re-walk (2026-10-06 late, headless Chromium 1680x940, no code changes)

- #3 "Maximum update depth exceeded": closed for this role. After the presence-burst fix and ui-components 2.422.0, every moderator surface re-walked on a stable BFF (calls, channels, dms, rooms, teams, recordings) logged 0 such errors; the same holds for the participant, community-admin and admin surfaces re-walked in this pass (the logs record 0 console errors). The only console errors seen came from BFF restarts by other sessions (`ERR_CONNECTION_REFUSED`, then 401s from a restarted signing key) and those surfaces were re-run on a stable server. The `AddPeoplePicker` ui-components queue row is unchanged.
- #4 recordings: still limited. platform-api returns zero recordings, and the mock recording fixtures are not served while the platform source is configured, so the room-recording summary cannot be observed.

## Open — 2026-10-08 re-walk

1. `/social/channels`, `/social/dms`, `/social/teams`, `/social/calls` · type scale · chat rail and conversation use 11/400, 11/500, 11/600, 13/500, 13/600, 15/600 (contract offenders "scale rail …"), plus 8/600 and 5/600 badge text and 10/600 labels; the conversation page has no 20/600 title (its h1 measures 16/400).
2. Call dock · after Leave the dock stays in an "ended" state until Dismiss is clicked (new behaviour; the earlier logs expected it to vanish). Recorded, not a failure.
3. `/social/channels/general` as admin (`u-operator`) · the admin is not a member, so the pane reads "You are not in #general" with a Join button; the walk joined to test chat (membership write left in place).
