// Assessment evidence summary and follow-up drafts (docs/agentic-flows-migration.md
// slice 8). One dimension of one team, two draft kinds:
//   - assessment.evidence-summary: what the dimension's evidence shows, with
//     verbatim source spans;
//   - assessment.followup-drafts: questions that would close an open claim or
//     reach the next level, grounded in the rubric's next-level criteria and
//     the evidence.
// Both run on the durable flow-run store (lib/flow-runs) as the requester's
// PRIVATE drafts; nothing is written to the team until the assessor accepts a
// follow-up draft (routes/assessment-drafts.ts -> provider.addFollowUps).
//
// The model writes prose only. Levels, targets, counts and criteria are read
// from the provider by `buildSource`, are carried in `facts`, and any number the
// model states that is not in facts/criteria/evidence voids its piece. The same
// checks run in the agent (agents/assessment-drafter/evidence_commands.py) and
// again here, so an unreachable or misbehaving agent degrades to a deterministic
// draft (`fallback: true`) rather than failing or inventing.

import { config } from '../config.js';
import { agentcore } from '../providers/index.js';
import { getTeamDetail, normalizeQuestion, type DimensionOut } from '../providers/assessment.js';
import { flowRunStore, kickFlowRun, registerFlowExecutor, type FlowExecutionContext, type FlowRunRow, type FlowRunStep } from './flow-runs/index.js';

export const DRAFT_AGENT_ID = 'orgiq-assessment-drafter';
export const DRAFT_TENANT = 'assessment';
export const SUMMARY_KIND = 'assessment.evidence-summary';
export const FOLLOWUPS_KIND = 'assessment.followup-drafts';
export const DRAFT_KINDS = [SUMMARY_KIND, FOLLOWUPS_KIND] as const;
export type DraftKind = typeof DRAFT_KINDS[number];
export const MODE_BY_KIND: Record<DraftKind, string> = { [SUMMARY_KIND]: 'summarize-evidence', [FOLLOWUPS_KIND]: 'draft-followups' };
export const MAX_ACTIVE_DRAFTS_PER_USER = 4;
export const DRAFT_TTL_MS = 24 * 3_600_000;
const MAX_EVIDENCE = 30;
const MAX_EXCERPT = 1000;
const MAX_SUMMARY = 800;
const MAX_BULLETS = 6;
const MAX_BULLET = 300;
const MAX_QUESTIONS = 5;
const MAX_QUESTION = 300;
const MAX_SPANS = 4;

export interface EvidenceSpan { evidenceId: string; text: string }
export interface DraftFacts {
  verifiedLevel: number | null; claimedLevel: number | null; targetLevel: number; openClaim: boolean; evidenceCount: number;
}
export interface DraftSource {
  id: string; title: string; facts: DraftFacts;
  criteria: Array<{ id: string; text: string }>;
  evidence: Array<{ id: string; excerpt: string; supports_level: number | null }>;
  existing_questions: string[];
}
export interface SummaryBullet { text: string; sourceSpans: EvidenceSpan[] }
export interface SummaryDraft { kind: 'summary'; teamId: string; dimensionId: string; dimensionTitle: string; facts: DraftFacts; summary: string; bullets: SummaryBullet[]; fallback: boolean; revisionNote?: string }
export interface QuestionDraft { text: string; criterionId: string | null; criterionText: string | null; sourceSpans: EvidenceSpan[] }
export interface FollowupsDraft { kind: 'followups'; teamId: string; dimensionId: string; dimensionTitle: string; facts: DraftFacts; summary: string; questions: QuestionDraft[]; fallback: boolean; revisionNote?: string }
export type DraftResult = SummaryDraft | FollowupsDraft;

