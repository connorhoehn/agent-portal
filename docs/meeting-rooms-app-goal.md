# Meeting rooms in the app — goal

Set 2026-10-16 by the user ("wire it into the app now"). The library side is
done: realtime-modules `docs/design/meeting-rooms-goal.md` (G1–G21, reviewed)
shipped raise hand, reactions, breakout rooms, room chat, announcements,
organizer authority, rate limits and a live-media proof in realtime-modules
**0.133.0** and ui-components **2.474.0**. This goal brings that into the
portal and the BFF, on the calls people already make.

Judge: `scripts/validate-meeting-rooms-app.sh`, the only judge. `--quick` runs
the static checks; the default also runs the middleware guard tests, the
portal unit tests and the fixture e2e specs (long; run alone). The real-media
acceptance (M5) is a dated record, run on request because it needs the SFU and
platform-api.

## What the app has today (survey 2026-10-16)

- **Calls:** the library's `createCallBlockHost` over `useConversationCall`
  (`portal/src/lib/conversationCall.tsx:15-31`), provided by `ShellCallHost`
  (`components/shell/ShellCallHost.tsx:127`, mounted `Layout.tsx:490`); footer
  controls are the library `HuddleBar` (`SocialFooter.tsx:60,88`), the
  page dock is `<CallBlock placement="block">` (`Layout.tsx:629`), call chat is
  `HuddleChatSplit` / `HuddleChatPanel` (`HuddleChat.tsx:541,583`). Calls live
  on initiative, people, social room/DM, document, assessment team, pipeline,
  deck, search and job pages.
- **Gateway:** `attachRealtime` in `middleware/src/lib/realtime-gateway.ts:308`
  with chat (huddle-wrapped), presence, cursors, `tenantCalls`, reactions,
  activity, pipeline, work graph, notifications. One authority facade
  (`lib/gateway/authority.ts`): `lobbyGuard` `:137`, `channelGuard` `:142`.
- **Lobby admission for media:** platform-api mints LVS tokens
  (`../platform-api/src/routes/videoSessions.ts:630`) after asking the BFF
  (`POST /api/realtime/lobby-access`, `routes/realtime-lobby-access.ts:72`).
- **Names:** lobbies are `orgiq:initiative:<id>` and kin
  (`initiativeCallModel.ts:28`, `documentCommentsModel.ts:179`,
  `socialPlatform.ts:80,100`); huddle chat is `orgiq:huddle:<callId>`
  (`lib/huddleRoster.ts:20`); lobby families match any id with
  `RID = '\S{1,256}'` (`lib/tenant-channels.ts:107,140`).
- **Authority:** no call-host role. Nearest: the stored call's `callerId`
  (`lib/call-pages.ts:453`), `ManageChannels`/`ManageRecordings`
  (moderator, community-admin; `authz.ts:76-78`), initiative stewards
  (`routes/sprints.ts:65`).
- **Pins:** ui-components 2.460.1 (has the components, not
  `withMeetingHands`/`useMeetingChat`), realtime-modules 0.120.1 (no meeting).

## Already done

