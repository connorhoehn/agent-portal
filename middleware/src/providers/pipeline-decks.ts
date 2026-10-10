// Pipeline run report decks — storage and orchestration
// (docs/agentic-flows-migration.md, slice 3). Same shapes as
// providers/assessment-decks.ts; see "generalization opportunity" in that doc.
//
// Generation is synchronous (no run ledger of its own): read the run from the
// projection, build the facts deck (lib/pipeline-deck/facts.ts), optionally
// ask Nova for prose through the existing `draft-review-deck` command, merge
// with the same verbatim-grounded validation as the assessment deck
// (`mergeDraft`: a span that is not verbatim, or a number not in the slide's
// facts/evidence, keeps the template prose), and append revision 1.
//
// Storage: Aurora `pipeline_run_decks` + `pipeline_run_deck_revisions`
// (schema/pipeline_deck_schema.sql) or the registered mock fixtures.
// ⚠️ The Aurora SQL has not run against a live cluster; tests assert its shape.

import {
  pipelineDecksFixture, pipelineDeckRevisionsFixture,
  type PipelineDeckRevisionRow, type PipelineDeckRow,
} from '../mock/pipeline-decks.js';
import { createArtifactRevisionStore } from '../lib/flow-artifacts/index.js';
import { loadProjection } from './pipeline-runs.js';
import { listApprovals } from './pipeline-definitions.js';
import { validateDeckSpec, type DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import * as shared from '../lib/deck-shared/index.js';
import { createDeckStore } from '../lib/deck-shared/index.js';
import { PIPELINE_RUN_DECK_MODE } from '../lib/deck-shared/narrative-modes.js';
import { str, maybe, iso, summaryOf, type DeckPreviewOut, type DeckRevisionSummary, type NarrativeOutcome, type Result } from '../lib/deck-shared/index.js';
import { clip } from '../lib/deck-shared/plan.js';
import { buildReviseInput, mergeRevise } from '../lib/deck-shared/narrative.js';
import {
  flowRunStore, kickFlowRun, registerFlowExecutor, PIPELINE_DECK_REVISE_KIND,
  type FlowExecutionContext, type FlowRunRow, type FlowRunStep,
} from '../lib/flow-runs/index.js';
import { buildRunDeckFacts, buildRunDraftInput, type RunDeckSource } from '../lib/pipeline-deck/facts.js';

/** The agent that drafts this tenant's narrative slides. */
const DRAFTER_AGENT_ID = 'orgiq-assessment-drafter';

export type { PipelineDeckRow, PipelineDeckRevisionRow, DeckRevisionSummary, DeckPreviewOut, NarrativeOutcome, Result };

// ─── Wire shapes ─────────────────────────────────────────────────────────────

export interface DeckListItem { id: string; runId: string; title: string; latestRevision: DeckRevisionSummary | null; updatedAt: string }
export interface DeckDetail {
  id: string; runId: string; title: string;
  /** Newest first. */
  revisions: DeckRevisionSummary[];
  activeRevisionId: string | null;
  lockedSlideIds: string[];
  createdAt: string; updatedAt: string;
}
export const isDeckId = (v: unknown): v is string => pipelineDeckRevisions.isArtifactId(v);
export const isRevisionId = (v: unknown): v is string => pipelineDeckRevisions.isRevisionId(v);

// ─── Store (mock fixture | Aurora) ───────────────────────────────────────────


const DECK_COLS = `id, run_id, title, created_by, ${iso('created_at')} AS created_at, ${iso('updated_at')} AS updated_at, head_revision_id`;
const deckFromRow = (r: Record<string, unknown>): PipelineDeckRow => ({
  id: String(r['id']), runId: String(r['run_id']), title: String(r['title']),
  createdBy: r['created_by'] == null ? null : String(r['created_by']),
  createdAt: String(r['created_at']), updatedAt: String(r['updated_at']),
  headRevisionId: r['head_revision_id'] == null ? null : String(r['head_revision_id']),
});

/** Revisions live in the shared flow-artifacts store, on this tenant's existing tables. */
export const pipelineDeckRevisions = createArtifactRevisionStore<DeckSpec>({
  tenant: 'pipelines', subjectKind: 'run', idPrefix: 'pdeck', revisionPrefix: 'prev',
  artifactTable: 'pipeline_run_decks', revisionTable: 'pipeline_run_deck_revisions',
  emptySpec: { title: '', slides: [] },
  mock: { artifacts: () => pipelineDecksFixture.rows(), revisions: () => pipelineDeckRevisionsFixture.rows() },
});

export const pipelineDeckStore = createDeckStore<PipelineDeckRow>({
  table: 'pipeline_run_decks', cols: DECK_COLS, fixture: pipelineDecksFixture,
  subject: { col: 'run_id', prop: 'runId' }, fromRow: deckFromRow, revisions: pipelineDeckRevisions,
  insert: {
    columns: ['id', 'run_id', 'title', 'created_by'],
    params: (row) => [str('id', row.id), str('run_id', row.runId), str('title', row.title), maybe('created_by', row.createdBy)],
  },
});

// ─── Facts from the run projection ───────────────────────────────────────────

export async function loadRunDeckSource(runId: string): Promise<RunDeckSource | null> {
  const projection = await loadProjection();
  const run = projection.runs.find((r) => r.id === runId);
  if (!run) return null;
  const { approvals } = await listApprovals();
  return {
    run,
    steps: projection.steps.get(run.id) ?? [],
    artifacts: projection.artifacts.filter((a) => a.runId === run.id),
    approvals: approvals.filter((a) => a.runId === run.id),
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listDecks(runId?: string): Promise<DeckListItem[]> {
  const decks = await pipelineDeckStore.listDecks(runId);
  return Promise.all(decks.map(async (d) => {
    const latest = (await pipelineDeckStore.listRevisions(d.id))[0];
    return { id: d.id, runId: d.runId, title: d.title, latestRevision: latest ? summaryOf(latest) : null, updatedAt: d.updatedAt };
  }));
}

export async function getDeck(id: string): Promise<DeckDetail | null> {
  const deck = await pipelineDeckStore.getDeck(id);
  if (!deck) return null;
  const revisions = await pipelineDeckStore.listRevisions(id);
  const active = revisions.find((r) => r.id === deck.headRevisionId);
  return {
    id: deck.id, runId: deck.runId, title: deck.title, revisions: revisions.map(summaryOf),
    activeRevisionId: deck.headRevisionId, lockedSlideIds: active?.lockedSlideIds ?? [],
    createdAt: deck.createdAt, updatedAt: deck.updatedAt,
  };
}

export const getRevisionSpec = (deckId: string, revisionId: string): Promise<DeckSpec | null> =>
  shared.getRevisionSpec(pipelineDeckRevisions, null, deckId, revisionId);

// ─── Generation ──────────────────────────────────────────────────────────────

export async function createDeck(
  runId: string, body: { title?: unknown; narrative?: unknown }, sub: string | null,
): Promise<Result<{ deckId: string; revisionId: string; narrative: NarrativeOutcome }>> {
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 120)) {
    return { ok: false, status: 400, reason: 'title must be a string of at most 120 characters' };
  }
  if (body.narrative !== undefined && typeof body.narrative !== 'boolean') return { ok: false, status: 400, reason: 'narrative must be a boolean' };
  const source = await loadRunDeckSource(runId);
  if (!source) return { ok: false, status: 404, reason: `run ${runId} not found` };
  const facts = buildRunDeckFacts(source, typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim() } : {});

  const requested = body.narrative === true;
  const { spec, outcome, summary } = await shared.applyNarrative(
    facts, buildRunDraftInput(facts), requested, sub, { tenant: 'pipelines', mode: PIPELINE_RUN_DECK_MODE, message: 'Execute pipeline run report command pipeline-run-deck', agentId: DRAFTER_AGENT_ID }, 'Run report built from the run projection.',
  );
  const valid = validateDeckSpec(spec);
  if (!valid.ok) return { ok: false, status: 400, reason: 'the generated deck is not valid', details: { errors: valid.errors } };

  const deckId = pipelineDeckRevisions.newArtifactId();
  await pipelineDeckStore.insertDeck({ id: deckId, runId, title: valid.spec.title, createdBy: sub, headRevisionId: null });
  const appended = await pipelineDeckStore.appendRevision({
    id: pipelineDeckRevisions.newRevisionId(), deckId, baseRevisionId: null,
    label: requested && outcome.status !== 'unavailable' ? 'Generated with narrative' : 'Generated from run',
    spec: valid.spec, lockedSlideIds: [], producedBy: 'generated', createdBy: sub, summary: clip(summary, 800),
  });
  if (!appended.ok) return { ok: false, status: 409, reason: 'the deck changed while it was generated' };
  return { ok: true, value: { deckId, revisionId: appended.revision.id, narrative: outcome } };
}

