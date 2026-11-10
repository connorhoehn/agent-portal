# Ten-minute demo

A walk through three tenants on the mock backend, in the order [project-story.md](project-story.md) tells it: orgiq (the original AgentCore work), assessment (the first tenant added on the shared backend), then social (the realtime libraries). Start the stack as the README describes, open http://localhost:5183/workspaces, and have `POST /api/__mock/reset` ready if a click-through leaves things in a strange state.

Section 1 is checked by a journey: `scripts/journeys/demo-moments.mjs` performs each of its five steps by hand and by voice on the scripted session and asserts what each step below says you will see ([journeys.md](journeys.md) has how to run it). Every step and phrase in section 1 is one that journey has passed on the mock backend, except the one marked as a known gap. Sections 2 and 3 are still written from the routes and fixtures, not from a run: check each "you should see" line the first time through. People are picked on `/workspaces`; the cast is in `portal/src/pages/SelectContextPage.tsx`.

The voice phrases below are the ones the journey scripts, with the tool call it expects the voice to make for them; on the mock the call is scripted, so a live model may need the same words to make the same call.

## 1. Work (orgiq): one initiative, end to end (3 minutes)

The Work tenant is Halyard, a B2B commerce company, and the walk follows one initiative: Auth Migration, moving every tenant off the legacy SAML shim onto Cognito. Vera Green owns it; Nora DaSilva and Simone Chang are its SMEs; the cutover order is waiting on Sienna Garcia. Sign in as Vera Green (`u-vera`, org leader) on `/workspaces` and enter the Work workspace. `node scripts/content/check-story.mjs` keeps the data behind these steps consistent (deciders on their initiative, owners who can sign in, sprints with days left and inside their envelopes).

1. **Open Auth Migration.** `/iq/projects`, then "Auth Migration" (by voice: "Open Auth Migration.", then "Open decisions." for the Decisions tab; the voice says "Opened Auth Migration." and "Showing decisions."). Walk the tabs: Work (the cutover runbook story is blocked on a decision; the logout cookie bug is open), Decisions ("Cutover order for legacy SSO tenants", escalated), Docs (Vera's "Tenant cutover plan" and Nora's session-hygiene whiteboard), the Discussion pane on the right (the initiative's own thread: the rehearsals and Sienna's promise to decide), and Agents.
2. **Decide the cutover order.** Open the decision from the Decisions tab; the docked composer asks "What did you decide?". Press 2 ("Riskiest two tenants first"), then Enter to decide without a reason. By voice, on the Decisions tab: "Decide the cutover order: riskiest two tenants first." The card names the option and needs a click: saying "confirm" does not decide it, Confirm on the card does, and the voice says "Resolved: "Cutover order for legacy SSO tenants" (Riskiest two tenants first)." Either way the record reads "Decided just now by Vera Green" with "Riskiest two tenants first"; Vera decides as an org leader overriding the escalation. Known gap: the runbook story it blocks ("Tenant-by-tenant cutover runbook with rollback") still shows "Blocked on "Cutover order for legacy SSO tenants"" on the initiative's overview and Work tab after the decision; do not point at it.
3. **A deck of last sprint.** By voice: "Make a deck of this initiative's progress this past sprint.", then "Confirm." when the card asks. The voice says "The Auth Migration deck: done (focus: Sprint 9 — OIDC core (2026-10-18 to 2026-10-31))." and the job toast reads "The Auth Migration deck · Done · focus: Sprint 9 — OIDC core (2026-10-18 to 2026-10-31)"; its Open shows the deck. By hand: Docs › New › Presentation, Focus "this initiative's progress this past sprint", Build deck. The deck is focused on Sprint 9 — OIDC core, and its Sprints slide shows the sprint done with 3/3 items and 16/16 points: those three are the PKCE flow, JWKS verification and the shim-consumer inventory (the deck counts them; it does not list them by name).
4. **Tell the channel.** "Tell #auth-migration the cutover order is decided; rehearsal Thursday.", then "Confirm."; the voice says "Posted to #Auth migration.". The message lands in #auth-migration, the Social channel the initiative is bound to: the Social bar's open on the initiative goes there (Communication › #auth-migration), and the message sits after Nora's note on the failed second rehearsal and Sienna's "Then I decide the order once the retry is clean", with its receipt. By hand, type it in that channel's composer. The initiative's own composer and Discussion pane are a different conversation (the initiative discussion), so a message typed there does not reach #auth-migration.
5. **Hand work to an agent.** Switch to Nora DaSilva (`u-nora`, SME, holding her own $15 envelope on Sprint 10 — Session hygiene), open the logout cookie bug on the Work tab and say "Send the logout cookie bug to an agent.", then "Confirm." (by hand: Dispatch in the composer, then Enter). The voice says ""Logout leaves the legacy shim cookie alive": queued.", the job toast follows the run to Done in about half a minute, and her envelope moves (on the mock the run costs $0.07). Close on `/iq/search` with "Who knows identity and access?": the voice says "10 people, top: Priya Venkataraman; say "read them" for more.", and the people with the IAM skill lead the answer: Priya Venkataraman, Simone Chang, Vera Green, Joy Chen, Maria Johnson, Nora DaSilva and Diego Ortiz are the top seven.

Point out: one backend, Cedar roles per tenant, and the composer at the bottom of every page (story section 12). The other initiatives carry their own threads if there is time: LLM Application Platform (Nina Rivera's open judge-model decision), Inference Platform (Paolo Mancini, spending with no allocation), and Mobile App Redesign (sign in as Mia Singh for her inbox: a review, the sprint envelope and Ben's question).

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
