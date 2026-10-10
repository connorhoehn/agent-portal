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
  { slug: 'incidents', name: 'Incidents', description: 'Something is on fire. Say what, say who, say when.', privacy: 'public', owner: 'u-rachel', daysAgo: 16,
    members: ['u-vera', 'u-theo', 'u-release', 'u-nora', 'u-farah', 'u-mia'] },
  { slug: 'events', name: 'Events', description: 'Meetups, office hours and the quarterly community call.', privacy: 'public', owner: 'u-mira', daysAgo: 13,
    members: ['u-lena', 'u-sana', 'u-farah', 'u-asha', 'u-jonas'] },
];

/** People added to channels the base seed already had (never #moderators, never Sana in #design-reviews). */
export const EXTRA_MEMBERS: Record<string, readonly string[]> = {
  'general': ['u-vera', 'u-release', 'u-rachel', 'u-mia', 'u-nora', 'u-asha', 'u-jonas'],
  'design-reviews': ['u-asha', 'u-jonas', 'u-nora'],
  'auth-migration': ['u-farah', 'u-nora', 'u-rachel'],
};

/** Direct messages are `<a>|<b>`; the channel name sorts the pair (dmChannelFor). */
export const dmKey = (a: string, b: string): string => [a, b].sort().join('|');

export const HISTORY: readonly HistoryLine[] = [
  // ── #general ──
  ['g01', 'general', 'u-mira', 236, 'Quick housekeeping: the community call moves to Thursdays at 3pm for the autumn. Calendar invites went out this morning.'],
  ['g02', 'general', 'u-jonas', 233, 'Thursdays work for me. Will the recording go up in the Library like last time?'],
  ['g03', 'general', 'u-mira', 232, '@Jonas Lindqvist yes, everything lands under Recordings within the hour.'],
  ['g04', 'general', 'u-asha', 214, 'New here from the assessment side. Is there a good first channel to read through?'],
  ['g05', 'general', 'u-lena', 213, '@Asha Nair start with #design-reviews and #events, they are the busiest. Welcome!'],
  ['g06', 'general', 'u-theo', 190, 'Reminder that #random exists so this channel can stay about announcements.'],
  ['g07', 'general', 'u-sana', 168, 'Anyone else seeing the new onboarding checklist? It is much clearer than the old wiki page.'],
  ['g08', 'general', 'u-farah', 166, '@Sana Iqbal yes, I walked through it on Monday. The "pick a team" step is the best part.'],
  ['g09', 'general', 'u-nora', 150, 'Office hours this week are in the Town hall room, 11 to 12. Bring questions about the migration.'],
  ['g10', 'general', 'u-release', 121, 'Heads up: the release train leaves Friday. Anything that needs a sign-off, ping me by Thursday noon.'],
  ['g11', 'general', 'u-mia', 120, '@Sienna Garcia will do. Two items from my side, both small.'],
  ['g12', 'general', 'u-vera', 96, 'Thank you all for the quick turnaround on the tenant cutover. It went smoother than the rehearsal.'],
  ['g13', 'general', 'u-rachel', 94, 'Seconding that. Zero pages overnight, which I will take.'],
  ['g14', 'general', 'u-mira', 73.5, 'Welcome Mia and Nora to the moderators rota for next month, subject to Lena handing over the runbook.'],
  ['g15', 'general', 'u-lena', 71.5, 'Runbook is in the pinned message in #moderators. Read it before your first shift please.'],
  ['g16', 'general', 'u-farah', 50, '@Mira Okafor can I get added to the events team? I would like to help with the call notes.'],
  ['g17', 'general', 'u-mira', 49, '@Farah Osei done, you should see it under Teams now.'],
  ['g18', 'general', 'u-asha', 30, 'Thanks for the warm welcome everyone, this is a friendly place.'],
  ['g19', 'general', 'u-sana', 27, 'Does anyone have a recommendation for a good headset? Mine finally gave up.'],
  ['g20', 'general', 'u-jonas', 26, '@Sana Iqbal I have used the same wired one for four years. DM me and I will send the model.'],
  ['g21', 'general', 'u-theo', 3, '@Farah Osei are you joining the call tomorrow? We could use your notes on the rubric thread.'],
  // ── #design-reviews ──
  ['d01', 'design-reviews', 'u-lena', 200, 'Kicking this channel off properly. Post a link or a screenshot, say what you want feedback on, and tag a reviewer.'],
  ['d02', 'design-reviews', 'u-theo', 190, 'Sharing the settings page redesign. Mostly asking about the grouping of notification toggles.'],
  ['d03', 'design-reviews', 'u-mira', 188, 'The grouping makes sense. I would put digest frequency above the per-channel switches though.'],
  ['d04', 'design-reviews', 'u-farah', 186, '@Theo Chang agree with Mira. Also the toggle labels are doing a lot of work, maybe add one line of helper text.'],
  ['d05', 'design-reviews', 'u-theo', 185, 'Good call both. Updating now.'],
  ['d06', 'design-reviews', 'u-asha', 160, 'Rubric editor mock attached. The question is whether criteria should collapse by default.'],
  ['d07', 'design-reviews', 'u-jonas', 158, '@Asha Nair collapse them. Nobody reads fourteen open criteria at once.'],
  ['d08', 'design-reviews', 'u-lena', 156, 'Collapsed by default, with a count in the header, is what we did in the moderation queue and it tested well.'],
  ['d09', 'design-reviews', 'u-nora', 120, 'Empty states for the work queue are up. I tried to make each one say what to do next rather than what is missing.'],
  ['d10', 'design-reviews', 'u-mira', 118, '@Nora DaSilva those read really well. The second one could use an illustration, but copy first.'],
  ['d11', 'design-reviews', 'u-farah', 100, 'Accessibility pass on the onboarding flow: focus order is wrong on step three and the progress bar has no label.'],
  ['d12', 'design-reviews', 'u-lena', 99, '@Farah Osei thank you, logging both. Step three is mine to fix.'],
  ['d13', 'design-reviews', 'u-theo', 74, 'Updated settings page is live in the preview. Digest frequency sits on top now.'],
  ['d14', 'design-reviews', 'u-jonas', 52, 'Dark mode pass on the calls dock. Contrast on the muted controls is borderline.'],
  ['d15', 'design-reviews', 'u-farah', 51, 'Jonas, borderline is generous, the mute icon is 3.1:1 on my screen. Needs a darker stroke.'],
  ['d16', 'design-reviews', 'u-jonas', 50, 'Fair. Bumping it to the strong token.'],
  ['d17', 'design-reviews', 'u-asha', 8, 'Revised rubric editor is up. @Farah Osei could you take another look when you have a minute?'],
  // ── #moderators (private: Lena, Mira) ──
  ['m01', 'moderators', 'u-lena', 230, 'Moderation guidelines are pinned here. Short version: warn once, explain why, then act.'],
  ['m02', 'moderators', 'u-mira', 228, 'Adding the escalation ladder to the pin as well, so nobody has to guess who to call at night.'],
  ['m03', 'moderators', 'u-lena', 150, 'Resolved the thread from last week. No action beyond a friendly note.'],
  ['m04', 'moderators', 'u-mira', 100, 'Rota for next month is drafted. Lena, please check the Tuesday overlap.'],
  ['m05', 'moderators', 'u-lena', 99, 'Tuesday overlap is fine, I will cover the gap myself.'],
  // ── #auth-migration ──
  ['a01', 'auth-migration', 'u-vera', 200, 'Plan for the week: tenants two and three move to the BFF login, then we retire the SAML shim.'],
  ['a02', 'auth-migration', 'u-theo', 198, 'Search has one callback left on the shim. I will have it moved by Wednesday.'],
  ['a03', 'auth-migration', 'u-mia', 192, 'Support docs updated for the new sign-in screen. Screenshots are in the shared folder.'],
  ['a04', 'auth-migration', 'u-nora', 150, 'Are session cookies shared across tenants after the switch? A few people asked.'],
  ['a05', 'auth-migration', 'u-vera', 148, '@Nora DaSilva no, one cookie per tenant context, and switching tenants mints a fresh one.'],
  ['a06', 'auth-migration', 'u-farah', 146, 'That matches what I saw on the assessment side. Switching felt instant.'],
  ['a07', 'auth-migration', 'u-release', 120, 'Cutover window confirmed for Thursday 6am. Rollback plan is in the initiative overview.'],
  ['a08', 'auth-migration', 'u-rachel', 118, 'On call for the window. I will watch the login error rate and post here at 6:30.'],
  ['a09', 'auth-migration', 'u-rachel', 91, 'Cutover is done. Login errors peaked at 0.4% for two minutes and settled to baseline.'],
  ['a10', 'auth-migration', 'u-vera', 90, 'Excellent. @Theo Chang can you confirm search is clean?'],
  ['a11', 'auth-migration', 'u-theo', 89, 'Clean. The last callback was patched yesterday.'],
  ['a12', 'auth-migration', 'u-mia', 30, 'Two customers asked whether the old SAML URL still works. I told them it redirects for another week.'],
  ['a13', 'auth-migration', 'u-vera', 29, '@Mia Singh correct, redirect stays until Friday week, then it returns a 410.'],
  ['a14', 'auth-migration', 'u-release', 4, '@Farah Osei the assessment tenant is next. Do you want the dry run on Tuesday or Wednesday?'],
  // ── #random ──
  ['r01', 'random', 'u-theo', 230, 'Rule one of #random: no work talk. Rule two: see rule one.'],
  ['r02', 'random', 'u-jonas', 226, 'Found a keyboard that is exactly the one from my first job. I may have bought it.'],
  ['r03', 'random', 'u-sana', 224, '@Jonas Lindqvist link please, for science.'],
  ['r04', 'random', 'u-asha', 190, 'Anyone running the 10k on Saturday? The route goes past the old office.'],
  ['r05', 'random', 'u-vera', 188, '@Asha Nair I am, at a pace that will embarrass nobody because nobody will see me.'],
  ['r06', 'random', 'u-farah', 150, 'Lunch spot recommendation near the east entrance? I am tired of the cafeteria soup.'],
  ['r07', 'random', 'u-mia', 149, 'The dumpling place on the corner. Order the pork one.'],
  ['r08', 'random', 'u-nora', 100, 'A photo of the office plant that survived everything: three reorgs and a long weekend.'],
  ['r09', 'random', 'u-rachel', 98, 'That plant has seen things.'],
  ['r10', 'random', 'u-theo', 60, 'Friday playlist thread. Add one song you would defend in court.'],
  ['r11', 'random', 'u-sana', 58, 'Anything by Khruangbin, my defense rests.'],
  ['r12', 'random', 'u-farah', 24, '@Theo Chang I will contribute a very good song to the playlist and refuse to explain it.'],
  ['r13', 'random', 'u-jonas', 10, 'The keyboard arrived. It is loud. I regret nothing.'],
  // ── #incidents ──
  ['i01', 'incidents', 'u-rachel', 168, 'Opening this for the record: the 04:10 alert on the search index was a stale health check, not an outage.'],
  ['i02', 'incidents', 'u-theo', 167, 'Confirmed on my side. Index lag was never above two seconds.'],
  ['i03', 'incidents', 'u-vera', 166, 'Please add the stale check to the runbook so nobody has to learn this at 4am again.'],
  ['i04', 'incidents', 'u-rachel', 160, '@Vera Green done, with a note on how to tell it from a real lag alert.'],
  ['i05', 'incidents', 'u-nora', 100, 'Customer-facing banner for tonight\'s maintenance is drafted. Needs a second pair of eyes.'],
  ['i06', 'incidents', 'u-mia', 99, '@Nora DaSilva reads fine. I would say "about 15 minutes" instead of "briefly".'],
  ['i07', 'incidents', 'u-release', 72, 'Maintenance window finished early. Nothing to report.'],
  ['i08', 'incidents', 'u-rachel', 20, 'Sev 3: transcripts delayed for calls over an hour. Fix is rolling out, next update in 30 minutes.'],
  ['i09', 'incidents', 'u-theo', 19, 'Root cause is a queue that was sized for 30-minute calls. Raising the limit now.'],
  ['i10', 'incidents', 'u-rachel', 18, 'Transcripts caught up. Closing, postmortem draft to follow. @Farah Osei you reported it first, thank you.'],
  ['i11', 'incidents', 'u-farah', 17, 'Glad it was quick. Happy to review the postmortem.'],
  // ── #events ──
  ['e01', 'events', 'u-mira', 190, 'Quarterly community call is booked. Agenda doc coming this week, add topics in the thread.'],
  ['e02', 'events', 'u-asha', 186, 'Topic suggestion: how assessors and moderators can share a calibration set.'],
  ['e03', 'events', 'u-lena', 185, '@Asha Nair great topic, you can present it if you like. Ten minutes.'],
  ['e04', 'events', 'u-sana', 120, 'Can I run a lightning talk on onboarding feedback? I have 12 responses and some patterns.'],
  ['e05', 'events', 'u-mira', 119, 'Yes please, five minutes. @Sana Iqbal you are in after Asha.'],
  ['e06', 'events', 'u-farah', 70, 'I volunteered for call notes. Will post a template in this channel by Wednesday.'],
  ['e07', 'events', 'u-jonas', 69, 'Please include a "decisions" section, it is the part people actually look for later.'],
  ['e08', 'events', 'u-farah', 40, 'Template posted in the doc. Jonas, the decisions section is at the top.'],
  ['e09', 'events', 'u-mira', 12, '@Farah Osei one more favor: could you share your screen for the agenda walkthrough?'],
  // ── direct messages: <a>|<b> ──
  ['p01', 'u-farah|u-mira', 'u-mira', 140, 'Hi Farah, welcome. Anything you need to get set up, ask me.'],
  ['p02', 'u-farah|u-mira', 'u-farah', 139, 'Thanks Mira! One question: do I need a Teams role to start posting in #events?'],
  ['p03', 'u-farah|u-mira', 'u-mira', 138, 'Nope, channels are open. Teams are for grouping people and their channels.'],
  ['p04', 'u-farah|u-mira', 'u-farah', 30, 'The call notes template is posted. Can you skim it before Thursday?'],
  ['p05', 'u-farah|u-mira', 'u-mira', 2, 'Skimmed it. Two small suggestions in the doc, otherwise perfect. Thank you!'],
  ['p06', 'u-farah|u-theo', 'u-theo', 90, 'Do you have a minute to look at the rubric thread? I think we are saying the same thing differently.'],
  ['p07', 'u-farah|u-theo', 'u-farah', 88, 'Probably yes. Give me until after lunch.'],
  ['p08', 'u-farah|u-theo', 'u-theo', 6, 'Sent you the doc link. No rush, tomorrow is fine.'],
  ['p09', 'u-farah|u-vera', 'u-vera', 52, 'Farah, the assessment tenant cutover needs one sign-off from you. It is a checkbox, not an essay.'],
  ['p10', 'u-farah|u-vera', 'u-farah', 51, 'Understood. I will tick it once the dry run is clean.'],
  ['p11', 'u-farah|u-vera', 'u-vera', 1, 'Dry run is Tuesday. I will ping you the moment it finishes.'],
  ['p12', 'u-farah|u-lena', 'u-lena', 26, 'Thanks for the accessibility notes, they were exactly the kind of thing we miss.'],
  ['p13', 'u-farah|u-lena', 'u-farah', 25, 'Happy to. Want me to run the same check on the moderation queue?'],
  ['p14', 'u-farah|u-lena', 'u-lena', 0.5, 'Yes please. I will share the staging link in a few minutes.'],
  ['p15', 'u-farah|u-sana', 'u-sana', 14, 'Do you remember which headset Jonas recommended? I lost the message.'],
  ['p16', 'u-farah|u-sana', 'u-farah', 13, 'He said he would send you the model in a DM. Ping him again.'],
  ['p17', 'u-mira|u-theo', 'u-theo', 40, 'Can you approve the settings page change for the preview environment?'],
  ['p18', 'u-mira|u-theo', 'u-mira', 39, 'Approved.'],
];

/** Messages pinned for the demo: [channel slug, key, who pinned, hours ago]. */
export const PINS: readonly (readonly [slug: string, key: string, by: string, hoursAgo: number])[] = [
  ['design-reviews', 'd01', 'u-lena', 199],
  ['moderators', 'm01', 'u-lena', 229],
  ['auth-migration', 'a01', 'u-vera', 199],
  ['auth-migration', 'a07', 'u-release', 118],
  ['events', 'e01', 'u-mira', 188],
  ['incidents', 'i01', 'u-rachel', 165],
];

/** Everyone in `where` (a channel slug or `a|b` pair) who is named by `@Display Name` in `text`. */
export function mentionedIn(text: string, candidates: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return candidates.filter((id) => lower.includes(`@${(CAST[id] ?? '').toLowerCase()}`));
}