// ─── Person edits, preview, file ─────────────────────────────────────────────

export const savePersonRevision = (
  deckId: string, body: { spec?: unknown; baseRevisionId?: unknown; lockedSlideIds?: unknown; label?: unknown }, sub: string | null,
): Promise<Result<DeckRevisionSummary>> =>
  shared.savePersonRevision(pipelineDeckRevisions, () => pipelineDeckStore.getDeck(deckId), deckId, body, sub);

export const previewDeck = (deckId: string, spec: unknown): Promise<Result<DeckPreviewOut>> =>
  shared.previewDeck(() => pipelineDeckStore.getDeck(deckId), spec);

export const renderRevisionFile = (deckId: string, revisionId: string): Promise<{ bytes: Buffer; filename: string } | null> =>
  shared.renderRevisionFile(pipelineDeckRevisions, () => pipelineDeckStore.getDeck(deckId), deckId, revisionId, 'run-report');

// ─── Agent revise (durable flow run) ─────────────────────────────────────────
//
// `POST /decks/:id/revise` starts a requester-private flow run (`pdr-…`,
// kind pipelines.deck-revise, scope = the deck id). The executor rebuilds the
// facts from the run projection, asks `revise-review-deck` for a spec, and
// merges it with the SAME rules as the assessment deck (`mergeRevise`: facts
// re-applied everywhere, locked and out-of-scope slides kept, constraints
// the instruction states are checked), then appends exactly one revision with
// `producedBy` = the run id. A refused or unchanged edit is a completed run
// with no revision.
//
// The drafter agent (orgiq-assessment-drafter) guards each mode by tenant
// (agents/assessment-drafter MODE_TENANTS): pipelines revises through its own
// `revise-pipeline-run-deck` (`shared.reviseWithAgent`). A refusal or error
// falls back to the deterministic reviser (`mockReviseResult`, same contract
// and same merge), reported as engine 'fallback'. Under MOCK_AGENTCORE the
// deterministic reviser is the engine ('offline').

