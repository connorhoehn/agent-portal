// Index answers for the Answer tab (docs/user-search-goal.md U10, S1): the
// people and decision questions the local data assistant (lib/local-answers)
// does not cover — experts by skill, team members, collaborators, who decided,
// open decisions, my open work, an initiative's people, what changed on an
// initiative — answered from the search projection with the records cited.
// Deterministic, no model; a question none of these fit returns null and the
// request goes on to the agent path unchanged.
//
// Same stream shape as a local answer (routes/agents.ts streamLocalAnswer).

import { isAllowed, type PrincipalRef } from '../authz.js';
import { mineViewer } from '../mine.js';
import type { Session } from '../session.js';
import { ensureIndexed } from './registry.js';
import { PEOPLE_ACL } from './orgiq.js';
import { parseQuestion } from './question.js';
import { resolveIntent, vocabulary, type ResolveContext } from './resolve.js';

/** Which intents need no question-shaped pre-check: everything else must look like one of these. */
const SHAPE_RE = /\bwho\b|\bwhose\b|\bexperts?\b|\bpeople\b|\bpersons?\b|\bsomeone\b|\bskills?\b|\bteams?\b|\bmembers?\b|\bcollaborat|\bworked with\b|\bworks? (?:closely )?with\b|\bdecisions?\b|\bdecider\b|\bdecided\b|\badrs?\b|\bmy\b|\bme\b|\bI\b|\bchanged\b|\brecent|\bactivity\b|\bupdates?\b|\bsmes?\b|\bowners?\b/i;

export interface IndexAnswer {
  intent: string;
  text: string;
  records: Array<{ type: string; id: string; title: string; href: string; n: number; status?: string; subtitle?: string; description?: string }>;
  edges: Array<{ id: string; source: string; target: string; label: string }>;
  rows: Array<Record<string, unknown>>;
  sources: string[];
}

/** Cheap, pure: could this question be an index answer at all? */
export function mayAnswerFromIndex(question: string): boolean {
  const q = question.trim();
  return q.length > 0 && q.length <= 500 && SHAPE_RE.test(q);
}

export async function answerFromIndex(input: { question: string; session: PrincipalRef }): Promise<IndexAnswer | null> {
  if (!mayAnswerFromIndex(input.question)) return null;
  const { index, partition } = await ensureIndexed('orgiq');
  const allowedAcls = (await isAllowed(input.session, 'ViewOrgChart')) ? [PEOPLE_ACL] : [];
  const ctx: ResolveContext = { index, partition, allowedAcls, personId: null };
  const parsed = parseQuestion(input.question, await vocabulary(ctx));
  if (!parsed.intents.length) return null;
  if (parsed.intents.some(i => i.kind === 'my-work')) {
    try { ctx.personId = (await mineViewer(input.session as Session)).personId; } catch { ctx.personId = null; }
  }
  for (const intent of parsed.intents) {
    const r = await resolveIntent(intent, parsed, ctx);
    if (!r.text) continue;
    // Citations keep their [n] (the hit's position); a team is named in prose but not cited (no portal citation type yet).
    const records = r.hits.map((h, i) => ({ h, n: i + 1 })).filter(({ h }) => h.doc.type !== 'team').map(({ h, n }) => {
      const rec = h.doc.record;
      const str = (k: string) => (typeof rec[k] === 'string' && rec[k] ? { [k]: rec[k] as string } : {});
      return { type: h.doc.type, id: h.doc.id, title: h.doc.title, href: String(rec['href'] ?? ''), n, ...str('status'), ...str('subtitle'), ...str('description') };
    });
    const keys = new Set(records.map(x => `${x.type}:${x.id}`));
    const edges = [...new Map(r.hits.flatMap(h => h.doc.edges).filter(e => keys.has(e.source) && keys.has(e.target)).map(e => [e.id, { id: e.id, source: e.source, target: e.target, label: e.label }])).values()];
    return {
      intent: `index:${r.intent}`, text: r.text, records, edges,
      rows: r.hits.map(h => ({ key: `${h.doc.type}:${h.doc.id}`, title: h.doc.title, reason: h.reason })),
      sources: [`search index (${r.intent})`],
    };
  }
  return null;
}