/** Everything the model may say about a dimension, from the provider and nowhere else. */
export function sourceFromDimension(d: DimensionOut): DraftSource {
  const cert = d.certification;
  const claimed = cert?.claimed_level ?? null;
  const verified = cert?.verified_level ?? null;
  const openClaim = !!cert && (cert.status === 'claim_open' || (typeof cert.verification_gap === 'number' ? cert.verification_gap > 0
    : claimed !== null && (verified === null || claimed > verified)));
  const evidence = d.evidence.filter(e => e.excerpt.trim()).slice(0, MAX_EVIDENCE)
    .map(e => ({ id: e.evidence_id, excerpt: e.excerpt.slice(0, MAX_EXCERPT), supports_level: e.supports_level }));
  return {
    id: d.id, title: d.title,
    facts: { verifiedLevel: verified, claimedLevel: claimed, targetLevel: cert?.target_level ?? 0, openClaim, evidenceCount: d.evidence.length },
    criteria: d.next_level_criteria.filter(c => c.trim()).map((text, i) => ({ id: `c${i + 1}`, text })),
    evidence,
    existing_questions: d.follow_up_questions.filter(q => q.status === 'OPEN').map(q => q.text),
  };
}

export async function buildSource(teamId: string, dimensionId: string): Promise<DraftSource | null> {
  const detail = await getTeamDetail(teamId);
  const d = detail?.dimensions.find(x => x.id === dimensionId);
  return d ? sourceFromDimension(d) : null;
}

// ─── Validation (mirrors evidence_commands.py) ───────────────────────────────

const NUM = /\d+(?:\.\d+)?/g;
const allowedText = (s: DraftSource): string =>
  [JSON.stringify(s.facts), s.title, ...s.evidence.map(e => e.excerpt), ...s.criteria.map(c => c.text)].join(' ');
const grounded = (text: string, allowed: string): boolean => (text.match(NUM) ?? []).every(n => allowed.includes(n));
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

function cleanSpans(raw: unknown, source: DraftSource): EvidenceSpan[] {
  const byId = new Map(source.evidence.map(e => [e.id, e.excerpt]));
  const out: EvidenceSpan[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const s = obj(item);
    const text = s?.['text']; const id = s?.['evidenceId'];
    if (typeof text === 'string' && typeof id === 'string' && text.trim() && !text.includes('\n') && byId.get(id)?.includes(text)) out.push({ evidenceId: id, text });
  }
  return out.slice(0, MAX_SPANS);
}

const firstLine = (s: string): string => s.trim().split('\n')[0]!.trim().slice(0, 200);

export function fallbackBullets(source: DraftSource): SummaryBullet[] {
  return source.evidence.map(e => ({ q: firstLine(e.excerpt), id: e.id })).filter(x => x.q).slice(0, MAX_BULLETS)
    .map(x => ({ text: `Evidence: "${x.q}"`, sourceSpans: [{ evidenceId: x.id, text: x.q }] }));
}

export function fallbackQuestions(source: DraftSource): QuestionDraft[] {
  const existing = new Set(source.existing_questions.map(normalizeQuestion));
  const out: QuestionDraft[] = [];
  for (const c of source.criteria) {
    const text = `What evidence shows that the team meets: ${c.text.trim().replace(/\.+$/, '')}?`;
    if (existing.has(normalizeQuestion(text)) || text.length > MAX_QUESTION) continue;
    out.push({ text, criterionId: c.id, criterionText: c.text, sourceSpans: [] });
    if (out.length === 3) break;
  }
  return out;
}

const cleanSummary = (raw: unknown, allowed: string, fallback: string): string =>
  typeof raw === 'string' && raw.trim() && raw.length <= MAX_SUMMARY && grounded(raw, allowed) ? raw.trim() : fallback;

