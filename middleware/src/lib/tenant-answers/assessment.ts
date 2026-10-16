// Assessment answers (docs/user-search-goal.md S4): aggregate and edge
// questions the team, feedback, submission and workspace-document rows answer
// as one fixed fact — teams without a lead, who approved an exception, which
// exceptions wait, which answered question says X, what is staged, which
// standard a document is. Every count and name is computed from the projection
// at request time; nothing here knows a fixture's title.

import type { SearchDoc } from '../search-index/types.js';
import { words } from '../search-index/tokens.js';
import type { AnswerContext, AnswerIntent, TenantAnswer } from './types.js';
import { hasAll, listing, named, plural, str, toRecords, topicWords } from './util.js';

const EXCEPTION_RE = /\b(?:exceptions?|n\/a|not applicable)\b/;
const mk = (intent: string, text: string, docs: SearchDoc[], sources: string[], rows: Array<Record<string, unknown>> = []): TenantAnswer =>
  ({ intent: `assessment:${intent}`, text, records: toRecords(docs), rows: rows.length ? rows : docs.map(d => ({ key: `${d.type}:${d.id}`, title: d.title })), sources });

// ── teams without a lead ─────────────────────────────────────────────────────
const UNASSIGNED_RE = /\bunassigned\b|\b(?:no|without|missing|lacking|lacks?)\s+(?:an?\s+|any\s+)?(?:assessment\s+)?leads?\b|\b(?:have|has)\s+no\s+(?:assessment\s+)?leads?\b/;
const teamsWithoutLead: AnswerIntent = {
  id: 'unassigned-teams',
  async answer(c) {
    if (!UNASSIGNED_RE.test(c.q) || !/\bteams?\b/.test(c.q)) return null;
    const teams = await c.docs(['team']);
    if (!teams.length) return null;
    const bare = teams.filter(t => (t.facets['lead'] ?? []).includes('unassigned')).sort((a, b) => a.title.localeCompare(b.title));
    const text = bare.length
      ? `${plural(bare.length, 'team')} of ${teams.length} ${bare.length === 1 ? 'has' : 'have'} no assessment lead: ${listing(bare.map(t => t.title))}.`
      : `Every team has an assessment lead: none of the ${teams.length} teams is unassigned.`;
    return mk('unassigned-teams', text, bare, [`team rows (${teams.length}), lead column`]);
  },
};

// ── who approved an exception / which exceptions wait ────────────────────────
const WHO_APPROVED_RE = /\bwho\b.*\b(?:approved|approve|signed off|decided|granted)\b|\bapprover\b|\bapproved by\b/;
const OPEN_RE = /\b(?:open|pending|awaiting|outstanding|unapproved|undecided|waiting|need(?:s)?\s+(?:an?\s+)?approval|need(?:s)?\s+to be approved)\b/;

const dimension = (x: SearchDoc) => str(x, 'dimension') || `dimension ${str(x, 'dimensionId')}`;
const labelOf = (x: SearchDoc) => `${str(x, 'teamName') || x.title} on ${dimension(x)}`;

async function exceptionsNamed(c: AnswerContext, all: SearchDoc[]): Promise<SearchDoc[]> {
  const teams = named(c.q, await c.docs(['team']), /team-\d+/g);
  let out = teams.length === 1 ? all.filter(x => str(x, 'teamId') === teams[0]!.id) : all;
  const dim = /\bdimension\s+(\d+)\b/.exec(c.q)?.[1];
  if (dim) out = out.filter(x => str(x, 'dimensionId') === dim);
  else {
    const qwords = new Set(words(c.q));
    const scored = out.map(x => ({ x, hits: words(dimension(x)).filter(w => w.length >= 4 && qwords.has(w)).length })).filter(s => s.hits > 0);
    if (scored.length) { const top = Math.max(...scored.map(s => s.hits)); out = scored.filter(s => s.hits === top).map(s => s.x); }
  }
  return out;
}

const whoApproved: AnswerIntent = {
  id: 'who-approved-exception',
  async answer(c) {
    if (!WHO_APPROVED_RE.test(c.q) || !EXCEPTION_RE.test(c.q)) return null;
    const all = await c.docs(['exception']);
    const picked = await exceptionsNamed(c, all);
    if (!picked.length) return all.length ? null : mk('who-approved-exception', 'No N/A exception is on record.', [], ['exception rows']);
    const lines = picked.sort((a, b) => a.id.localeCompare(b.id)).map(x => {
      const by = str(x, 'approvedBy');
      return (x.facets['state'] ?? []).includes('closed') && by
        ? `${by} ${str(x, 'status') === 'rejected' ? 'rejected' : 'approved'} the N/A exception for ${labelOf(x)}.`
        : `The N/A exception for ${labelOf(x)} has not been decided yet.`;
    });
    return mk('who-approved-exception', lines.slice(0, 4).join(' '), picked.slice(0, 4), ['exception rows (approver column)']);
  },
};

