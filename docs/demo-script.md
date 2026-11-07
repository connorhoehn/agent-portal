# Ten-minute demo

A walk through three tenants on the mock backend, in the order [project-story.md](project-story.md) tells it: orgiq (the original AgentCore work), assessment (the first tenant added on the shared backend), then social (the realtime libraries). Start the stack as the README describes, open http://localhost:5183/workspaces, and have `POST /api/__mock/reset` ready if a click-through leaves things in a strange state.

Written from the routes and fixtures, not from a recorded run: the first time through, check each "you should see" line and fix the script where it is off. People are picked on `/workspaces`; the cast is in `portal/src/pages/SelectContextPage.tsx`.

## 1. orgiq: who knows what (3 minutes)

Sign in as Vera Green (`u-vera`, org leader) on `/workspaces` and enter the orgiq workspace. If a page says you lack access, switch role to org-leader in the header menu.

1. `/iq/projects`. A table of initiatives, starting with "Observability Platform", each with an owner and SMEs. Click it: `/iq/projects/p-observability` shows the team, work and activity. This is the knowledge graph the first agents built (story section 9).
2. `/iq/search`. Type "who knows Kubernetes" in the composer at the bottom (`ComposerSurface`). The mock agent streams an answer and `SearchResults` lists people with sources. Say this is the AG-UI stream over SSE.
3. `/iq/scores`. The leaderboard, Vera first (composite 95.8). Open `/iq/scores/compare` to compare two people.
4. `/iq/agents`, then `/iq/runs`. The agent fleet and recent runs; open one run to see its steps.
5. `/iq/decisions`. A `DataTable` of decisions; open one for its record.

Point out: one backend, Cedar roles per tenant, and the composer at the bottom of every page (story section 12).

## 2. assessment: a second product on the same backend (3 minutes)

Switch person to Asha Nair (`u-asha`, assessor) at `/workspaces`. The session cookie changes, so everything below is read as an assessor.

1. `/assessment/teams`. Teams with a six-step workflow (Intake, Classify, Score, Review, Publish, Follow-up). "Northstar Payments" is at Review. Open `/assessment/teams/TEAM-001` for its dimensions and heatmap.
2. `/assessment/submissions`. A `DataTable` of submissions; open one to see the scoring detail.
3. `/assessment/decks`. Decks built from assessment data (`DeckSummary`, `DeckDetail`); open one for the slide view.
4. `/assessment/runs`. Agent runs behind the scoring; `/assessment/feedback` is where reviewers answer them.
5. `/assessment/communication/channels`. The same communication plane that the other tenants embed; this is the bridge to the next section.

Point out: different roles, different navigation, no shared chrome with orgiq (story section 10).

## 3. social: realtime on the libraries (3 minutes)

Switch person to Mira (`u-mira`, community admin). Keep a second browser window signed in as `u-sana` if you want to show two people live.

1. `/social/channels`. Channels such as "Design reviews", "Events" and "Auth migration", each with unread counts and a recent message. Open `/social/channels/design-reviews`: the conversation is a `WrappedChatPanel`; presence avatars (`PresenceAvatars`) show who is online. Send a message; with two windows it appears in both.
2. `/social/dms`. Direct messages, with read status.
3. `/social/contacts`. People, with live presence; click one to open `/social/contacts/<id>`.
4. `/social/rooms` and `/social/calls`. Meeting rooms and the call log. Real audio and video need the `social` compose profile and Colima; on the plain mock backend you see the lobby and the history only.
5. `/social/work-graph`. The shared work across conversations, which is the hand-off to the closing idea in story section 14: manage work, not code.

Close by pointing at the bottom composer once more: the same component switches between a message, a comment and a skill run.

## If something looks empty

`POST /api/__mock/scenario` produces empty and error states on purpose. Restart `npm run dev:mock` if the fixtures were reset mid-demo and a page still looks stale.