export function acceptSummary(raw: unknown, source: DraftSource): { summary: string; bullets: SummaryBullet[]; fallback: boolean; revisionNote?: string } {
  const v = obj(raw) ?? {};
  const allowed = allowedText(source);
  const bullets: SummaryBullet[] = [];
  for (const item of Array.isArray(v['bullets']) ? v['bullets'] : []) {
    const b = obj(item); const text = typeof b?.['text'] === 'string' ? (b['text'] as string).trim() : '';
    const spans = cleanSpans(b?.['source_spans'], source);
    if (text && text.length <= MAX_BULLET && spans.length > 0 && grounded(text, allowed)) bullets.push({ text, sourceSpans: spans });
  }
  const fallback = bullets.length === 0;
  const kept = fallback ? fallbackBullets(source) : bullets.slice(0, MAX_BULLETS);
  const dflt = kept.length ? 'Summary drawn from the supplied evidence.' : 'There is no evidence on this dimension yet.';
  return { summary: fallback ? dflt : cleanSummary(v['summary'], allowed, dflt), bullets: kept, fallback };
}

export function acceptFollowups(raw: unknown, source: DraftSource): { summary: string; questions: QuestionDraft[]; fallback: boolean } {
  const v = obj(raw) ?? {};
  const allowed = allowedText(source);
  const criteria = new Map(source.criteria.map(c => [c.id, c.text]));
  const seen = new Set(source.existing_questions.map(normalizeQuestion));
  const questions: QuestionDraft[] = [];
  for (const item of Array.isArray(v['questions']) ? v['questions'] : []) {
    const q = obj(item); const text = typeof q?.['text'] === 'string' ? (q['text'] as string).trim() : '';
    const cid = typeof q?.['criterionId'] === 'string' && criteria.has(q['criterionId'] as string) ? q['criterionId'] as string : null;
    const spans = cleanSpans(q?.['source_spans'], source);
    const key = normalizeQuestion(text);
    if (!text.endsWith('?') || text.length > MAX_QUESTION || !key || seen.has(key) || !(cid || spans.length) || !grounded(text, allowed)) continue;
    seen.add(key);
    questions.push({ text, criterionId: cid, criterionText: cid ? criteria.get(cid)! : null, sourceSpans: spans });
    if (questions.length === MAX_QUESTIONS) break;
  }
  const fallback = questions.length === 0;
  const kept = fallback ? fallbackQuestions(source) : questions;
  const dflt = kept.length ? "Follow-up questions drafted from the next level's criteria." : 'No new follow-up questions are needed.';
  return { summary: fallback ? dflt : cleanSummary(v['summary'], allowed, dflt), questions: kept, fallback };
}

/** The offline narrative: valid by construction, and still passed through the validators. */
export function mockEnvelope(kind: DraftKind, source: DraftSource, instruction = ''): unknown {
  const f = source.facts;
  const base = f.verifiedLevel === null ? 'No level is verified yet.' : `Verified level ${f.verifiedLevel} of target ${f.targetLevel}.`;
  const position = instruction ? `${base} Revised: ${instruction.slice(0, 120)}` : base;
  if (kind === SUMMARY_KIND) {
    return {
      summary: position,
      bullets: fallbackBullets(source).map(b => ({ text: b.text, source_spans: b.sourceSpans })),
    };
  }
  return {
    summary: position,
    questions: fallbackQuestions(source).map(q => ({ text: q.text, criterionId: q.criterionId, source_spans: [] })),
  };
}

// ─── Durable run ─────────────────────────────────────────────────────────────

const STEPS: FlowRunStep[] = [
  { id: 'read-evidence', label: 'Read the dimension and its evidence', status: 'completed' },
  { id: 'draft', label: 'Write the draft (Nova)', status: 'pending' },
  { id: 'check', label: 'Check every quote and number', status: 'pending' },
];
const withStatus = (steps: readonly FlowRunStep[], id: string, status: FlowRunStep['status']): FlowRunStep[] =>
  steps.map(s => (s.id === id ? { ...s, status } : s));

export const scopeFor = (teamId: string, dimensionId: string): string => `${teamId}/${dimensionId}`;
export const parseScope = (scope: string): { teamId: string; dimensionId: string } => {
  const [teamId = '', dimensionId = ''] = scope.split('/');
  return { teamId, dimensionId };
};

export const activeDraftCount = async (userId: string): Promise<number> =>
  (await flowRunStore.countActive(DRAFT_TENANT, SUMMARY_KIND, userId)) + (await flowRunStore.countActive(DRAFT_TENANT, FOLLOWUPS_KIND, userId));

