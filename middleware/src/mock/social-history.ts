// The social tenant's ten-day demo history (dev:mock) — what makes
// /social/channels read as a workspace people have been using, rather than
// four channels and a dozen lines.
//
// Pure data plus selectors, no fixture of its own: social-channels.ts spreads
// these rows into the registered `social.channels` / `.channel-members` /
// `.channel-messages` / `.pins` fixtures and mock/notifications.ts derives the
// mention and unread items from the same messages, so a count anywhere is a
// selector over rows (contract rule 1) and `POST /api/__mock/reset` restores
// the lot (rule 4). Every timestamp is `clock.hoursAgo(n)` evaluated when a
// factory runs (rule 3).
//
// u-jonas is deliberately never @-mentioned inside the notification window
// (72h): the assessment judge's "his first reply reads 1" needs an empty bell.
//
// Cast: every identity that holds a social grant (schema/identity_schema.sql).
// Message ids carry the message's own key (`…seed<key>`), which is how a pin
// finds its message.
//
// Threads: the stored ChatMessage has no parent field (the library's chat has
// no threads), so a thread here is a run of replies that name each other.
// Reactions live in the gateway's reaction store, not a registered fixture, so
// the live simulator (scripts/dev/social-sim.mjs) is what puts them on screen.

export const CAST: Record<string, string> = {
  'u-mira': 'Mira Okafor', 'u-lena': 'Lena Brandt', 'u-sana': 'Sana Iqbal',
  'u-theo': 'Theo Chang', 'u-vera': 'Vera Green', 'u-release': 'Sienna Garcia',
  'u-rachel': 'Rachel Kowalski', 'u-mia': 'Mia Singh', 'u-nora': 'Nora DaSilva',
  'u-asha': 'Asha Nair', 'u-jonas': 'Jonas Lindqvist', 'u-farah': 'Farah Osei',
  'u-layla': 'Layla Hassan', 'u-eli': 'Eli Garcia', 'u-caleb': 'Caleb Turner',
  'u-nina': 'Nina Rivera', 'u-katya': 'Katya Petrov',
};

/** One history line: [key, channel slug or dm pair, author, hours ago, text]. */
export type HistoryLine = readonly [key: string, where: string, user: string, hoursAgo: number, text: string];

export interface HistoryChannel {
  slug: string; name: string; description: string; privacy: 'public' | 'private';
  owner: string; daysAgo: number; members: readonly string[];
}

/** Channels added to the seed; their members beyond the owner. */
export const EXTRA_CHANNELS: readonly HistoryChannel[] = [
  { slug: 'random', name: 'Random', description: 'Off-topic. Links, lunch, and the occasional cat.', privacy: 'public', owner: 'u-theo', daysAgo: 20,
    members: ['u-farah', 'u-sana', 'u-jonas', 'u-asha', 'u-mia', 'u-nora', 'u-vera', 'u-rachel'] },
  { slug: 'incidents', name: 'Incidents', description: 'Live incidents and their write-ups: severity, symptom, who is commanding, when the next update lands.', privacy: 'public', owner: 'u-rachel', daysAgo: 16,
    members: ['u-vera', 'u-theo', 'u-release', 'u-nora', 'u-mia', 'u-sana'] },
  { slug: 'events', name: 'Events', description: 'Tech talks, office hours and the quarterly community call.', privacy: 'public', owner: 'u-mira', daysAgo: 13,
    members: ['u-lena', 'u-sana', 'u-farah', 'u-asha', 'u-jonas'] },
  // The two initiative channels beside #auth-migration, bound in mock/social-bindings.ts.
  { slug: 'observability', name: 'Observability', description: 'Collectors, span metrics and burn-rate alerts. Bound to the Observability Platform initiative in Work.', privacy: 'public', owner: 'u-nora', daysAgo: 12,
    members: ['u-layla', 'u-eli', 'u-caleb', 'u-vera', 'u-rachel'] },
  { slug: 'llm-platform', name: 'LLM platform', description: 'Prompts, the canary judge and golden sets. Bound to the LLM Application Platform initiative in Work.', privacy: 'public', owner: 'u-nina', daysAgo: 11,
    members: ['u-katya', 'u-caleb', 'u-vera'] },
];

