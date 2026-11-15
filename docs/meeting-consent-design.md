# Meeting consent: proposals Milo notices, and the consent they need

14 November 2026. Design only; nothing built. Read at `a4541dce` on `meeting-assistant-scenarios`.

## Recommendation

Add one new record, a **proposal**, to the meeting assistant. A background watcher reads the stored transcript (not the live speech session), and when people in the call appear to agree on something it posts a quiet proposal card in the call chat at the next pause. Milo never speaks it. A proposal runs only when **two or more people have clicked consent, including every person it names and the one person whose browser will run it, and nobody in the call has an open objection**. Silence is never consent. What runs is either an ordinary tool turn in the executor's browser (as today) or a new decision record; when nobody present holds the right, a waiting decision is raised for the initiative's owner, who decides it in the existing decision dialogue. Unfinished proposals move to the meeting page for 72 hours and then expire unrun.

## What exists, and what it means for this

- **Call writes are one person's consent.** A card belongs to its asker; only that person can decide it (`middleware/src/routes/meeting-assistant.ts:392`), and only their browser runs it (`orchestrator.ts:944`, `:958`).
- **Milo cannot originate anything.** The instructions say silent unless addressed (`instructions.ts:173`), and the server refuses any tool call with no asker or no name in the last 20 seconds (`orchestrator.ts:863-876`). This is decision 3's second lock and should stay.
- **A decision record has one decider.** `POST /api/graph/decisions/:id/decide` lets through the named decider, the initiative's owner, or an org-leader or admin (`middleware/src/lib/decision-authority.ts:22`, `routes/decisions.ts:104`; the Cedar copy is the `decidesThis` forbid in `seeds/roles/orgiq/member.cedar:74`). No quorum.
- **Nothing creates a decision.** The router has two reads and `decide`; the provider's only insert is a history event (`providers/decisions.ts:464`); `CREATE_ACTIONS` has no `decision` kind (`middleware/src/lib/voice/catalogue.ts:616`). Decisions come from the seed.
- **HITL approvals are agent-filed and single-approver**, expiring after five minutes (`routes/approvals.ts:1-16`). Not a fit for people agreeing with each other.
- **Several approvers exist in two places only:** design review sign-offs (`providers/design-reviews.ts:116-126`) and the SDLC two-person rule with its self-approval refusal (`lib/sdlc-policy-governance.ts:129`, `:158`). The rule below copies both ideas.
- **Minutes decisions are plain strings** found by a regex or the minutes model (`minutes.ts:97`, `types.ts:205`), shown as text (`portal/src/pages/meetings/MeetingPage.tsx:85`).

## The consent rule

A proposal carries a statement, an outcome (record a decision, or one tool call), the people it names, and an executor. It moves `open → consented → running → done | failed`, or to `objected`, `dismissed`, `expired`.

It becomes `consented` when all of these hold, judged on the server:

1. **Two distinct people have clicked Consent.** One person agreeing with themselves is today's asker card, not consensus.
2. **Every named person has consented**: the assignee of a work item, the decider of a decision. A named person who left or was never in the call is told by notification and can answer on the meeting page; until then nothing runs.
3. **The executor has consented**, and their consent is the last step: their click is what starts the write in their own browser.
4. **No open objection.** Anyone who held a seat may object with a one-line reason. An objection stops the proposal; the objector can withdraw it, or someone restates the proposal (a new one; earlier consents do not carry).

Further rules:

- **Nobody is consented automatically**, not even the person the transcript says proposed it. Attribution can be wrong (audit S9), and a spoken yes confirms nothing (decision 5).
- **Consent can be withdrawn** until the proposal runs.
- **The outcome is frozen** when the proposal is posted (the same args digest the action card uses). A change is a new proposal.
- **Acknowledging the transcription notice gates what is heard, not who may click.** A person who has not acknowledged contributes no words to detection but may consent or object.
- **Time limit:** open through the call, then 72 hours on the meeting page, then `expired`. Nothing runs on a timer.

Why this rule: sociocracy's consent round asks each person for consent or a reasoned objection; objections block, preferences do not, and the test is "good enough for now, safe enough to try". That gives the objection half. The explicit two-person half comes from this product's own two-person rule: everything here is a write under someone's rights.

Rejected alternatives:

- **Asker only (today):** it is the thing the owner wants strengthened.
- **Everyone present must say yes:** one distracted person stalls every proposal; people will start clicking yes unread.
- **Majority or quorum of attendees:** lets a majority write over the named assignee or decider.
- **Silence is assent after a wait (Apache lazy consensus, 72 hours):** fine for a mailing list, wrong when the result is a write nobody clicked for.
- **Owner or role only:** that is the existing decision record; it is kept as the fallback, not the rule.
- **Spoken consent:** rests on attribution and can be said by an echo.

## Detection

**Not the live model.** It has no text-only mode, it is instructed to stay silent, the name lock would refuse its calls, and loosening either risks it speaking into the meeting. It is also the expensive path ($0.05 a minute).

**A watcher on the stored transcript**, in the middleware:

1. Each stored line is tested against a cheap trigger (the `DECISION` pattern at `minutes.ts:97`, widened: "let's go with", "so we'll", "agreed", "I'll take", "can you own").
2. On a hit the watcher waits for a pause: no new line for 6 seconds, at most 45 seconds, and never while Milo is answering.
3. It sends the last 90 seconds of lines (at most 40) to Amazon Nova Lite through Bedrock, following the existing client in `middleware/src/lib/session-titles.ts:46`, with a strict JSON schema: `isDecision`, `outcome` (`decision` | `work-item` | `none`), `statement` (280 characters at most), `named` (roster names only), `evidence` (line numbers), `confidence`.
4. The server builds the outcome arguments itself (the helper at `minutes-service.ts:75` already does this for work items). The model's text is shown, never executed.

**Keeping it quiet.** A proposal is posted only when confidence is high and the evidence lines come from two or more speakers (one proposes, another agrees). One proposal per two minutes, eight per call, duplicates dropped by normalised statement. Any seat holder can mark one "Not a decision", which removes it and suppresses near copies for the rest of the call. No sound, no speech, no detection while paused, and none in a call with one person.

**Cost.** Nova Lite is $0.06 per million input tokens and $0.24 per million output (`lib/pricing.ts:39`). A check is about 1,500 tokens in and 150 out, about $0.00013. With the trigger, 10 to 20 checks an hour: under half a cent. With no trigger, a check every 30 seconds is about $0.015 an hour. Listening itself costs $3 an hour. Booked to the inviter under the existing `meeting_assistant` source.

**The explicit path.** "Milo, propose that we…" is an addressed request and creates the same record, so the watcher is an aid, not the only door.

## The flow at 1440 px

Three people on an initiative page call: Priya (program owner), Sam and Lee. Milo is listening. The call chat is the right pane; the footer row is at the bottom.

1. Sam says "let's cut over the smallest tenants first"; Priya says "agreed, Lee can you own the runbook". The talk carries on.
2. About eight seconds into the next pause, one card appears in the call chat from Milo, with no sound: "Proposal · Cut over the smallest tenants first. Record as a decision on Auth Migration. Needs: Priya (runs it), one more." It shows three chips, all "waiting". Milo's entry in the footer shows a count, "1 proposal".
3. For Priya, who is the executor, a prompt appears in the deck above the footer row (where the budget prompt sits today, `portal/src/components/shell/SocialFooter.tsx:247`): "Milo · Proposal — Cut over the smallest tenants first. 1 Consent and record · 2 Object… · 3 Not a decision". The digits work from anywhere on the page, as in the decision dialogue.
4. Sam and Lee get the same prompt without "and record": "1 Consent · 2 Object… · 3 Not a decision". Esc hides it; the footer count reopens it. Nobody has to stop talking.
5. Sam presses 1. The card's chip for Sam turns to "consented" for everyone.
6. Priya presses 1. The rule is now met (two people, executor included). Her browser creates the decision record; the card ends "Recorded · Cutover order: smallest tenants first", linking to the decision page.
7. A second card follows for "Lee owns the cutover runbook" (a work item). It names Lee, so Lee's consent is required. Lee presses 2 and types "I'm out next week"; the prompt says "Everyone in the call will see this". The card shows "Objected by Lee: I'm out next week" and locks.
8. The call ends. The minutes list each proposal with its state and who consented. Had the second one been waiting on Lee instead, Lee would have a notification ("A proposal from this meeting needs you") and the same prompt on the meeting page.

## Packages

Each is one branch, flag-gated by `MEETING_ASSISTANT_ENABLED`, on the mock world first.