export async function startDraft(input: { kind: DraftKind; userId: string; teamId: string; dimensionId: string; source: DraftSource }): Promise<FlowRunRow> {
  await Promise.all(DRAFT_KINDS.map(k => flowRunStore.prune(k, DRAFT_TTL_MS)));
  const run = await flowRunStore.create({
    tenant: DRAFT_TENANT, kind: input.kind, requestedBy: input.userId, scope: scopeFor(input.teamId, input.dimensionId),
    idPrefix: 'adr', maxAttempts: 2, progress: STEPS, input: { source: input.source, title: input.source.title },
  });
  kickFlowRun(run.id, input.kind);
  return run;
}

export async function draftExecutor(ctx: FlowExecutionContext): Promise<{ result: DraftResult; progress: FlowRunStep[] }> {
  const { run } = ctx;
  const kind = run.kind as DraftKind;
  const source = run.input?.['source'] as DraftSource | undefined;
  if (!source) throw new Error('The draft has no stored source.');
  const { teamId, dimensionId } = parseScope(run.scope);
  const revision = obj(run.input?.['revision']);
  const prior = revision?.['prior'] as DraftResult | undefined;
  const instruction = typeof revision?.['instruction'] === 'string' ? revision['instruction'] as string : '';
  let steps = withStatus((run.progress.length ? run.progress : STEPS).map(s => (revision ? { ...s, status: s.id === 'read-evidence' ? 'completed' as const : 'pending' as const } : s)), 'draft', 'running');
  await ctx.report(steps);
  let envelope: unknown;
  if (config.mock.agentcore) {
    envelope = mockEnvelope(kind, source, instruction);
  } else {
    try {
      const out = await agentcore.invokeAgent(DRAFT_AGENT_ID, {
        message: `Execute assessment command ${MODE_BY_KIND[kind]}`,
        structuredInput: {
          tenant: 'assessment', mode: MODE_BY_KIND[kind], team_id: teamId, run_id: run.id, dimension: source,
          // A revision hands the agent the earlier draft as separate context, never as the instruction.
          ...(revision && prior ? { revision: { instruction, prior_draft: prior } } : {}),
        },
        timeoutMs: 120_000,
      });
      envelope = out.raw && typeof out.raw === 'object' && 'error' in out.raw ? null : JSON.parse(out.text);
    } catch { envelope = null; }
  }
  steps = withStatus(withStatus(steps, 'draft', 'completed'), 'check', 'running');
  await ctx.report(steps);
  const base = { teamId, dimensionId, dimensionTitle: source.title, facts: source.facts };
  if (revision && prior && envelope === null) {
    // A failed revision keeps the draft the assessors already have, and says so.
    return { result: { ...prior, revisionNote: 'The revision could not be generated, so the earlier draft is unchanged.' } as DraftResult, progress: withStatus(steps, 'check', 'completed') };
  }
  const result: DraftResult = kind === SUMMARY_KIND
    ? { kind: 'summary', ...base, ...acceptSummary(envelope, source) }
    : { kind: 'followups', ...base, ...acceptFollowups(envelope, source) };
  return { result, progress: withStatus(steps, 'check', 'completed') };
}
registerFlowExecutor(SUMMARY_KIND, draftExecutor);
registerFlowExecutor(FOLLOWUPS_KIND, draftExecutor);

export type DraftDecision = 'accepted' | 'discarded' | null;
export interface DraftView {
  runId: string; kind: DraftKind; teamId: string; dimensionId: string; phase: 'received' | 'running' | 'completed' | 'failed';
  steps: FlowRunStep[]; result: DraftResult | null; error: string | null; decision: DraftDecision;
  createdFollowUpIds: string[]; createdAt: string; updatedAt: string;
  /** Starts at 1; each Revise adds one. The base a revision must name. */
  revision: number; requestedBy: string; revisedBy: string | null;
}
const PHASE = { queued: 'received', running: 'running', 'waiting-approval': 'running', completed: 'completed', failed: 'failed' } as const;