export const MAX_INSTRUCTION_CHARS = 2000;
export const MAX_ACTIVE_REVISES_PER_USER = 3;
export const REVISE_TTL_MS = 24 * 3_600_000;
const REVISE_STEPS: FlowRunStep[] = [
  { id: 'load', label: 'Reading the deck and the run', status: 'pending' },
  { id: 'revise', label: 'Revising', status: 'pending' },
  { id: 'check', label: 'Checking against the run record', status: 'pending' },
];
const withStatus = (steps: FlowRunStep[], id: string, status: FlowRunStep['status']): FlowRunStep[] =>
  steps.map((s) => (s.id === id ? { ...s, status } : s));

export interface DeckReviseResult {
  /** The revision the run wrote; null when the edit was refused or changed nothing. */
  revisionId: string | null;
  summary: string;
  changedSlideIds: string[];
  /** agent: the drafter answered · fallback: it was unavailable, the deterministic reviser answered · offline: MOCK_AGENTCORE. */
  engine: 'agent' | 'fallback' | 'offline';
}

export async function reviseDeck(
  deckId: string, body: { instruction?: unknown; slideId?: unknown; baseRevisionId?: unknown }, sub: string,
): Promise<Result<{ runId: string }>> {
  if (typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > MAX_INSTRUCTION_CHARS) {
    return { ok: false, status: 400, reason: `instruction must be 1–${MAX_INSTRUCTION_CHARS} characters` };
  }
  if (!isRevisionId(body.baseRevisionId)) return { ok: false, status: 400, reason: 'baseRevisionId must name a revision' };
  if (body.slideId !== undefined && typeof body.slideId !== 'string') return { ok: false, status: 400, reason: 'slideId must be a string' };
  const deck = await pipelineDeckStore.getDeck(deckId);
  if (!deck) return { ok: false, status: 404, reason: 'deck not found' };
  if (deck.headRevisionId !== body.baseRevisionId) {
    return { ok: false, status: 409, reason: 'the deck has a newer revision', details: { activeRevisionId: deck.headRevisionId } };
  }
  const base = await pipelineDeckStore.getRevision(deckId, body.baseRevisionId);
  if (!base) return { ok: false, status: 404, reason: 'revision not found' };
  const slideId = body.slideId as string | undefined;
  if (slideId && !base.spec.slides.some((s) => s.id === slideId)) return { ok: false, status: 400, reason: 'slideId does not name a slide in this revision' };
  if (slideId && base.lockedSlideIds.includes(slideId)) return { ok: false, status: 409, reason: `slide ${slideId} is locked` };
  if (!(await loadRunDeckSource(deck.runId))) return { ok: false, status: 404, reason: `run ${deck.runId} not found` };
  if (await flowRunStore.countActive('pipelines', PIPELINE_DECK_REVISE_KIND, sub) >= MAX_ACTIVE_REVISES_PER_USER) {
    return { ok: false, status: 429, reason: 'wait for your running revisions to finish' };
  }
  await flowRunStore.prune(PIPELINE_DECK_REVISE_KIND, REVISE_TTL_MS);
  // Only ids and the instruction are stored; the facts are rebuilt when the run executes.
  const run = await flowRunStore.create({
    tenant: 'pipelines', kind: PIPELINE_DECK_REVISE_KIND, requestedBy: sub, scope: deckId, idPrefix: 'pdr', maxAttempts: 2,
    progress: REVISE_STEPS,
    input: { baseRevisionId: base.id, instruction: body.instruction.trim(), ...(slideId ? { slideId } : {}) },
  });
  kickFlowRun(run.id, PIPELINE_DECK_REVISE_KIND);
  return { ok: true, value: { runId: run.id } };
}