const openExceptions: AnswerIntent = {
  id: 'open-exceptions',
  async answer(c) {
    if (!EXCEPTION_RE.test(c.q) || !OPEN_RE.test(c.q) || WHO_APPROVED_RE.test(c.q)) return null;
    const open = (await c.docs(['exception'], { state: ['open'] })).sort((a, b) => a.id.localeCompare(b.id));
    const text = open.length
      ? `${plural(open.length, 'N/A exception')} ${open.length === 1 ? 'is' : 'are'} waiting for approval: ${listing(open.slice(0, 6).map(labelOf))}${open.length > 6 ? ` and ${open.length - 6} more` : ''}.`
      : 'No N/A exception is waiting for approval.';
    return mk('open-exceptions', text, open.slice(0, 6), ['exception rows (state open)']);
  },
};

// ── submissions staged and not committed ─────────────────────────────────────
const STAGED_RE = /\bstaged\b|\b(?:not\s+(?:yet\s+)?committed|uncommitted|awaiting\s+commit|pending\s+commit)\b/;
const stagedSubmissions: AnswerIntent = {
  id: 'staged-submissions',
  async answer(c) {
    if (!STAGED_RE.test(c.q) || !/\bsubmissions?\b/.test(c.q)) return null;
    const staged = (await c.docs(['submission'], { status: ['staged'] })).sort((a, b) => a.id.localeCompare(b.id));
    const text = staged.length
      ? `${plural(staged.length, 'submission')} ${staged.length === 1 ? 'is' : 'are'} staged and not yet committed: ${listing(staged.slice(0, 6).map(s => `${str(s, 'submitter') || 'an unnamed submitter'}'s for ${str(s, 'teamName') || str(s, 'teamId')}`))}.`
      : 'No submission is staged: every submission has been committed.';
    return mk('staged-submissions', text, staged.slice(0, 6), ['submission rows (status staged)']);
  },
};

// ── an answered question, by what the answer said ────────────────────────────
const ANSWER_CUES = ['answered', 'confirm', 'confirmed', 'confirms', 'replied', 'responded', 'said', 'told', 'response'];
const answeredQuestion: AnswerIntent = {
  id: 'answered-question',
  async answer(c) {
    const terms = topicWords(c.q, ANSWER_CUES);
    if (!terms.length || !terms.some(t => t.length >= 4)) return null;
    const closed = await c.docs(['feedback'], { state: ['closed'] });
    const hits = closed.filter(f => str(f, 'response') && hasAll(`${str(f, 'question')} ${str(f, 'response')} ${str(f, 'teamName')} ${f.title}`, terms))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!hits.length) return null;
    const lines = hits.slice(0, 3).map(f => `${str(f, 'teamName') || str(f, 'teamId') || 'The program'}${str(f, 'dimension') ? ` on ${str(f, 'dimension')}` : ''}: “${str(f, 'response')}”`);
    return mk('answered-question', `${hits.length === 1 ? 'One answered question matches' : `${hits.length} answered questions match`}. ${lines.join(' ')}`, hits.slice(0, 3), ['feedback rows (answered, response text)']);
  },
};

// ── a standards document, by its name ────────────────────────────────────────
/** The document's opening words without its own title (the projection's description starts with the heading). */
function excerpt(d: SearchDoc): string {
  let text = str(d, 'description');
  if (text.toLowerCase().startsWith(d.title.toLowerCase())) text = text.slice(d.title.length).trim();
  if (text.length <= 140) return text;
  const cut = text.slice(0, 140);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 100)).trim()}…`;
}

const standardDoc: AnswerIntent = {
  id: 'standard-doc',
  async answer(c) {
    // A document's own name carries "policy", "standards", "exception": those stay terms here.
    const terms = topicWords(c.q, ['document', 'documents', 'doc', 'docs'], ['exception', 'exceptions', 'policy', 'policies', 'standard', 'standards']);
    if (!terms.length) return null;
    const docs = await c.docs(['document']);
    const hits = docs.filter(d => hasAll(d.title, terms)).sort((a, b) => a.title.localeCompare(b.title));
    if (!hits.length) return null;
    const lines = hits.slice(0, 3).map(d => `“${d.title}” (${str(d, 'subtitle').replace(/^Workspace · /, '') || 'workspace'})${excerpt(d) ? `: ${excerpt(d)}` : ''}`);
    return mk('standard-doc', `${hits.length === 1 ? 'The workspace holds' : `${hits.length} workspace documents match:`} ${lines.join(' ')}`, hits.slice(0, 3), ['workspace document rows (title)']);
  },
};

/** In priority order: the cue-bearing questions first, the bare document and answer lookups last. */
export const ASSESSMENT_INTENTS: readonly AnswerIntent[] = [teamsWithoutLead, whoApproved, openExceptions, stagedSubmissions, standardDoc, answeredQuestion];