export function draftView(run: FlowRunRow): DraftView {
  const decision = run.meta['decision'];
  const ids = run.meta['createdIds'];
  let createdIds: string[] = [];
  if (typeof ids === 'string') { try { const p = JSON.parse(ids); if (Array.isArray(p)) createdIds = p.map(String); } catch { /* ignore */ } }
  const { teamId, dimensionId } = parseScope(run.scope);
  return {
    runId: run.id, kind: run.kind as DraftKind, teamId, dimensionId, phase: PHASE[run.status], steps: run.progress,
    result: (run.result as DraftResult | null) ?? null, error: run.error,
    decision: decision === 'accepted' || decision === 'discarded' ? decision : null,
    createdFollowUpIds: createdIds, createdAt: run.createdAt, updatedAt: run.updatedAt,
    revision: Number(run.meta['rev'] ?? 1) || 1, requestedBy: run.requestedBy,
    revisedBy: typeof run.meta['reviseId'] === 'string' ? String(run.meta['reviseId']).split('|')[0] ?? null : null,
  };
}

/** Drafts are shared with everyone the route's read gate admits, so no requester filter. */
export const listDrafts = (teamId: string, dimensionId: string): Promise<FlowRunRow[]> =>
  flowRunStore.listScope(DRAFT_TENANT, DRAFT_KINDS, scopeFor(teamId, dimensionId), 20);

export async function getDraft(id: string): Promise<FlowRunRow | null> {
  const run = await flowRunStore.get(id);
  return run && run.tenant === DRAFT_TENANT && (DRAFT_KINDS as readonly string[]).includes(run.kind) ? run : null;
}

/** Atomic once-only decision claim by any authorized editor; false when already decided. */
export const claimDecision = (run: FlowRunRow, decision: 'accepted' | 'discarded'): Promise<boolean> =>
  flowRunStore.setMetaOnce(run.id, null, 'decision', decision);
/** Gives back a claim whose follow-on write failed, so the draft can be decided again. */
export const releaseDecision = (run: FlowRunRow, decision: 'accepted' | 'discarded'): Promise<boolean> =>
  flowRunStore.releaseMeta(run.id, 'decision', decision);
export const recordCreated = (run: FlowRunRow, ids: string[]): Promise<boolean> =>
  flowRunStore.setMetaOnce(run.id, null, 'createdIds', JSON.stringify(ids));

export type ReviseOutcome = { ok: true; revision: number } | { ok: false; reason: 'stale' | 'busy'; current: number };

/**
 * Revise a ready draft: CAS on its revision, prior text handed to the agent as
 * context. A same-actor retry of the SAME requestId after a lost response finds
 * its own revision already queued and answers ok again instead of revising twice.
 */
export async function reviseDraft(run: FlowRunRow, input: {
  userId: string; requestId: string; baseRevision: number; instruction: string; source: DraftSource;
}): Promise<ReviseOutcome> {
  const reviseId = `${input.userId}|${input.requestId}`;
  const current = Number(run.meta['rev'] ?? 1) || 1;
  if (run.meta['reviseId'] === reviseId && current === input.baseRevision + 1) return { ok: true, revision: current };
  if (run.status !== 'completed' || !run.result || run.meta['decision'] != null) return { ok: false, reason: 'busy', current };
  if (current !== input.baseRevision) return { ok: false, reason: 'stale', current };
  const queued = await flowRunStore.requeueRevision(run.id, input.baseRevision, reviseId, {
    source: input.source, title: input.source.title, revision: { instruction: input.instruction, prior: run.result },
  });
  if (!queued) {
    const fresh = await flowRunStore.get(run.id);
    return { ok: false, reason: 'stale', current: Number(fresh?.meta['rev'] ?? current) || current };
  }
  kickFlowRun(run.id, run.kind);
  return { ok: true, revision: input.baseRevision + 1 };
}