/** People added to channels the base seed already had (never #moderators, never Sana in #design-reviews). */
export const EXTRA_MEMBERS: Record<string, readonly string[]> = {
  'general': ['u-vera', 'u-release', 'u-rachel', 'u-mia', 'u-nora', 'u-asha', 'u-jonas'],
  'design-reviews': ['u-asha', 'u-jonas', 'u-nora'],
  'auth-migration': ['u-nora', 'u-rachel'],
};

/** Direct messages are `<a>|<b>`; the channel name sorts the pair (dmChannelFor). */
export const dmKey = (a: string, b: string): string => [a, b].sort().join('|');

export const HISTORY: readonly HistoryLine[] = [
  // ── #general ──
  // Release trains, freezes, office hours and new runbooks: the notices an engineering org actually reads.
  ['g01', 'general', 'u-mira', 236, 'Quick housekeeping: the community call moves to Thursdays at 3pm for the autumn. Calendar invites went out this morning.'],
  ['g02', 'general', 'u-jonas', 233, 'Thursdays work for me. Will the recording and its transcript go up under Recordings like last time?'],
  ['g03', 'general', 'u-mira', 232, '@Jonas Lindqvist yes, the recording and the transcript land under Recordings within the hour.'],
  ['g04', 'general', 'u-asha', 214, 'New here from the assessment side. I score CI maturity for client teams; which channel has the pipeline and release talk?'],
  ['g05', 'general', 'u-lena', 213, '@Asha Nair this one for release trains and freezes, #incidents for anything on fire, and the initiative channels like #auth-migration for the actual cutover work.'],
  ['g06', 'general', 'u-theo', 190, 'Reminder: #incidents is for live incidents and their write-ups. If an alert fired and you do not understand it, start a thread here first.'],
  ['g07', 'general', 'u-nora', 168, 'OTel office hours on Wednesday, 11 to 12 in the Town hall room. Bring a service that still emits StatsD and we will move it to OTLP live, alerts included.'],
  ['g08', 'general', 'u-rachel', 166, '@Nora DaSilva bringing the billing worker: 14 StatsD counters and two alerts that page on them.'],
  ['g09', 'general', 'u-vera', 150, 'Design review for session token rotation on tenant switch is open in #design-reviews. The open question is a 120-second or a 60-second replay window.'],
  ['g10', 'general', 'u-release', 121, 'Heads up: the release train leaves Friday. The auth service is frozen from Thursday noon; anything that needs a sign-off, ping me by then with the change and its rollback step.'],
  ['g11', 'general', 'u-mia', 120, '@Sienna Garcia two from Mobile: the deep-link routing map and the new bottom tabs. Both roll back with a feature flag.'],
  ['g12', 'general', 'u-vera', 96, 'Auth Migration update: the BFF sign-in with code + PKCE and the JWKS key-rotation handling are live. Customer tenants leave the SAML shim one at a time once the order is decided. Details in #auth-migration.'],
  ['g13', 'general', 'u-rachel', 94, 'And nobody gets signed out when their tenant moves. The rehearsal gate is zero forced logouts and a flat login error rate.'],
  ['g14', 'general', 'u-nora', 73.5, 'New in the runbook library: "Pin a Bedrock knowledge base\'s search type and prove the ranking order". The default search ranked our documents backwards (top-1 right on 0 of 8 queries, 8 of 8 with HYBRID), and Nina Rivera lost most of a day tuning prompts before anyone looked at the order of the sources.'],
  ['g15', 'general', 'u-theo', 71.5, '@Nora DaSilva does it cover the gateway Lambda too? That one carries its own copy of the retrieval config.'],
  ['g16', 'general', 'u-nora', 70, '@Theo Chang yes. Step four checks both call sites for the search-type override and fails if either one is missing it.'],
  ['g17', 'general', 'u-farah', 50, 'Accessibility review queue is open for the autumn: I can take two component reviews a week. Post the Storybook link and the states you want checked.'],
  ['g18', 'general', 'u-mira', 49, '@Farah Osei added you to the Community team, so the review requests reach you.'],
  ['g19', 'general', 'u-sana', 27, 'Question about the billing export fix: do the customers who got a partial export on Tuesday need to ask for it again?'],
  ['g20', 'general', 'u-rachel', 26, '@Sana Iqbal no, it reruns automatically. The backfill picked up every export over 50,000 invoices from the last seven days.'],
  ['g21', 'general', 'u-theo', 3, '@Farah Osei are you on the community call tomorrow? I would like your eyes on the contrast fix for the checkout drawer before it ships.'],
  // ── #design-reviews ──
  // Real reviews: the session-rotation window (Vera's design, presented by Nora: Vera is not in this channel),
  // RED dashboards and their cardinality, and accessibility findings with the numbers that fail.
  ['d01', 'design-reviews', 'u-lena', 200, 'Kicking this channel off properly. Post the doc or screenshot, the decision you need and by when, and tag one reviewer, not five.'],
  ['d02', 'design-reviews', 'u-nora', 190, 'Posting Vera\'s design for session token rotation on tenant switch. A switch mints a new cookie, but copies of the old one stay valid until the grants refresh, up to 120 seconds. Proposal: bump a session epoch on every switch and reject older cookies at refresh.'],
  ['d03', 'design-reviews', 'u-theo', 188, 'The epoch bump is one conditional write per switch, so it is cheap. The catch is masquerade: an operator impersonating a user must not bump it, or they sign the real user out on every device.'],
  ['d04', 'design-reviews', 'u-nora', 186, '@Theo Chang agreed, masquerade is exempt in the design. The open question is the window: 120 seconds is the current refresh loop; 60 seconds means halving the loop, which doubles session reads on the BFF.'],
  ['d05', 'design-reviews', 'u-theo', 185, 'Then I would ship the epoch at 120 seconds now and only pay for 60 if the SOC 2 control actually says 60. Rhea is checking the control wording.'],
  ['d06', 'design-reviews', 'u-asha', 160, 'Rubric editor mockup attached. Question: should the fourteen criteria collapse by default? Assessors scan the evidence column first.'],
  ['d07', 'design-reviews', 'u-jonas', 158, '@Asha Nair collapse them, with the count and the lowest score in the header. On the CI dimension nobody reads fourteen open criteria at once.'],
  ['d08', 'design-reviews', 'u-lena', 156, 'Collapsed by default, with a count in the header, is what we did in the moderation queue and it tested well.'],
  ['d09', 'design-reviews', 'u-nora', 120, 'RED dashboards from span metrics: draft is up. Rate, errors and duration per service come from the spanmetrics connector, so every OTLP service gets them with no per-service code. Duration buckets run from 5 ms to 10 s.'],
  ['d10', 'design-reviews', 'u-theo', 118, '@Nora DaSilva the connector makes a series per span name, and the gateway puts the channel name in its span names. That is a cardinality bomb. Can we normalise names before the connector?'],
  ['d11', 'design-reviews', 'u-nora', 116, '@Theo Chang yes: a transform processor rewrites span names to the route template before spanmetrics. Adding it to the design with a budget of 5,000 series per service.'],
  ['d12', 'design-reviews', 'u-farah', 100, 'Accessibility pass on the onboarding flow: focus order skips the team picker on step three, and the progress bar has no accessible name. Both fail WCAG 2.2 AA.'],
  ['d13', 'design-reviews', 'u-lena', 99, '@Farah Osei thank you, logging both. Step three is mine to fix.'],
  ['d14', 'design-reviews', 'u-jonas', 52, 'Dark mode pass on the checkout drawer. Contrast on the muted controls is borderline.'],
  ['d15', 'design-reviews', 'u-farah', 51, 'Jonas, borderline is generous: the remove-item icon measures 3.1:1 against the drawer. Non-text controls need 3:1 at minimum and our own rule is 4.5:1, so it needs the strong stroke token.'],
  ['d16', 'design-reviews', 'u-jonas', 50, 'Fair. Bumped it to the strong token; it measures 5.2:1 now.'],
  ['d17', 'design-reviews', 'u-asha', 8, 'Revised rubric editor is up. @Farah Osei could you do the keyboard pass on it when you have a minute?'],
  // ── #moderators (private: Lena, Mira) ──
  ['m01', 'moderators', 'u-lena', 230, 'Moderation guidelines are pinned here. Short version: warn once, explain why, then act.'],
  ['m02', 'moderators', 'u-mira', 228, 'Adding the escalation ladder to the pin as well, so nobody has to guess who to call at night.'],
  ['m03', 'moderators', 'u-lena', 150, 'Resolved the thread from last week. No action beyond a friendly note.'],
  ['m04', 'moderators', 'u-mira', 100, 'Rota for next month is drafted. Lena, please check the Tuesday overlap.'],
  ['m05', 'moderators', 'u-lena', 99, 'Tuesday overlap is fine, I will cover the gap myself.'],
  // ── #auth-migration ──
  // One timeline with the Work board (docs/demo-content-audit.md, the Work
  // story): customer tenants leave the SAML shim one at a time; the ORDER is
  // the escalated decision d-cognito-cutover, which Vera raised and Sienna
  // (release manager) decides; the runbook story wi-auth-e2-s2 waits on it.
  // Rehearsal two (session sess-auth-06) failed at the flip and its runbook
  // edit (prop-tenant-cutover-callback) is pending. Nothing here says the
  // cutover is done: it is not.
  ['a01', 'auth-migration', 'u-vera', 180, 'Plan for the next two weeks: rehearse the cutover runbook on our two internal tenants, then move customer tenants off the SAML shim one at a time.'],
  ['a02', 'auth-migration', 'u-theo', 178, 'Search has one callback left on the SAML shim: its ACS URL still points at the shim. I will move it to the BFF before the first rehearsal.'],
  ['a03', 'auth-migration', 'u-mia', 160, 'Support docs for the new sign-in screen are drafted, with the hosted sign-in page screenshots. They are in the shared folder.'],
  ['a04', 'auth-migration', 'u-nora', 140, 'Are session cookies shared across tenants after the switch? A few people asked.'],
  ['a05', 'auth-migration', 'u-vera', 139, '@Nora DaSilva no, one cookie per tenant context, and a cutover never signs anyone out: the old SAML session stays valid until its own expiry, and the next request mints the new cookie.'],
  ['a06', 'auth-migration', 'u-rachel', 130, 'I am on call for both rehearsals and will watch the login error rate and the 401 rate on the BFF during each flip.'],
  ['a07', 'auth-migration', 'u-release', 72, 'Before I approve any customer cutover: which tenant goes first? Smallest first or riskiest first changes who we warn and when.'],
  ['a08', 'auth-migration', 'u-nora', 70, 'Riskiest first. The two tenants with custom SAML attribute mappings are where the unknowns are, and rollback is cheapest while the shim is still warm: it is one DNS flip back.'],
  ['a09', 'auth-migration', 'u-theo', 69, 'Smallest first. A loud failure on our biggest customer costs more than anything we would learn from it.'],
  ['a10', 'auth-migration', 'u-vera', 49, 'We are split, and the order is a release call more than an engineering one. I have escalated "Cutover order for legacy SSO tenants" to @Sienna Garcia. The cutover runbook story waits on it; the session work carries on.'],
  ['a11', 'auth-migration', 'u-release', 47, 'Got it. I want both rehearsals through first, then I will decide the order.'],
  ['a11b', 'auth-migration', 'u-nora', 46, 'The agent run that moved the token verifier off the deprecated JWKS client failed on three tests. They still expected the signing key from before the last rotation, so the test keys were stale, not the verifier. I regenerated them and queued the rerun.'],
  ['a12', 'auth-migration', 'u-nora', 6, 'First rehearsal is through on the cutover runbook: zero forced logouts, login errors flat.'],
  ['a13', 'auth-migration', 'u-nora', 2.0, 'Second rehearsal failed at the flip: the hosted sign-in page still redirected to the old domain, because the tenant origin was missing from its Cognito callback list. Rolled back in two minutes and nobody was signed out.'],
  ['a14', 'auth-migration', 'u-vera', 1.8, '@Nora DaSilva good catch. Can the callback check go into the runbook before we retry?'],
  ['a15', 'auth-migration', 'u-nora', 1.6, 'Proposed as an edit to the cutover runbook: a new step that checks the callback and sign-out lists before the flip. It needs a review before the retry.'],
  ['a16', 'auth-migration', 'u-release', 0.8, 'Then I decide the order once the retry is clean. Expect it tomorrow.'],
  // ── #observability ──
  // Sprint 11 as the board has it: the collector OOM fix with an agent on it,
  // span metrics behind an allow-list, nine services left on StatsD.
  ['o01', 'observability', 'u-nora', 60, 'Sprint 11 is live: span metrics for checkout and search behind an allow-list, the collector OOM fix, and the first two services off StatsD. Burn-rate alerts carry over from Sprint 10 while the backtest runs.'],
  ['o02', 'observability', 'u-eli', 40, 'The OOM fix for the gateway collectors is up: memory_limiter first in the pipeline and the sending queue bounded at 5,000 batches. Replaying the 40k spans a second burst against it next.'],
  ['o03', 'observability', 'u-layla', 30, 'Nine services still push StatsD through the bridge. Billing and notifications go first: neither has a paging alert on a StatsD metric.'],
  ['o04', 'observability', 'u-caleb', 26, 'For the span-metrics connector, keep route labels templated. One raw path label on search would add tens of thousands of series in an hour.'],
  ['o05', 'observability', 'u-layla', 25, '@Caleb Turner agreed. The allow-list starts with checkout and search, every route label is a template, and the rollout stops if active series pass 50,000.'],
  ['o06', 'observability', 'u-eli', 4.5, 'Burst replay passed on the fixed config: no OOM kills, peak memory 1.6 GiB of 2 GiB. One check left before I call it done: every error span kept during the burst.'],
  ['o07', 'observability', 'u-nora', 4, '@Eli Garcia good. Keep the bug open until the error-span check passes. After that, the dependency map for grouping duplicate alerts: 212 edges come from traces, and the batch jobs have to be declared by their owners.'],
  // ── #llm-platform ──
  // The judge-model decision (d-eval-judge-model, Nina's), the golden sets and the prompt cache stampede.
  ['l01', 'llm-platform', 'u-nina', 70, 'Sprint 9 goal: the canary judge scores every sampled answer, and golden sets gate merges. The judge model is still open: "Judge model for canary evaluation" on the Decisions tab.'],
  ['l02', 'llm-platform', 'u-caleb', 50, 'Pilot numbers on the 120 questions: Nova Pro agrees with human labels 82 percent of the time, Nova Lite 71 percent at about a sixth of the cost per judged answer.'],
  ['l03', 'llm-platform', 'u-katya', 45, 'Golden sets are versioned with their prompt now. Each agent has 30 to 60 questions, and a merge fails when any rubric dimension drops more than 0.03.'],
  ['l04', 'llm-platform', 'u-katya', 20, 'The prompt cache stampede again after yesterday\'s deploy: 43 replicas fetched the same prompt in one second and 12 were throttled. Jitter plus stale-while-revalidate is the fix.'],
  ['l05', 'llm-platform', 'u-caleb', 18, '@Katya Petrov I can pair on that after the judge work. And for the decision: halving the sample rate to 10 percent funds Nova Pro at the current spend.'],
  ['l06', 'llm-platform', 'u-nina', 3, 'I will decide the judge model once both candidates have run the final rubric weights over the pilot set. Expect it this week.'],
  // ── #random ──
  ['r01', 'random', 'u-theo', 230, 'Rule one of #random: no work talk. Rule two: see rule one.'],
  ['r02', 'random', 'u-jonas', 226, 'Found the exact mechanical keyboard from my first job, clicky blue switches and all. I may have bought it.'],
  ['r03', 'random', 'u-sana', 224, '@Jonas Lindqvist link please, for science.'],
  ['r04', 'random', 'u-asha', 190, 'Anyone running the 10k on Saturday? The route goes past the old office.'],
  ['r05', 'random', 'u-vera', 188, '@Asha Nair I am, at a pace that will embarrass nobody because nobody will see me.'],
  ['r06', 'random', 'u-farah', 150, 'Lunch spot recommendation near the east entrance? I am tired of the cafeteria soup.'],
  ['r07', 'random', 'u-mia', 149, 'The dumpling place on the corner. Order the pork one.'],
  ['r08', 'random', 'u-nora', 100, 'Spent Saturday wiring a distance sensor to a Raspberry Pi to graph my sourdough starter. It peaks at six hours forty. Yes, there is a dashboard.'],
  ['r09', 'random', 'u-rachel', 98, '@Nora DaSilva does the starter have an SLO, and who gets paged?'],
  ['r10', 'random', 'u-theo', 60, 'Friday playlist thread. Add one song you would defend in court.'],
  ['r11', 'random', 'u-sana', 58, 'Anything by Khruangbin, my defense rests.'],
  ['r12', 'random', 'u-farah', 24, '@Theo Chang I will contribute a very good song to the playlist and refuse to explain it.'],
  ['r13', 'random', 'u-jonas', 10, 'The keyboard arrived. It is loud. I regret nothing.'],
  // ── #incidents ──
  // Three incidents, each with a commander, a cause and an action: the gateway saturating one vCPU (the capacity decision
  // still owed), the collector OOM that bounded the exporter queue, and Rachel's Sev 3 on the billing export (Theo's root cause).
  ['i01', 'incidents', 'u-rachel', 168, 'Channel rules, pinned: open with severity, symptom, start time and who is commanding. A stale health check is not an outage, so check the probe\'s own timestamp before you page anyone.'],
  ['i02', 'incidents', 'u-rachel', 150, 'Sev 2, started ten minutes ago: the realtime gateway is dropping websocket connections. Chat and presence are reconnecting in a loop for about a third of users. I am commanding; Theo is on the gateway.'],
  ['i03', 'incidents', 'u-theo', 149.8, 'The single gateway task is pinned at 100% of its one vCPU with about 900 sockets open. Heartbeats miss their deadline, clients reconnect, and every reconnect re-subscribes presence on every channel, which makes it worse.'],
  ['i04', 'incidents', 'u-rachel', 149.5, 'Options: raise the task to two vCPU now, or shed presence fan-out. A second gateway is not one of them: the single-gateway safeguard is there because presence state is not shared between gateways yet.'],
  ['i05', 'incidents', 'u-theo', 149, 'Raised the task to two vCPU and redeployed. 940 sockets, CPU at 55%, reconnect rate flat within six minutes. Mitigated 36 minutes after the first page.'],
  ['i06', 'incidents', 'u-release', 148, 'Thanks both. Before the next release train I need the capacity call written down: raise the CPU for good, accept a smaller profile, or lift the single-gateway safeguard. That is a decision, not a ticket.'],
  ['i07', 'incidents', 'u-vera', 147, 'Agreed. The load test passed 1,000 sockets on one vCPU but never exercised a reconnect storm. Postmortem action: add a reconnect-storm scenario to the load test.'],
  ['i12', 'incidents', 'u-nora', 100, 'Sev 3, resolved: two collector gateways were OOM-killed over half an hour overnight under a burst of 40k spans a second. Traces were lost for six minutes; no alert was missed, because metrics run through a separate pipeline.'],
  ['i13', 'incidents', 'u-nora', 99, 'Cause: the exporter\'s sending queue was unbounded, so a slow tracing backend let it grow until the pod hit its 2 GiB limit. Fix in review: memory_limiter first in the pipeline and a bounded queue. We drop healthy spans before we lose the gateway.'],
  ['i14', 'incidents', 'u-mia', 98, '@Nora DaSilva does the bounded queue change what we pay for trace storage? Asking for the showback numbers.'],
  ['i15', 'incidents', 'u-nora', 97, '@Mia Singh slightly down. Tail sampling still keeps every error and every p99 trace, and we stop retrying spans the backend already refused.'],
  ['i08', 'incidents', 'u-rachel', 20, 'Sev 3: the nightly billing export is late for customer tenants with more than 50,000 invoices. Invoices are fine; only the export file is stuck. Fix is rolling out, next update in 30 minutes.'],
  ['i09', 'incidents', 'u-theo', 19, 'Root cause: the billing-export queue\'s visibility timeout is 30 minutes, sized for a typical tenant. The largest tenants\' exports run about 70 minutes, the message reappears, and a second worker starts the same export, so those tenants got two or three partial files and never a finished one. Raising the timeout to two hours and extending it from the worker while an export runs. The job also gets duplicate-run protection: a second worker that picks up a running export lets it go.'],
  ['i10', 'incidents', 'u-rachel', 18, 'Exports caught up: 23 delayed tenant exports delivered, the oldest nine hours late. Closing, postmortem draft to follow. @Mia Singh you reported it first, thank you.'],
  ['i11', 'incidents', 'u-mia', 17, 'Happy to review the postmortem. One question for it: why did nothing alert while the same export ran three times?'],
  ['i11b', 'incidents', 'u-rachel', 16, 'Good question, and it is an action item now: alarm on the age of the oldest message and on any receive count above one, and send a job to a dead-letter queue after three receives instead of retrying forever.'],
  // ── #events ──
  ['e01', 'events', 'u-mira', 190, 'Quarterly community call is booked for Thursday at 3pm in the Town hall room. Agenda doc coming this week, add topics in the thread.'],
  ['e02', 'events', 'u-asha', 186, 'Topic suggestion: how assessors and moderators can share a calibration set.'],
  ['e03', 'events', 'u-lena', 185, '@Asha Nair great topic, you can present it if you like. Ten minutes.'],
  ['e04', 'events', 'u-jonas', 160, 'Lunch-and-learn proposal: "What a level 4 CI pipeline looks like". Twenty minutes on two anonymised client pipelines: build time, flaky-test rate, and how long main stays red.'],
  ['e05', 'events', 'u-mira', 158, '@Jonas Lindqvist booked for next Wednesday.'],
  ['e06', 'events', 'u-sana', 120, 'Can I run a lightning talk on onboarding feedback? I have 12 responses and some patterns.'],
  ['e07', 'events', 'u-mira', 119, 'Yes please, five minutes. @Sana Iqbal you are in after Asha.'],
  ['e10', 'events', 'u-mira', 96, 'Tech talk next Thursday after the call: Daniel Novak on cutting Flink checkpoint recovery from four minutes to under one, with incremental RocksDB checkpoints and unaligned barriers.'],
  ['e11', 'events', 'u-lena', 94, 'And the week after, Nora DaSilva on how the auth team rehearses a tenant cutover: the gate, the rollback, and the step the second rehearsal taught them.'],
  ['e08', 'events', 'u-farah', 70, 'I volunteered for call notes. Will post a template in this channel by Wednesday.'],
  ['e09b', 'events', 'u-jonas', 69, 'Please include a decisions section, it is the part people actually look for later.'],
  ['e12', 'events', 'u-farah', 40, 'Template posted in the doc: decisions first, then actions with an owner and a date, then the discussion.'],
  ['e09', 'events', 'u-mira', 12, '@Farah Osei one more favor: could you share your screen for the agenda walkthrough?'],
  // ── direct messages: <a>|<b> ──
  ['p01', 'u-farah|u-mira', 'u-mira', 140, 'Hi Farah, welcome. Anything you need to get set up, ask me.'],
  ['p02', 'u-farah|u-mira', 'u-farah', 139, 'Thanks Mira! One question: do I need a Teams role to start posting in #events?'],
  ['p03', 'u-farah|u-mira', 'u-mira', 138, 'Nope, channels are open. Teams are for grouping people and their channels.'],
  ['p04', 'u-farah|u-mira', 'u-farah', 30, 'The call notes template is posted. Can you skim it before Thursday?'],
  ['p05', 'u-farah|u-mira', 'u-mira', 2, 'Skimmed it. Two small suggestions in the doc, otherwise perfect. Thank you!'],
  ['p06', 'u-farah|u-theo', 'u-theo', 90, 'Could you run a screen-reader pass on the checkout drawer change before I merge it? The remove-item button announces as "button" with no label.'],
  ['p07', 'u-farah|u-theo', 'u-farah', 88, 'Give me until after lunch. Which build should I use?'],
  ['p08', 'u-farah|u-theo', 'u-theo', 6, 'The preview build from the pull request; the drawer opens from the cart. No rush, tomorrow is fine.'],
  ['p09', 'u-farah|u-vera', 'u-vera', 52, 'Farah, thank you for the accessibility pass on the new sign-in screen. The focus-order fix ships with the next cutover.'],
  ['p10', 'u-farah|u-vera', 'u-farah', 51, 'Happy to check it again once the fix is in.'],
  ['p11', 'u-farah|u-vera', 'u-vera', 1, 'The fix is in the preview build. I will send you the link once the release notes are up.'],
  ['p12', 'u-farah|u-lena', 'u-lena', 26, 'Thanks for the accessibility notes, they were exactly the kind of thing we miss.'],
  ['p13', 'u-farah|u-lena', 'u-farah', 25, 'Happy to. Want me to run the same check on the moderation queue?'],
  ['p14', 'u-farah|u-lena', 'u-lena', 0.5, 'Yes please. I will share the staging link in a few minutes.'],
  ['p15', 'u-farah|u-sana', 'u-sana', 14, 'Do you remember which headset Jonas recommended? I lost the message.'],
  ['p16', 'u-farah|u-sana', 'u-farah', 13, 'He said he would send you the model in a DM. Ping him again.'],
  ['p17', 'u-mira|u-theo', 'u-theo', 40, 'Can you approve the settings page change for the preview environment?'],
  ['p18', 'u-mira|u-theo', 'u-mira', 39, 'Approved.'],
  ['p19', 'u-nora|u-vera', 'u-nora', 1.4, 'Question on my cutover runbook edit: the new step reads the app client\'s callback list and greps for the tenant origin. Should it check the sign-out list too?'],
  ['p20', 'u-nora|u-vera', 'u-vera', 1.3, 'Yes, both. A missing sign-out URL strands people on the hosted page with a 400. Make it one check before the flip, and print the missing URL when it fails.'],
  ['p21', 'u-nora|u-vera', 'u-nora', 1.2, 'Done. The proposal checks both lists now; Simone has it for review.'],
  ['p22', 'u-rachel|u-theo', 'u-rachel', 15, 'Postmortem draft for the billing export delay is up. Can you check the first hour of the timeline? From the receive counts, the first redelivery came exactly 30 minutes after the first worker picked the export up: the visibility timeout.'],
  ['p23', 'u-rachel|u-theo', 'u-theo', 14, 'Thirty minutes is right. The duplicate worker received it within a second of the redelivery; I attached the worker logs to the timeline.'],
];

