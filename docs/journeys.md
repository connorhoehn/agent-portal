# Journeys

## The demo moments

`scripts/journeys/demo-moments.mjs` walks the five moments of the Work demo ([demo-script.md](demo-script.md) §1, the Halyard story on Auth Migration) in headless Chromium, each one twice: by hand (clicks and keys) and by voice on the scripted session. It exits 0 only when every step of all ten runs passed, 1 when any failed and 2 when the stack is not reachable.

### Running it

It needs a middleware with the mock backend and the scripted voice session, and a portal that proxies `/api` to it. Use your own ports; never point it at a server someone else is using, because every run resets the mock.

```sh
# 1. the middleware: dev:mock's environment plus MOCK_VOICE=1 (npm run dev:mock sets VOICE_LOG_DIR itself)
cd middleware && PORT=3966 MOCK_VOICE=1 npm run dev:mock
# 2. the portal
cd portal && VITE_GATEWAY_URL=http://localhost:3966 API_PROXY_TARGET=http://127.0.0.1:3966 npx vite --port 5166 --strictPort
# 3. the journey
PORTAL_URL=http://localhost:5166 MIDDLEWARE_URL=http://127.0.0.1:3966 node scripts/journeys/demo-moments.mjs
```

Options: `--only M2,M4` runs some moments, `--mode hand` or `--mode voice` one way, `--out <dir>` (or `OUT_DIR`) keeps the results (default: a new directory under the OS temp dir). `CHROMIUM_PATH` names a Chromium or headless-shell binary when Playwright's own (found through `PLAYWRIGHT_BROWSERS_PATH`) is not installed. Chromium runs with the fake media flags, so the voice dock opens without a microphone.

Each of the ten runs starts from seeded state (`POST /api/__mock/reset`), signs its person in through the session API (`POST /api/session/login`, then `/api/session/role`), and records for every step: pass or fail, milliseconds, the `/api` requests and the WebSocket frames it sent (with their channel), the `say` line each voice result carried, and a screenshot. `results.json` holds all of it; `results.md` is the table.

### How the voice pass works

The voice pass never hears audio. Under `MOCK_VOICE=1` the mint answers a scripted session (middleware `lib/voice/openai.ts`) that the dock plays through the same parser as a live one. Before it clicks the dock's start, the journey sets the turns of the person's next session:

```
PUT /api/voice/mock-script { turns: [
  { said: 'Open Auth Migration.', call: { name: 'open', arguments: { kind: 'initiative', name: 'Auth Migration' } } },
  { said: 'Open decisions.',      call: { name: 'open', arguments: { scope: 'this-page', tab: 'decisions' } } },
  { said: 'Confirm.', on: 'card' },
] }
```

A turn with a `call` is a request: the first is spoken at the start, each later one once the request before it has been answered and continued. A turn with `on: 'card'` is the user's answer to a confirm card, spoken when the card of the request before it opens. The next mint by that person plays the turns once; `DELETE /api/voice/mock-script` drops them. The route answers 404 unless `MOCK_VOICE=1`, and always under `NODE_ENV=production`. A scripted session raises a `voice-mock-frame` window event for every frame in and out (never a real session), which is where the journey reads each result's `say` line.

The pass proves the dock, the tools and the backend for the call a model is expected to make. It does not prove that the live model makes that call for those words.

### What each moment asserts

Every voice result must be done (not refused or failed) and carry a `say` line of one sentence and at most 25 words.

| Moment | Person | By hand | By voice | Then, both ways |
| --- | --- | --- | --- | --- |
| M1 Open Auth Migration | Vera Green (`u-vera`, org leader) | Initiatives › Auth Migration; the Work tab shows the blocked runbook story and the logout bug; Decisions shows the escalated cutover decision; Docs shows the cutover plan and the session-hygiene whiteboard; the Discussion pane is #auth-migration (the initiative's bound channel) and shows the rehearsal thread and Sienna's promise; Agents is not empty | "Open Auth Migration." (`open` kind initiative), then "Open decisions." (`open` scope this-page, tab decisions) lands on `?tab=decisions` | |
| M2 Decide the cutover order | Vera | Decisions tab › the decision; keypad 2 in the docked composer and Enter in the same tick, before the reason field can have the focus (the page carries the Enter there) | "Decide the cutover order: riskiest two tenants first." (`decide` ref 1, scope this-page, option) shows a click-only card naming the option; the spoken "Confirm." leaves it open; a click on Confirm decides | the record reads "Decided just now by Vera Green" and "Riskiest two tenants first" and lists the runbook story as Unblocked (by voice the say line names it: `…; "Tenant-by-tenant cutover runbook with rollback" is unblocked.`); the overview no longer shows the runbook story blocked on the decision; the Work tab and the story's own record are no longer blocked, its status is still open, and its history has "Unblocked: Cutover order for legacy SSO tenants decided: Riskiest two tenants first" |
| M3 A deck of last sprint | Vera | Docs › New › Presentation, Focus "this initiative's progress this past sprint", Build deck | "Make a deck of this initiative's progress this past sprint." (`queue_work` deck, scope this-page, focus), "Confirm."; the job toast reads Done and names the sprint; its Open opens the deck | the deck's subtitle reads "focus: Sprint 9 — OIDC core"; its Sprints slide shows Sprint 9 done with 3/3 items; the sprint's three done stories are the PKCE flow, JWKS verification and the shim-consumer inventory |
| M4 Tell the channel | Vera | on the initiative, the composer's To: reads #auth-migration; type in it, Enter; it shows in the Discussion pane | "Tell #auth-migration the cutover order is decided; rehearsal Thursday." (`message` to channel auth-migration), "Confirm." | the Social bar opens #auth-migration (`/iq/communication/channels/auth-migration`); the message is there once, after Nora's "Second rehearsal failed at the flip" and Sienna's "Then I decide the order once the retry is clean", with its read receipt; the voice says "Posted to #auth-migration." |
| M5 Hand work to an agent | Nora DaSilva (`u-nora`, SME) | the Work tab › the logout bug; Dispatch in the composer, Enter | "Send the logout cookie bug to an agent." (`queue_work` dispatch, scope this-page, target "the logout cookie bug"), "Confirm."; later "Who knows identity and access?" (`search` type person) hands the voice three IAM people | one new run of the bug finishes (by hand the composer's job card follows it, by voice the job toast); Nora's Sprint 10 envelope spends more than before; for "Who knows identity and access?" Simone Chang, Diego Ortiz, Vera Green, Joy Chen and Nora DaSilva are all in the top seven people, and the search page shows them |
