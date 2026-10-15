// Resolve a parsed question (./question.ts) against the index: the records that
// answer it, each with a score and a reason, plus a deterministic prose answer
// for the Answer tab. /api/search lifts these records to the top of its
// results; the Answer tab streams the prose with the records as citations.
// Every sentence is computed from the docs it cites — no model, no canned text.

import type { ParsedQuestion, QuestionIntent, QuestionVocab, Named } from './question.js';
import { docKey, type SearchDoc, type SearchIndex } from './types.js';
import { ORGIQ_DOC_TYPES } from './orgiq.js';

export const ANSWER_REASONS = {
  skill: 'Lists the skill',
  team: 'Team member',
  collaborator: 'Works with them',
  decider: 'Decided it',
  participant: 'Took part in the decision',
  decision: 'Decision the question names',
  initiative: 'Initiative the question names',
  status: 'Status matches the question',
  mine: 'Assigned to you',
  owner: 'Owns the initiative',
  sme: 'SME on the initiative',
  contributor: 'Contributes to the initiative',
  recent: 'Recently changed',
} as const;
export type AnswerReason = typeof ANSWER_REASONS[keyof typeof ANSWER_REASONS];

export interface Hit { doc: SearchDoc; score: number; reason: AnswerReason }
export interface Resolution {
  intent: QuestionIntent['kind'];
  hits: Hit[];
  /** The answer in prose; [n] cites hits[n-1]. Null when the intent resolved to nothing to say. */
  text: string | null;
}

export interface ResolveContext {
  index: SearchIndex;
  partition: string;
  allowedAcls: string[];
  /** The signed-in person (U6), resolved through lib/record-owner.ts — a clone is its persona. */
  personId: string | null;
  now?: Date;
}

const key = (d: SearchDoc) => docKey(d.type, d.id);
const listing = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** The vocabulary the parser needs, read from the partition. */
export async function vocabulary(ctx: ResolveContext): Promise<QuestionVocab> {
  const { docs } = await ctx.index.query({ tenant: ctx.partition, terms: [], types: ['person', 'team', 'initiative'], allowedAcls: ctx.allowedAcls });
  const named = (type: string): Named[] => docs.filter(d => d.type === type).map(d => ({ id: d.id, name: d.title }));
  return { skills: [...new Set(docs.flatMap(d => d.type === 'person' ? d.facets['skill'] ?? [] : []))], teams: named('team'), people: named('person'), initiatives: named('initiative') };
}