/** Messages pinned for the demo: [channel slug, key, who pinned, hours ago]. */
export const PINS: readonly (readonly [slug: string, key: string, by: string, hoursAgo: number])[] = [
  ['design-reviews', 'd01', 'u-lena', 199],
  ['moderators', 'm01', 'u-lena', 229],
  ['auth-migration', 'a01', 'u-vera', 179],
  ['auth-migration', 'a10', 'u-vera', 48],
  ['events', 'e01', 'u-mira', 188],
  ['incidents', 'i01', 'u-rachel', 165],
];

/**
 * Auth Migration's initiative thread (`orgiq:initiative:p-auth-migration`, the
 * Discussion pane on the initiative page): [key, author, hours ago, text]. The
 * same timeline as #auth-migration above, said beside the board — the owner
 * escalates, the release manager answers, the SME reports the rehearsal.
 */
export const INITIATIVE_THREAD: readonly (readonly [key: string, user: string, hoursAgo: number, text: string])[] = [
  ['auth-01', 'u-vera', 48.5, 'I have escalated "Cutover order for legacy SSO tenants" to Sienna Garcia. "Tenant-by-tenant cutover runbook with rollback" is blocked until she decides; the rest of Sprint 10 carries on.'],
  ['auth-02', 'u-release', 46.5, 'I will decide once both internal rehearsals are through. Keep the session hardening moving in the meantime.'],
  ['auth-02b', 'u-nora', 45.5, 'The JWKS client migration run failed on stale test keys from before the last rotation, not on the verifier. Keys regenerated, rerun queued.'],
  ['auth-03', 'u-nora', 5.5, 'Rehearsal one passed on the cutover runbook: zero forced logouts.'],
  ['auth-04', 'u-nora', 1.9, 'Rehearsal two failed at the flip because the tenant origin was missing from its Cognito callback list. Rolled back cleanly. I proposed the missing step as an edit to the runbook; it is waiting for review.'],
  ['auth-05', 'u-vera', 1.1, 'Thanks Nora. Simone, can you review the runbook edit before the retry? Sienna decides the order after that.'],
];

