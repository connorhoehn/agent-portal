// Evidence summary and follow-up drafts for one dimension — the client half of
// middleware/src/routes/assessment-drafts.ts (docs/agentic-flows-migration.md
// slice 8). Pure and fetch-injectable so node:test covers it without a DOM.
// Every level and count shown comes from `facts`, which the server reads from
// the provider; the model's prose is only ever shown beside its verbatim quotes.

import type { AgentRunStatus } from '@connorhoehn/ui-components/social';

export type DraftKind = 'assessment.evidence-summary' | 'assessment.followup-drafts';
export type DraftPhase = 'received' | 'running' | 'completed' | 'failed';
export interface EvidenceSpan { evidenceId: string; text: string }
export interface DraftFacts { verifiedLevel: number | null; claimedLevel: number | null; targetLevel: number; openClaim: boolean; evidenceCount: number }
export interface SummaryBullet { text: string; sourceSpans: EvidenceSpan[] }
export interface QuestionDraft { text: string; criterionId: string | null; criterionText: string | null; sourceSpans: EvidenceSpan[] }
interface ResultBase { revisionNote?: string; teamId: string; dimensionId: string; dimensionTitle: string; facts: DraftFacts; summary: string; fallback: boolean }
export interface SummaryDraft extends ResultBase { kind: 'summary'; bullets: SummaryBullet[] }
export interface FollowupsDraft extends ResultBase { kind: 'followups'; questions: QuestionDraft[] }
export interface DraftView {
  runId: string; kind: DraftKind; teamId: string; dimensionId: string; phase: DraftPhase;
  steps: Array<{ id: string; label: string; status: 'pending' | 'running' | 'completed' | 'failed' }>;
  result: SummaryDraft | FollowupsDraft | null; error: string | null;
  decision: 'accepted' | 'discarded' | null; createdFollowUpIds: string[]; createdAt: string; updatedAt: string;
  /** 1 for the first draft; each Revise adds one. */
  revision: number; requestedBy: string; revisedBy: string | null;
}
export interface AcceptOutcome { created: Array<{ question_id: string; text: string }>; skipped: string[] }

type Fetch = typeof fetch;
const teamBase = (teamId: string, dimensionId: string): string =>
  `/api/assessment/teams/${encodeURIComponent(teamId)}/dimensions/${encodeURIComponent(dimensionId)}/drafts`;

async function json<T>(response: Response, fallback: string): Promise<T> {
  let body: unknown = null;
  try { body = await response.json(); } catch { /* an empty error body falls back to the message below */ }
  if (!response.ok) {
    const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error : response.status === 403 ? 'You do not have permission for this action.' : fallback;
    throw new Error(message);
  }
  return body as T;
}

