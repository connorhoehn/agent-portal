// Access answers (docs/user-search-goal.md S4): which catalog items are
// sensitive, a person's (or my reports') requests, and the policy overrides in
// the audit trail — each computed from the reader's own projection, so a
// request a reader may not open is never counted.

import type { SearchDoc } from '../search-index/types.js';
import { words } from '../search-index/tokens.js';
import type { AnswerIntent, TenantAnswer } from './types.js';
import { hasAll, listing, plural, str, toRecords, topicWords } from './util.js';

const mk = (intent: string, text: string, docs: SearchDoc[], sources: string[]): TenantAnswer =>
  ({ intent: `access:${intent}`, text, records: toRecords(docs), rows: docs.map(d => ({ key: `${d.type}:${d.id}`, title: d.title })), sources });

const sensitiveItems: AnswerIntent = {
  id: 'sensitive-items',
  async answer(c) {
    if (!/\bsensitive\b|\b(?:extra|additional)\s+approvals?\b/.test(c.q)) return null;
    if (!/\b(?:roles?|items?|access|catalog|approval|show|which|what)\b/.test(c.q)) return null;
    const all = await c.docs(['catalog']);
    if (!all.length) return null;
    const hits = all.filter(d => (d.facets['sensitive'] ?? []).includes('true')).sort((a, b) => a.title.localeCompare(b.title));
    const text = hits.length
      ? `${plural(hits.length, 'catalog item')} of ${all.length} ${hits.length === 1 ? 'is' : 'are'} sensitive and add an access-admin approval step: ${listing(hits.map(d => d.title))}.`
      : `None of the ${all.length} catalog items is sensitive.`;
    return mk('sensitive-items', text, hits, [`catalog rows (${all.length}), sensitive column`]);
  },
};

const REQUESTS_RE = /\brequests?\b|\basked for\b|\brequested\b|\bwants?\b|\bask(?:s|ed)?\b/;
const REPORTS_RE = /\b(?:my\s+)?(?:direct\s+)?reports?\b/;

const line = (d: SearchDoc) => `${str(d, 'item') || d.title} (${d.id}, ${str(d, 'status') || 'open'})`;