/**
 * Northstar Payments' team thread (`assessment:team:TEAM-001`, the Discussion
 * pane on the team page): [key, author, hours ago, text]. Jonas leads the
 * assessment, Asha contributes; the thread says what the scorecard shows (the
 * CI claim) and what waits on Jonas (the dimension 7 not-applicable request).
 */
export const TEAM_THREAD: readonly (readonly [key: string, user: string, hoursAgo: number, text: string])[] = [
  ['nsp-01', 'u-asha', 52, 'Northstar rated Continuous Integration as Optimizing. The api repo builds on every push, but the infra repo has no pipeline at all, so I scored it Developing.'],
  ['nsp-02', 'u-jonas', 50, 'Agreed, Developing stands. I will send them the story for closing the gap rather than argue the level on a call.'],
  ['nsp-03', 'u-asha', 27, 'They also asked for not-applicable on performance and reliability testing. Their only job is the overnight reconciliation batch, with nothing internet-facing.'],
  ['nsp-04', 'u-jonas', 26, 'That is mine to decide. I want to see the batch window and the rerun policy first; I will answer by the end of the week.'],
];

/** Everyone in `where` (a channel slug or `a|b` pair) who is named by `@Display Name` in `text`. */
export function mentionedIn(text: string, candidates: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return candidates.filter((id) => lower.includes(`@${(CAST[id] ?? '').toLowerCase()}`));
}
