# Ten-minute demo

A walk through three tenants on the mock backend, in the order [project-story.md](project-story.md) tells it: orgiq (the original AgentCore work), assessment (the first tenant added on the shared backend), then social (the realtime libraries). Start the stack as the README describes, open http://localhost:5183/workspaces, and have `POST /api/__mock/reset` ready if a click-through leaves things in a strange state.

Written from the routes and fixtures, not from a recorded run: the first time through, check each "you should see" line and fix the script where it is off. People are picked on `/workspaces`; the cast is in `portal/src/pages/SelectContextPage.tsx`.

## 1. Work (orgiq): one initiative, end to end (3 minutes)

The Work tenant is Halyard, a B2B commerce company, and the walk follows one initiative: Auth Migration, moving every tenant off the legacy SAML shim onto Cognito. Vera Green owns it; Nora DaSilva and Simone Chang are its SMEs; the cutover order is waiting on Sienna Garcia. Sign in as Vera Green (`u-vera`, org leader) on `/workspaces` and enter the Work workspace. `node scripts/content/check-story.mjs` keeps the data behind these steps consistent (deciders on their initiative, owners who can sign in, sprints with days left and inside their envelopes).

1. **Open Auth Migration.** `/iq/projects`, then "Auth Migration". Walk the tabs: Work (the cutover runbook story is blocked on a decision; the logout cookie bug is open), Decisions ("Cutover order for legacy SSO tenants", escalated two days ago), Docs (Vera's "Tenant cutover plan" and Nora's session-hygiene whiteboard), the bound #auth-migration channel, and Agents.
2. **Decide the cutover order.** Open the decision and choose "Riskiest two tenants first". Vera decides as an org leader overriding the escalation; switch to Sienna Garcia (`u-release`) first to decide as the named decider. The runbook story it blocks ("Tenant-by-tenant cutover runbook with rollback") loses its blocker.
3. **A deck of last sprint.** In the composer: "Make a deck of this initiative's progress this past sprint." It covers Sprint 9 — OIDC core: the PKCE flow, JWKS verification and the shim-consumer inventory, all merged.
4. **Tell the channel.** "Tell #auth-migration the cutover order is decided; rehearsal Thursday." The message lands in the channel the initiative is bound to, after Nora's note on the failed second rehearsal and Sienna's promise to decide once the retry is clean.
5. **Hand work to an agent.** Switch to Nora DaSilva (`u-nora`, SME, holding her own envelope on Sprint 10 — Session hygiene) and say "Send the logout cookie bug to an agent." The run appears on the work item and her envelope moves. Close on `/iq/search` with "Who knows identity and access?": the security and platform people with IAM and zero-trust skills (Simone Chang, Diego Ortiz, Joy Chen, Vera, Nora) should lead the answer.

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