const reportRequests: AnswerIntent = {
  id: 'report-requests',
  async answer(c) {
    if (!REQUESTS_RE.test(c.q)) return null;
    const reports = REPORTS_RE.test(c.q);
    const mine = c.reader.personId ? await c.docs(['request'], { manager: [c.reader.personId] }) : [];
    const pool = reports ? mine : await c.docs(['request']);
    // A person named in the question: a whole first or last name of someone the visible requests are for.
    const qwords = new Set(words(c.q.replace(/'s\b/g, '')));
    const people = new Map<string, SearchDoc[]>();
    for (const d of pool) {
      const who = str(d, 'beneficiary');
      if (who && words(who).some(w => w.length >= 3 && qwords.has(w))) people.set(who, [...(people.get(who) ?? []), d]);
    }
    if (people.size > 1) return null;
    const [name, docs] = people.size === 1 ? [...people.entries()][0]! : [null, reports ? pool : []];
    if (!name && !reports) return null;
    if (!name && reports && !c.reader.personId) return null;
    const sorted = [...docs].sort((a, b) => a.id.localeCompare(b.id));
    const subject = name ?? 'Your reports';
    const text = sorted.length
      ? `${subject} ${name ? 'has' : 'have'} ${plural(sorted.length, 'request')}: ${listing(sorted.slice(0, 8).map(line))}${sorted.length > 8 ? ` and ${sorted.length - 8} more` : ''}.`
      : `${subject} ${name ? 'has' : 'have'} no requests that you can open.`;
    return mk('report-requests', text, sorted.slice(0, 8), [name ? 'request rows you may open, by beneficiary' : 'request rows for your reports (manager)']);
  },
};

// ── my requests: pending, rejected, withdrawn, one by id or by what it asks for ──
const REQ_ID_RE = /\breq-\d+\b/g;
const FIRST_PERSON_RE = /\b(?:my|mine|me|i|i've|am i)\b/;
const WHO_RE = /\bwho\b/;
const OPEN_WORDS = /\b(?:pending|open|waiting|outstanding|in progress|unanswered|undecided)\b/;
const STATUS_WORDS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\b(?:withdrawn|withdrew|withdraw)\b/, 'withdrawn', 'withdrawn'],
  [/\b(?:rejected|denied|turned down|declined)\b/, 'rejected', 'rejected'],
  [/\bapproved\b/, 'approved', 'approved'],
];
/** Words that say which requests, not what they ask for. */
const REQUEST_CUES = ['access', 'request', 'requests', 'requested', 'pending', 'open', 'waiting', 'outstanding', 'rejected', 'denied', 'withdrawn', 'withdrew', 'withdraw', 'approved', 'status', 'closed', 'turned', 'down', 'am', 'still', 'been', 'got', 'get', 'any', 'all'];

const myRequests: AnswerIntent = {
  id: 'my-requests',
  async answer(c) {
    if (WHO_RE.test(c.q)) return null;
    const ids: string[] = c.q.match(REQ_ID_RE) ?? [];
    const asksOpen = OPEN_WORDS.test(c.q);
    const statusWord = STATUS_WORDS.find(([re]) => re.test(c.q));
    const mine = FIRST_PERSON_RE.test(c.q);
    const about = /\brequests?\b/.test(c.q) || (/\bwaiting on\b/.test(c.q) && mine);
    if (!ids.length && !about) return null;
    if (!ids.length && !mine && !statusWord && !asksOpen) return null;
    const own = mine || c.reader.principal.role === 'requester';
    const pool0 = await c.docs(['request'], own ? { party: [c.reader.userId] } : undefined);
    let pool = ids.length ? pool0.filter(d => ids.includes(d.id.toLowerCase())) : pool0;
    if (ids.length && !pool.length) return mk('my-requests', `No request ${listing(ids)} is one you can open.`, [], ['request rows you may open']);
    if (statusWord) pool = pool.filter(d => (d.facets['status'] ?? []).includes(statusWord[1]));
    else if (asksOpen) pool = pool.filter(d => (d.facets['open'] ?? []).includes('true'));
    // What the request asks for ("auth migration", "org leader"): every remaining word must be in one request's item.
    const terms = topicWords(c.q.replace(REQ_ID_RE, ' '), REQUEST_CUES);
    if (terms.length) {
      const kept = pool.filter(d => hasAll(str(d, 'item') || d.title, terms));
      if (!kept.length) return null;
      pool = kept;
    }
    const sorted = [...pool].sort((a, b) => a.id.localeCompare(b.id));
    const label = statusWord ? statusWord[2] : asksOpen ? 'open' : '';
    if (sorted.length === 1) {
      const d = sorted[0]!;
      // The row's own words: who it waits on while open, and the deciding step's comment once a step decided.
      const waiting = str(d, 'subtitle').split(' · ').find(bit => bit.startsWith('waiting on'));
      const decision = /^(?:Approved|Rejected) by /.test(str(d, 'description')) && str(d, 'status') !== 'withdrawn' ? str(d, 'description') : '';
      return mk('my-requests', `${str(d, 'item') || d.title} (${d.id}) is ${str(d, 'status') || 'open'}${waiting ? `, ${waiting}` : ''}${decision ? `. ${decision.replace(/[.\s]+$/, '')}` : ''}.`, sorted, ['request rows you may open (status, steps)']);
    }
    const noun = `${label ? `${label} ` : ''}request`;
    const text = sorted.length
      ? `${own ? 'You have' : 'There are'} ${plural(sorted.length, noun)}: ${listing(sorted.slice(0, 8).map(line))}${sorted.length > 8 ? ` and ${sorted.length - 8} more` : ''}.`
      : `${own ? 'You have' : 'There are'} no ${noun}s that you can open.`;
    return mk('my-requests', text, sorted.slice(0, 8), ['request rows you may open']);
  },
};

const policyOverrides: AnswerIntent = {
  id: 'policy-overrides',
  async answer(c) {
    if (!/\boverrid(?:e|es|den|ing)\b/.test(c.q)) return null;
    if (!/\b(?:audit|events?|polic(?:y|ies)|log|sod|separation)\b/.test(c.q)) return null;
    const hits = (await c.docs(['event'], { kind: ['sod-override'] })).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const text = hits.length
      ? `${plural(hits.length, 'policy override')} ${hits.length === 1 ? 'is' : 'are'} in the audit log: ${listing(hits.slice(0, 5).map(d => d.title))}${hits.length > 5 ? ` and ${hits.length - 5} more` : ''}.`
      : 'No policy override has been recorded in the audit log.';
    return mk('policy-overrides', text, hits.slice(0, 5), ['audit event rows (kind policy override)']);
  },
};

export const ACCESS_INTENTS: readonly AnswerIntent[] = [policyOverrides, sensitiveItems, reportRequests, myRequests];