function ago(iso: string | null, now: Date): string {
  if (!iso) return 'no recorded time';
  const days = Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

class Cite {
  readonly hits: Hit[] = [];
  private readonly at = new Map<string, number>();
  add(doc: SearchDoc, score: number, reason: AnswerReason): string {
    const k = key(doc);
    let n = this.at.get(k);
    if (n == null) { this.hits.push({ doc, score, reason }); n = this.hits.length; this.at.set(k, n); }
    return `**${doc.title}** [${n}]`;
  }
}

export async function resolveIntent(intent: QuestionIntent, parsed: ParsedQuestion, ctx: ResolveContext): Promise<Resolution> {
  const { index, partition: tenant, allowedAcls } = ctx;
  const now = ctx.now ?? new Date();
  const cite = new Cite();
  const done = (text: string | null): Resolution => ({ intent: intent.kind, hits: cite.hits, text });

  switch (intent.kind) {
    case 'experts': {
      const { docs } = await index.query({ tenant, terms: [], types: ['person'], facets: { skill: intent.skills }, allowedAcls });
      const rank = (d: SearchDoc) => Math.min(...intent.skills.map(s => { const i = (d.facets['skill'] ?? []).findIndex(x => x.toLowerCase() === s.toLowerCase()); return i < 0 ? 99 : i; }));
      const people = docs.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
      const names = people.slice(0, 8).map((d, i) => cite.add(d, 40 - i * 0.1, ANSWER_REASONS.skill) + (d.record['subtitle'] ? ` (${d.record['subtitle']})` : ''));
      const skill = listing(intent.skills);
      if (!people.length) return done(`No one in the people graph lists ${skill} as a skill.`);
      return done(`${people.length} ${people.length === 1 ? 'person lists' : 'people list'} ${skill} as a skill, ordered by where the skill sits in each profile:\n\n${names.map(n => `- ${n}`).join('\n')}${people.length > 8 ? `\n\n…and ${people.length - 8} more in the People results.` : ''}`);
    }
    case 'team': {
      const teams = await index.get(tenant, intent.teams.map(t => docKey('team', t.id)));
      const visible = teams.filter(t => t.acl == null || allowedAcls.includes(t.acl));
      if (!visible.length) return done(null);
      const parts: string[] = [];
      for (const team of visible) {
        const members = (await index.neighbours(tenant, [key(team)], ['member'])).map(n => n.doc).filter(d => d.acl == null || allowedAcls.includes(d.acl)).sort((a, b) => a.title.localeCompare(b.title));
        const names = members.slice(0, 12).map((m, i) => cite.add(m, 40 - i * 0.05, ANSWER_REASONS.team));
        // Named, not cited: the portal's citation types have no team record yet (docs/ui-components-queue.md).
        cite.add(team, 39, ANSWER_REASONS.team);
        const t = `**${team.title}**`;
        parts.push(`${t} has ${members.length} ${members.length === 1 ? 'member' : 'members'}: ${listing(names)}${members.length > 12 ? `, and ${members.length - 12} more` : ''}.`);
      }
      return done(parts.join('\n\n'));
    }
    case 'collaborators': {
      const parts: string[] = [];
      const people = (await index.get(tenant, intent.people.map(p => docKey('person', p.id)))).filter(d => d.acl == null || allowedAcls.includes(d.acl));
      const all = await index.neighbours(tenant, people.map(key), ['collaborates']);
      const ranked: Array<{ person: SearchDoc; other: SearchDoc; weight: number }> = all.map(n => ({ person: people.find(p => key(p) === n.from)!, other: n.doc, weight: n.edge.weight ?? 0 }))
        .filter(r => r.person && (r.other.acl == null || allowedAcls.includes(r.other.acl)))
        .sort((a, b) => b.weight - a.weight || a.other.title.localeCompare(b.other.title));
      if (people.length > 1) parts.push(`${people.length} people match: ${listing(people.map(p => p.title))}.`);
      for (const p of people) {
        const mine = ranked.filter(r => r.person === p).slice(0, 6);
        if (!mine.length) { parts.push(`The people graph records no collaborators for **${p.title}**.`); continue; }
        parts.push(`**${p.title}** works most closely with ${listing(mine.map(r => `${cite.add(r.other, 30 + r.weight * 10, ANSWER_REASONS.collaborator)} (${r.weight.toFixed(2)})`))}.`);
      }
      if (!people.length) return done(null);
      return done(`${parts.join('\n\n')}\n\nThe number is the collaboration strength recorded in the people graph.`);
    }
    case 'decider': {
      const { docs } = await index.query({ tenant, terms: intent.terms, types: ['decision'], allowedAcls });
      const score = (d: SearchDoc) => intent.terms.filter(t => `${d.title} ${d.text}`.toLowerCase().includes(t)).length * 2 + intent.terms.filter(t => d.title.toLowerCase().includes(t)).length;
      const matched = docs.map(d => ({ d, s: score(d) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.d.title.localeCompare(b.d.title));
      if (!matched.length) return done(null);
      const best = matched[0]!.s;
      const decisions = matched.filter(x => x.s >= best - 1).slice(0, 3).map(x => x.d);
      const parts: string[] = [];
      for (const d of decisions) {
        const ref = cite.add(d, 40, ANSWER_REASONS.decision);
        const participants = (await index.neighbours(tenant, [key(d)])).filter(n => n.doc.type === 'person' && (n.doc.acl == null || allowedAcls.includes(n.doc.acl)));
        const deciders = participants.filter(n => n.edge.label === 'decider').map(n => cite.add(n.doc, 39, ANSWER_REASONS.decider));
        const others = participants.filter(n => n.edge.label !== 'decider').map(n => cite.add(n.doc, 25, ANSWER_REASONS.participant));
        parts.push(`${ref} (${String(d.record['status'] ?? 'no status')}): ${deciders.length ? `decided by ${listing(deciders)}` : 'no decider is recorded'}${others.length ? `; with ${listing(others)}` : ''}.`);
      }
      return done(parts.join('\n\n'));
    }
    case 'decisions': {
      const { docs } = await index.query({ tenant, terms: [], types: ['decision'], facets: { status: intent.statuses }, allowedAcls });
      const order = (d: SearchDoc) => intent.statuses.indexOf(String(d.record['status'] ?? ''));
      const sorted = docs.sort((a, b) => order(b) - order(a) || a.title.localeCompare(b.title));
      if (!sorted.length) return done(`No decision is ${listing(intent.statuses)} right now.`);
      const lines = sorted.map((d, i) => `- ${cite.add(d, 40 - i * 0.1, ANSWER_REASONS.status)} — ${String(d.record['status'])}${d.record['subtitle'] ? ` (${String(d.record['subtitle'])})` : ''}`);
      return done(`${sorted.length} ${sorted.length === 1 ? 'decision is' : 'decisions are'} ${listing(intent.statuses)}:\n\n${lines.join('\n')}`);
    }
    case 'my-work': {
      if (!ctx.personId) return done('Your account is not linked to a person in the org graph, so there is no work assigned to you to show.');
      const { docs } = await index.query({ tenant, terms: [], types: ['work'], facets: { assignee: [ctx.personId], open: ['true'] }, allowedAcls });
      const sorted = docs.sort((a, b) => (Number(b.record['status'] === 'blocked') - Number(a.record['status'] === 'blocked')) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.title.localeCompare(b.title));
      if (!sorted.length) return done('Nothing open is assigned to you.');
      const lines = sorted.slice(0, 10).map((d, i) => `- ${cite.add(d, 40 - i * 0.1, ANSWER_REASONS.mine)} — ${String(d.record['status'] ?? '').replace(/_/g, ' ')}${d.record['subtitle'] ? ` · ${String(d.record['subtitle'])}` : ''}`);
      return done(`${sorted.length} open ${sorted.length === 1 ? 'item is' : 'items are'} assigned to you:\n\n${lines.join('\n')}${sorted.length > 10 ? `\n\n…and ${sorted.length - 10} more.` : ''}`);
    }
    case 'initiative-people': {
      const parts: string[] = [];
      for (const i of intent.initiatives) {
        const [root] = await index.get(tenant, [docKey('initiative', i.id)]);
        if (!root) continue;
        const ns = (await index.neighbours(tenant, [key(root)], ['owns', 'SME', 'contributes to'])).filter(n => n.doc.acl == null || allowedAcls.includes(n.doc.acl));
        const by = (label: string) => [...new Map(ns.filter(n => n.edge.label === label).map(n => [key(n.doc), n.doc])).values()].sort((a, b) => a.title.localeCompare(b.title));
        const named = new Set([...by('owns'), ...by('SME')].map(key));
        const name = cite.add(root, 35, ANSWER_REASONS.initiative);
        const owners = by('owns').map(d => cite.add(d, 42, ANSWER_REASONS.owner));
        const smes = by('SME').filter(d => !by('owns').some(o => key(o) === key(d))).map(d => cite.add(d, 41, ANSWER_REASONS.sme));
        const contributors = by('contributes to').filter(d => !named.has(key(d))).slice(0, 8).map(d => cite.add(d, 30, ANSWER_REASONS.contributor));
        parts.push(`${name}: ${owners.length ? `owned by ${listing(owners)}` : 'no owner is recorded'}${smes.length ? `; SMEs ${listing(smes)}` : '; no SME is recorded'}${contributors.length ? `; also contributing: ${listing(contributors)}` : ''}.`);
      }
      return done(parts.length ? parts.join('\n\n') : null);
    }
    case 'recent': {
      const parts: string[] = [];
      for (const i of intent.initiatives) {
        const [root] = await index.get(tenant, [docKey('initiative', i.id)]);
        if (!root) continue;
        const name = cite.add(root, 36, ANSWER_REASONS.recent);
        const changed = (await index.neighbours(tenant, [key(root)])).map(n => n.doc)
          .filter(d => d.type !== 'person' && d.updatedAt && (d.acl == null || allowedAcls.includes(d.acl)));
        const latest = [...new Map(changed.map(d => [key(d), d])).values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 6);
        if (!latest.length) { parts.push(`${name}: nothing linked to it records a change time.`); continue; }
        parts.push(`The most recent recorded changes on ${name}${root.updatedAt ? ` (last activity ${ago(root.updatedAt, now)})` : ''}:\n\n${latest.map((d, n) => `- ${cite.add(d, 30 - n * 0.1, ANSWER_REASONS.recent)} — ${d.type}${d.record['status'] ? `, ${String(d.record['status']).replace(/_/g, ' ')}` : ''}, updated ${ago(d.updatedAt, now)}`).join('\n')}`);
      }
      return done(parts.length ? `${parts.join('\n\n')}\n\nThis lists records whose own update time is recorded; it is not a full change history.` : null);
    }
  }
}

/** Every intent the question asks, resolved in priority order (the first one with something to say leads). */
export async function resolveQuestion(parsed: ParsedQuestion, ctx: ResolveContext): Promise<Resolution[]> {
  const out: Resolution[] = [];
  for (const intent of parsed.intents) out.push(await resolveIntent(intent, parsed, ctx));
  return out;
}

export const INDEXED_TYPES = ORGIQ_DOC_TYPES;