export async function reviseExecutor(ctx: FlowExecutionContext): Promise<{ result: DeckReviseResult; progress: FlowRunStep[] }> {
  const { run } = ctx;
  const deckId = run.scope;
  const baseId = String(run.input?.['baseRevisionId'] ?? '');
  const instruction = String(run.input?.['instruction'] ?? '');
  const slideId = typeof run.input?.['slideId'] === 'string' ? run.input['slideId'] : undefined;
  let steps = withStatus(run.progress.length ? run.progress : REVISE_STEPS, 'load', 'running');
  await ctx.report(steps);
  const deck = await pipelineDeckStore.getDeck(deckId);
  if (!deck) throw new Error('deck not found');
  if (deck.headRevisionId !== baseId) throw new Error('the deck has a newer revision than the one this revise started from');
  const base = await pipelineDeckStore.getRevision(deckId, baseId);
  if (!base) throw new Error('base revision not found');
  const source = await loadRunDeckSource(deck.runId);
  if (!source) throw new Error(`run ${deck.runId} not found`);
  const facts = buildRunDeckFacts(source, { title: base.spec.title });
  const input = buildReviseInput(base.spec, facts, instruction, slideId);

  steps = withStatus(withStatus(steps, 'load', 'completed'), 'revise', 'running');
  await ctx.report(steps);
  const { answer, engine } = await shared.reviseWithAgent('pipelines', input, facts, run.requestedBy, DRAFTER_AGENT_ID);

  steps = withStatus(withStatus(steps, 'revise', 'completed'), 'check', 'running');
  await ctx.report(steps);
  const merged = mergeRevise(base.spec, answer, facts, { instruction, ...(slideId ? { slideId } : {}), locked: base.lockedSlideIds });
  if (!merged.ok) throw new Error(merged.reason);
  const done = withStatus(steps, 'check', 'completed');
  if (!merged.changed) return { result: { revisionId: null, summary: merged.summary, changedSlideIds: [], engine }, progress: done };
  // The head may have moved while the agent ran: the append is the CAS.
  const appended = await pipelineDeckStore.appendRevision({
    id: pipelineDeckRevisions.newRevisionId(), deckId, baseRevisionId: base.id,
    label: clip(`Agent: ${instruction}`, 80), spec: merged.spec, lockedSlideIds: base.lockedSlideIds,
    producedBy: run.id, createdBy: null, summary: merged.summary,
  });
  if (!appended.ok) throw new Error(appended.reason === 'missing' ? 'deck not found' : 'the deck has a newer revision than the one this revise started from');
  return {
    result: { revisionId: appended.revision.id, summary: `${merged.summary} Saved revision ${appended.revision.seq}.`, changedSlideIds: merged.changedSlideIds, engine },
    progress: done,
  };
}
registerFlowExecutor(PIPELINE_DECK_REVISE_KIND, reviseExecutor);

/** The wire read of one revise run: the deck pages' `DeckRunState`. */
export interface DeckReviseRunView {
  id: string; status: 'running' | 'completed' | 'failed'; summary: string | null; error: string | null;
  revisionId: string | null; changedSlideIds: string[]; engine: DeckReviseResult['engine'] | null;
  progress: { phase: string; detail: string } | null;
}

export function reviseRunView(run: FlowRunRow): DeckReviseRunView {
  const result = (run.result ?? null) as Partial<DeckReviseResult> | null;
  const active = run.progress.find((s) => s.status === 'running') ?? run.progress.find((s) => s.status === 'pending');
  return {
    id: run.id, status: run.status === 'queued' || run.status === 'waiting-approval' ? 'running' : run.status,
    summary: typeof result?.summary === 'string' ? result.summary : null, error: run.error,
    revisionId: typeof result?.revisionId === 'string' ? result.revisionId : null,
    changedSlideIds: Array.isArray(result?.changedSlideIds) ? result.changedSlideIds : [],
    engine: result?.engine ?? null,
    progress: run.status === 'completed' || run.status === 'failed' || !active ? null : { phase: active.label, detail: '' },
  };
}

/** One of the requester's own revise runs for this deck; anyone else's, another deck's or an unknown one is null. */
export async function getReviseRunFor(sub: string, deckId: string, runId: string): Promise<FlowRunRow | null> {
  const run = await flowRunStore.getFor('pipelines', sub, runId);
  return run && run.kind === PIPELINE_DECK_REVISE_KIND && run.scope === deckId ? run : null;
}
