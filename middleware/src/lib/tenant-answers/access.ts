// Access answers (docs/user-search-goal.md S4): which catalog items are
// sensitive, a person's (or my reports') requests, and the policy overrides in
// the audit trail — each computed from the reader's own projection, so a
// request a reader may not open is never counted.

import type { SearchDoc } from '../search-index/types.js';
import { words } from '../search-index/tokens.js';
import type { AnswerIntent, TenantAnswer } from './types.js';
import { listing, plural, str, toRecords } from './util.js';

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

export const ACCESS_INTENTS: readonly AnswerIntent[] = [policyOverrides, sensitiveItems, reportRequests];