1. **Proposal record and consent rule (server).** Files: `lib/meeting-assistant/types.ts`, `store.ts`, `store-sql.ts`, new `proposals.ts`; routes in `routes/meeting-assistant.ts` (`GET proposals`, `POST proposals/:id/response`, dev injector in `meeting-assistant-dev.ts`). Enforces: the four conditions, no auto-consent, withdrawal, frozen outcome, seat or attendance for every route, refusal under a masquerade. Tests: every state move; a named person missing; an objection then withdrawal; two responses at once; a non-attendee gets 404. No walk yet.
2. **Proposal card and deck prompt (portal).** Files: `middleware/src/lib/meeting-assistant/chat-types.ts` and `chat.ts` (kind `assistant-proposal`), `portal/src/lib/assistantMessages.ts`, `portal/src/components/chat/AssistantMessageExtras.tsx` (read-only card with chips), new `portal/src/components/shell/AssistantProposalAsk.tsx` beside `AssistantBudgetAsk`, footer count in `MeetingAssistantBar.tsx`. Enforces: answers are given only in the deck; the card has no buttons; objection text is labelled as shared. Library components only; if the chip row with a person and a state has no primitive, add it to `ui-components` first. Walk: inject a proposal, three browsers, consent, object, hide and reopen; run `ui-dom-audit`.
3. **Running a consented proposal.** Files: `orchestrator.ts` (a consented proposal with a tool outcome becomes an `AssistantTurn` for the executor; `submitResult` closes the proposal), `portal/src/components/shell/MeetingTurnRunner.tsx` (no change expected beyond the poke). Enforces: the executor's role is checked when the proposal is posted and again when it runs (`orchestrator.ts:892`); if no present consenter may run it, the card says who could. Tests: executor loses the right in between; executor's tab gone (expires, proposal back to `consented`). Walk: a work item made from a proposal lands on the call's initiative.
4. **Decision records from a call.** Files: `routes/decisions.ts` (`POST /`), `providers/decisions.ts`, `mock/decisions.ts`, `lib/decision-authority.ts`, a new Cedar action `RaiseDecision` in the orgiq role files, `CREATE_ACTIONS` in both catalogues, `portal/src/lib/voice/runCore.ts` tools. Enforces: a resolved record may be created only by someone `mayDecideDecision` would let decide on that initiative; anyone else on the initiative may raise a waiting one, with the owner as decider, the statement as its one option and the consenters as participants. Tests: owner creates resolved; member raises waiting; another initiative's member is refused; the wire snapshots. Walk: record in the call, open the decision page, see "Agreed in a call by…" in its history; raise one and decide it from the owner's dialogue.
5. **The watcher.** Files: new `lib/meeting-assistant/decision-watcher.ts` and `decision-model.ts` (Bedrock and a scripted stand-in chosen as `session-select.ts` does), hook where lines are stored (`intake.ts`), `spend.ts`. Enforces: trigger, pause, caps, two-speaker evidence, dedupe, suppression, nothing while paused, spend booked. Tests: the scripted detector on fixed transcripts (chatter, a real agreement, a joke, an echo line); the request body as text; a malformed model answer is dropped. Walk: scripted call lines produce exactly one card. One paid check of the Bedrock request, with the owner's leave.
6. **After the call.** Files: `minutes-service.ts` and `minutes.ts` (proposals and consenters in the minutes; the minutes stop inventing decisions the watcher already holds), `portal/src/pages/meetings/MeetingPage.tsx` and `meetingsModel.ts` (a Proposals section and the same deck prompt), `retention.ts`, `erase.ts`, `lib/social-notify.ts`. Enforces: 72-hour expiry; the inviter's delete removes proposals and blanks their cards; a notification carries no statement text (the notification service cannot delete); a decision record already created stays, with names but no quoted words. Tests: expiry sweep, delete, late consent by a named person. Walk: leave with one open, consent on the meeting page, see it run.
7. **Asked writes that name someone else.** Files: `orchestrator.ts` (`handleToolCall`: a write whose arguments name another person becomes a proposal needing that person). Enforces: the asker's card stays for writes that touch only the asker. Tests and a scenario in the paid suite. Do this last; it changes shipped behaviour.

Order: 1, then 2 and 4 in parallel, then 3, 5, 6, 7.

## Gaps in the current code

- No way to create a decision: `routes/decisions.ts:51-104`, `providers/decisions.ts:464`, `lib/voice/catalogue.ts:616`.
- One decider, no shared consent: `lib/decision-authority.ts:22-28`.
- Actions and turns hold one person: `types.ts:162-176`, `routes/meeting-assistant.ts:392`, `orchestrator.ts:944`.
- Only three chat kinds, and the action card answers with buttons in the chat rather than the deck: `chat-types.ts:16`, `AssistantMessageExtras.tsx:62-71`.
- Nothing runs after the call: the runner needs a live call id (`MeetingTurnRunner.tsx:29`), and the meeting page offers a link (`MeetingPage.tsx:68`).
- The minutes model is the OpenAI delegation model (`minutes.ts:257`); the watcher must not copy that path.
- Audit S2 and S9 (asker timing, attribution) are open; consent is a click, so nothing here depends on them.
- Decisions exist only in orgiq (`portal/src/lib/voice/catalogue.ts:75`); elsewhere a proposal can only be a tool call.

## Privacy and safety

- **Stored:** the statement, outcome, named people, evidence line numbers, each response with its reason and time. Same store, readers (people who held a seat) and 30-day retention as transcript lines.
- **New processor:** transcript text goes to Bedrock in the owner's account. The transcription notice should say so.
- **Private answers** never enter: the watcher reads stored lines only, never tool results.
- **Transcript text is data.** The model returns a schema; the server builds the arguments; the executor's prompt shows what will run.
- **Executor lacks the right:** checked at posting and at run; the fallback is a raised decision for the owner, or the proposal stays in the minutes.

## Decided (14 November)

- Asked writes that name another person become proposals that need that person (package 7, built last). Writes that touch only the asker keep today's card.
- One paid check of the Bedrock request is allowed.
- The initiative's owner must be one of the consenters only for recording a resolved decision; anyone on the initiative may raise a waiting one.

## Sources

- Sociocracy 3.0 patterns, "Consent Decision-Making" (patterns.sociocracy30.org); Sociocracy For All.
- Apache Software Foundation, "Lazy consensus" (community.apache.org).
- Zoom AI Companion guides: a host or approver reviews AI output before sharing. No product found documents several people consenting before an in-meeting action.