const post = (url: string, body: unknown, doFetch: Fetch): Promise<Response> =>
  doFetch(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export async function startDraft(teamId: string, dimensionId: string, kind: 'summary' | 'followups', doFetch: Fetch = fetch): Promise<{ runId: string }> {
  const path = kind === 'summary' ? 'evidence-summary' : 'followups';
  return json(await post(`${teamBase(teamId, dimensionId)}/${path}`, {}, doFetch), 'The draft could not be started.');
}
export async function listDrafts(teamId: string, dimensionId: string, doFetch: Fetch = fetch): Promise<DraftView[]> {
  const out = await json<{ drafts: DraftView[] }>(await doFetch(teamBase(teamId, dimensionId), { credentials: 'include' }), 'Drafts could not be read.');
  return out.drafts;
}
export async function fetchDraft(runId: string, doFetch: Fetch = fetch): Promise<DraftView> {
  return json(await doFetch(`/api/assessment/drafts/${encodeURIComponent(runId)}`, { credentials: 'include' }), 'The draft could not be read.');
}
export async function acceptDraft(runId: string, indices: number[] | undefined, baseRevision?: number, doFetch: Fetch = fetch): Promise<AcceptOutcome> {
  const response = await post(`/api/assessment/drafts/${encodeURIComponent(runId)}/accept`, { ...(indices ? { indices } : {}), ...(baseRevision ? { baseRevision } : {}) }, doFetch);
  await throwIfNewer(response);
  return json(response, 'The follow-ups could not be added.');
}
export async function discardDraft(runId: string, doFetch: Fetch = fetch): Promise<void> {
  const response = await post(`/api/assessment/drafts/${encodeURIComponent(runId)}/discard`, {}, doFetch);
  await throwIfNewer(response);
  await json(response, 'The draft could not be discarded.');
}

export const isTerminal = (d: Pick<DraftView, 'phase'>): boolean => d.phase === 'completed' || d.phase === 'failed';
export const MAX_POLLS = 90;
export const pollDelayMs = (attempt: number): number => Math.min(2500, 400 + attempt * 300);

/** Drafts worth showing again after a reload: not discarded, and a summary stays until discarded. */
export const isLive = (d: DraftView): boolean => d.decision !== 'discarded' && (d.decision === null || d.kind === 'assessment.followup-drafts');

export const kindLabel = (kind: DraftKind): string => (kind === 'assessment.evidence-summary' ? 'Evidence summary' : 'Follow-up drafts');
export const commandOf = (kind: DraftKind): string => (kind === 'assessment.evidence-summary' ? 'summarize-evidence' : 'draft-followups');

/** What `AgentRunCard` reads. */
export function agentRunStatusOf(d: DraftView): AgentRunStatus {
  const running = d.steps.find(s => s.status === 'running');
  return {
    phase: d.phase,
    details: { steps: d.steps.map(({ id, label, status }) => ({ id, label, status })), ...(d.error ? { error: d.error } : {}) },
    ...(running ? { stepLabel: running.label } : {}),
    ...(d.phase === 'failed' ? { detail: d.error ?? 'The draft failed.' } : {}),
    ...(d.phase === 'completed' && d.result?.fallback
      ? { detail: "The model's answer could not be verified, so this draft only quotes the evidence and rubric." } : {}),
  };
}

const level = (n: number | null): string => (n === null ? 'none' : `L${n}`);
/** The provider's numbers, never the model's. */
export function factsLine(f: DraftFacts): string {
  return `Verified ${level(f.verifiedLevel)} · claimed ${level(f.claimedLevel)} · target L${f.targetLevel} · ${f.evidenceCount} evidence item${f.evidenceCount === 1 ? '' : 's'}`;
}

const quote = (s: EvidenceSpan): string => `> "${s.text}"`;
/** Review text for a summary: each bullet with the verbatim quotes behind it. */
export function summaryMarkdown(d: SummaryDraft): string {
  if (d.bullets.length === 0) return d.summary;
  return [d.summary, '', ...d.bullets.flatMap(b => [`- ${b.text}`, ...b.sourceSpans.map(s => `  ${quote(s)}`)])].join('\n');
}

/** Accept is offered for a finished, undecided follow-up draft that has questions. */
export const canAccept = (d: DraftView): boolean =>
  d.kind === 'assessment.followup-drafts' && d.phase === 'completed' && d.decision === null
  && d.result?.kind === 'followups' && d.result.questions.length > 0;

export function toggleIndex(selected: readonly number[], index: number): number[] {
  return selected.includes(index) ? selected.filter(i => i !== index) : [...selected, index].sort((a, b) => a - b);
}

/** Question rows left unchecked are not sent; none checked means nothing to accept. */
export const acceptPayload = (selected: readonly number[], total: number): number[] | undefined =>
  selected.length === total ? undefined : [...selected];

/** Raised when someone else revised first; the caller shows the newer version. */
export class NewerVersionError extends Error {}
/** A 409 from accept/discard means a teammate decided or revised first; the caller shows the newer version. */
async function throwIfNewer(response: Response): Promise<void> {
  if (response.status !== 409) return;
  let msg = 'Someone changed this draft first.';
  try { const b = await response.clone().json() as { error?: string }; if (b.error) msg = b.error; } catch { /* keep the default */ }
  throw new NewerVersionError(msg);
}
export const newRequestId = (): string => (globalThis.crypto?.randomUUID?.() ?? `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`).slice(0, 64);

/** Revise a ready draft. `requestId` is reused when the same click is retried, so a lost response cannot revise twice. */
export async function reviseDraft(runId: string, instruction: string, baseRevision: number, requestId: string, doFetch: Fetch = fetch): Promise<{ revision: number }> {
  const response = await post(`/api/assessment/drafts/${encodeURIComponent(runId)}/revise`, { instruction, baseRevision, requestId }, doFetch);
  if (response.status === 409) {
    let msg = 'Someone revised this draft first.';
    try { const b = await response.json() as { error?: string }; if (b.error) msg = b.error; } catch { /* keep the default */ }
    throw new NewerVersionError(msg);
  }
  return json(response, 'The draft could not be revised.');
}

/** Revise is offered on a finished, undecided draft. */
export const canRevise = (d: DraftView): boolean => d.phase === 'completed' && d.decision === null && d.result !== null;
/** A draft someone else revised while this one is on screen. */
export const isNewer = (shown: Pick<DraftView, 'revision'> | null | undefined, listed: Pick<DraftView, 'revision'> | undefined): boolean =>
  !!shown && !!listed && listed.revision > shown.revision;
