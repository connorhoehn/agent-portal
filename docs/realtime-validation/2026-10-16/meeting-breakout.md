# Meeting breakout rooms over real media — E2 acceptance (2026-10-16)

`docs/meeting-rooms-app-goal.md` E2, and the end-to-end proof for X1 (platform-api admits breakout lobbies,
and only through the BFF).

**Verdict: pass.** `portal/e2e/huddle-breakout-real.spec.ts`, one run, 1 passed.

## Stack

- Portal :5183 built with `VITE_MEETING_ROOMS=true`, middleware :3001 (`dev:mock`, gateway on), on
  ui-components 2.480.1 / realtime-modules 0.137.0 (aws-agentcore main `232676c9`).
- Native SFU :3902 (live-video-streaming), platform-api :23002 (`orgiq-media-validation-platform-api`)
  running platform-api main (`db7b55f`) with `LOBBY_AUTHORITY_REQUIRED=true` and
  `LOBBY_AUTHORITY_URL=http://host.docker.internal:3001/api/realtime/lobby-access`. The image the stack ran
  before (2026-10-09) predated lobby authority; it was layered with the current dist this day.
- Chrome with fake devices; three clones on Observability (`BREAKOUT_INITIATIVE=p-observability`), so no
  seeded persona and no one's real huddle was touched.

Command:

```bash
cd portal && BREAKOUT_INITIATIVE=p-observability REAL_MEDIA_ACCEPTANCE=1 \
  MEDIA_PLATFORM_URL=http://127.0.0.1:23002 PARITY_BASE_URL=http://127.0.0.1:5183 \
  npx playwright test e2e/huddle-breakout-real.spec.ts
```

## What it proved

- **Organizer:** Vera (active role `member`, not on Observability) starts the huddle and gets the organizer's
  controls: the caller organizes (realtime-modules 0.136 `roleKey`; before it, the first subscribe beat the
  call's registration and she never did).
- **Move:** Vera opens two rooms and puts Nora and Caleb in Room 1. Both pages open a media session on
  `orgiq:initiative:p-observability~breakout~<room1>` with the same callId; platform-api reports that lobby
  live and verified (SFU producers); Nora and Caleb hear and see each other there; Vera's page plays neither.
- **Back:** ending the rooms moves both back to the base lobby and Vera plays both again.
- **Forged joins refused at the mint** (Caleb, an SME who is a participant here, with his own realtime
  token): Room 2's lobby (he is in Room 1), a same-named room of a lobby with no meeting, and an unknown room
  of this meeting are all refused (platform-api answers 404: it asks the BFF, which refuses).
- **Who may enter any room (by design, decision 3):** an initiative's owner and contributors and the org-wide
  roles (org-leader, hr-admin) organize its meeting and may enter any open room. Earlier runs that forged with
  Nora (owner of Observability, SME on Auth Migration) or Rachel (org-leader) were admitted for that reason.

## Session log (the spec's summary)

```json
{
  "lobby": "orgiq:initiative:p-observability",
  "rooms": [
    "rmvbpswmpb",
    "rmvbpswmpc"
  ],
  "sessions": {
    "u-vera-clone-3b05f6d2": [
      {
        "lobbyName": "orgiq:initiative:p-observability",
        "status": 200
      }
    ],
    "u-nora-clone-2e0fdc2c": [
      {
        "lobbyName": "orgiq:initiative:p-observability",
        "status": 200
      },
      {
        "lobbyName": "orgiq:initiative:p-observability~breakout~rmvbpswmpb",
        "status": 201
      },
      {
        "lobbyName": "orgiq:initiative:p-observability",
        "status": 200
      }
    ],
    "u-caleb-clone-79853afd": [
      {
        "lobbyName": "orgiq:initiative:p-observability",
        "status": 200
      },
      {
        "lobbyName": "orgiq:initiative:p-observability~breakout~rmvbpswmpb",
        "status": 200
      },
      {
        "lobbyName": "orgiq:initiative:p-observability",
        "status": 200
      }
    ]
  }
}
```