- **M1 (2026-10-16):** realtime-modules **0.134.0** — L1 `useConversationCall({ mediaLobby })` moves a call's media to a breakout lobby in place (same `callId`, no ring, no call frames; serialized moves, latest wins) and L3 `breakoutChannel` / `parseBreakoutChannel` plus `useMeeting({ chatChannel })`; ui-components **2.475.0** `HuddleBar meetingItems` and **2.476.0** the call host's meeting (`CallBlockModules.useMeeting`, `CallHostProviderProps.meeting`, `useCallHost().meeting`, media following `activeLobby`) — lane L2. Known limits from L1: no `participant-state` after a move (tiles still match by the SFU's user id), the recording binding reports unavailable inside a breakout. ui-components **2.477.0** adds the seams the portal draft found missing — **L4** `CallMediaOutlet` `header` (stage toolbar and room banner above the expanded dock), `extras`, `notice`, and hands on tiles from the call's meeting; **L5** `WrappedChatPanel` `transformMessages` and `dock`; **L6** `meeting.enabledFor(lobbyName)`; **2.478.0** (L7) `MeetingToolbar onLeave` optional, so the stage toolbar above the dock adds no second Leave.

- **Drafted, not merged (2026-10-16):** M2 on `plan/meeting-rooms-app` (`1359876b` B1–B4, `5767cd75` room chat end to end: membership, sends, frame filter, teardown; 31 new middleware tests) and M3 for initiative huddles on `plan/meeting-rooms-portal` (footer meeting items, stage header with `MeetingToolbar` + room banner via `CallMediaOutlet header`, hands from the host, room chat following `activeChat` with announcements via `transformMessages` and the dock, `VITE_MEETING_ROOMS` + `enabledFor` gate). Both wait for M0 (pins) and land then. Open from the drafts: pins and summarize refuse room chats; `GET /api/calls/:callId/chat` returns only the main huddle; a room's history starts at the call join; no recording signal yet for `RecordingConsentNotice`.

## Decisions this goal makes (change them here, not in code)

1. **A meeting is a call.** `meetingId` is the call's LVS lobby name. A
   breakout room's lobby is `<lobby>~breakout~<roomId>`; its chat channel is
   the call's huddle channel with the same suffix
   (`orgiq:huddle:<callId>~breakout~<roomId>`).
2. **Breakouts are parsed before families.** Every guard that matches lobby or
   channel families strips a `~breakout~<roomId>` suffix first, admits the base
   name by today's rules, then asks `MeetingService.admitsBreakoutLobby(Sync)`.
   An unparsed breakout name must never reach the `RID` family match.
3. **Organizer** (who may open rooms, set timers, announce, lower others'
   hands) is: the call's caller; any holder of `ManageChannels` in the call's
   tenant; on an initiative call, its stewards. Everyone else is a participant.
   One function, `meetingOrganizer(auth, call)`, in the authority facade.
4. **Rooms need three people.** DM calls and calls under three participants
   show Raise and React but not Rooms.
5. **Rollout order:** initiative huddles (orgiq) → social rooms → document
   calls → assessment team calls → the rest. Each surface ships whole (bar,
   stage, rooms, chat, hands on tiles) or not at all.
6. **One gateway.** The CDK pins the gateway to one task, so the meeting state
   is in memory; when `REDIS_URL` is set and routing is clustered, the gateway
   uses `RedisMeetingStateStore` on the existing gateway Redis, the same
   pattern as `RedisCallStateStore` (`realtime-gateway.ts:249`).

## Phases

| phase | lanes | done when (the validator's checks) |
|---|---|---|
| M0 — ready to wire | P0, P1 | the other session's cleanup lane has finished (coordination, not code); portal and middleware install realtime-modules **≥ 0.133.0** and ui-components **≥ 2.474.0** at one tarball each (moved with the `rb-ui-components-release` runbook: preflight, pin, verify), both lockfiles agree, `CLAUDE.md`'s pins line names them, `node_modules/.vite` is cleared; the installed `dist` exports `meeting`, `useMeeting`, `useFollowMeetingLobby`, `withMeetingHands`, `useMeetingChat` (checked with `node --input-type=module`, not the changelog); the scope conflict between `validate-upstream-refinement.sh:101-104` and `validate-component-discipline.sh:133-139` is resolved one way and both validators agree |
| M1 — library seams the app needs | L1, L2, L3 | **L1** realtime-modules: the conversation call can change lobby in place (`useConversationCall` / `createCallBlockHost` take the meeting's `activeLobby`, leave-then-join, no ring, no new call record), with tests; **L2** ui-components: `HuddleBar` and the call dock accept meeting items (Raise, React, Rooms) and a meeting stage slot, so the footer bar and the expanded stage get them without host markup; **L3** realtime-modules: `breakoutChannel(base, roomId)` / `parseBreakoutChannel` for host-namespaced chat channels. Each lands upstream first with a CHANGELOG entry tagged "(lane Ln)", then a pin move |
| M2 — the BFF | B1, B2, B3, B4 | **B1** `meeting()` is registered in `attachRealtime` with `isOrganizer: meetingOrganizer`, `rateLimit` defaults, the Redis store when clustered; **B2** the channel guard admits `meeting:<lobby>` exactly when the base lobby is admitted, and room chat channels by base huddle membership plus `admitsBreakoutLobbySync`; **B3** `lobbyGuard`, `POST /api/realtime/lobby-access` and `POST /api/realtime/call-seat` admit `<lobby>~breakout~<room>` only to that room's members and organizers (open rooms; self-select: any open room) and refuse closed rooms, unknown rooms and other meetings' rooms; `/call-seat` accepts a breakout lobby for the call whose base lobby it is (platform-api's join asks it with the call's `callId` and the breakout `lobbyName`, `../platform-api/src/routes/videoSessions.ts:132`); **B4** `onChange` writes an activity row for breakouts opened/closed (no per-hand rows). Middleware jest covers: member, non-member, organizer, forged room, closed room, a breakout name that would have matched the `RID` family, and the mock floor's route snapshots are unchanged (no new REST route) |
| M3 — the portal, one surface at a time | U1–U5 | **U1** `ShellCallHost` runs `useMeeting(callLobby)` and `useFollowMeetingLobby` beside the call and exposes them to the stage; **U2** the footer `HuddleBar` shows Raise (with queue position) and React; **U3** the expanded stage shows `MeetingToolbar` from `meetingToolbarItems` (chat, people, raise, react, rooms), tiles with `withMeetingHands`, the People pane from `meetingRosterProps`, `WrappedBreakoutRoomsPanel`, `WrappedBreakoutRoomBanner`, and `RecordingConsentNotice` when the call records; **U4** the call chat uses `useMeetingChat` (To: all rooms for organizers, marked announcements, which-chat line) on the room's chat channel inside a room; **U5** surfaces in the order of decision 5, each listed in the validator. No hand-rolled markup: the shell budget stays `0:0:0` |
| M4 — media admission across repos | X1, X2 | **X1** read 2026-10-16: platform-api's `decide()` (`../platform-api/src/lib/lobbyAccess.ts:204-255`) defers an OrgIQ token's lobby to the BFF **only with `LOBBY_AUTHORITY_REQUIRED=true`**; with it off (the default) a breakout lobby falls through to the tenant prefix guard and any tenant member could take another room's media. So: Rooms is offered only where the BFF reports lobby authority on (the portal hides Rooms otherwise), the local stack and every deployed stack that enables breakouts set `LOBBY_AUTHORITY_REQUIRED=true` + `LOBBY_AUTHORITY_URL`, and the validator checks the compose/Tilt env; the `~` form passes platform-api's own checks (length ≤ 256, `room:` slugs miss and fall through) — prove it with a platform-api test on its side, or record the end-to-end proof in E2; **X2** the LVS hole found in G21 is closed by its owner before any deployed use: `GET /api/channels/:arn` answers without auth and returns `streamKey`, which mints a publisher token (`live-video-streaming/src/api/channels/index.js:1983-1995`). Handed to that repo; this goal records the fix's commit |
| M5 — proof | E1, E2, E3 | **E1** fixture e2e (`portal/e2e/meeting-rooms.spec.ts`, two clones): raise hands and see the queue on both, organizer creates and opens rooms, the participant's stage moves (banner, room chat line), an announcement reaches the room chat, end returns both; light and dark; **E2** real-media acceptance `portal/e2e/huddle-breakout-real.spec.ts` under `REAL_MEDIA_ACCEPTANCE=1` (SFU, platform-api, fake devices): producers move to the room lobby and back, a forged room join is refused at the token mint; the run is recorded in `docs/realtime-validation/<date>/meeting-breakout.md`; **E3** journeys: a call-with-rooms map per surface shipped in U5 (organizer and participant), walked and sealed; the ui-dom-audit adapter gains a "call open, rooms pane" state for those routes with 0 findings |
| M6 — docs | D1 | `CLAUDE.md` docs-map row and validator count; `docs/journeys.md`; the handoff doc names the pins and what is owed |

## Rules

Upstream first: a missing seam is a library change and a release, never host
glue (the component-discipline rule). One consumer pin move per release, with
the runbook, verified against the installed `dist`. Work in a worktree; never
touch another session's uncommitted files; hold pin moves and call/realtime
edits while a peer lane is sealing journeys (pins change rendered contracts).
Run the middleware full jest suite alone. Clones, never seed personas, for
browser runs; never two browser runs as one fixture identity. Stop only PIDs
you start. No deploys.

## Blocked or owed by the user

- **Decisions:** confirm the organizer rule (decision 3) and the rollout order
  (decision 5); whether Rooms shows on assessment and pipeline calls at all;
  the recording consent wording and its privacy link per tenant.
- **Cloud:** any deploy; multi-replica acceptance of the Redis meeting store
  (the gateway stays one task until capacity is accepted); the LVS fix (X2) in
  a deployed stack.
- **Other repos:** platform-api (X1) and live-video-streaming (X2) are owned
  elsewhere; this goal waits on their commits rather than editing them.
