// Assessment review decks — storage and orchestration
// (docs/assessment-deck-goal.md).
//
// Storage: Aurora `assessment_decks` + `assessment_deck_revisions`
// (schema/assessment_deck_schema.sql, parameterized RDS Data API SQL) or,
// under MOCK_AURORA, the registered fixtures in mock/assessment-decks.ts.
// Revisions are append-only; every append names its base and is refused
// (409) unless that base is still the deck's head — one statement on Aurora,
// so two writers cannot both win.
//
// Workflow: generation and agent revisions are assessment runs
// (`launchRun`), so they inherit the dispatcher, the Runs page, progress and
// failure. `applyDeckRunResult` is called from `completeRun` and turns the
// drafter's output into exactly one revision, `producedBy` = the run id.
// ⚠️ The Aurora SQL here has not run against a live cluster (none is
// reachable in this environment); it is covered by tests that assert on its
// shape, like assessment-aurora.ts.

import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import {
  assessmentDecksFixture, assessmentDeckRevisionsFixture,
  type AssessmentDeckRevisionRow, type AssessmentDeckRow,
} from '../mock/assessment-decks.js';
import * as M from '../mock/assessment.js';
import { exec } from './aurora.js';
import { createArtifactRevisionStore } from '../lib/flow-artifacts/index.js';
import { getRun, getTeamDeckSource, launchRun } from './assessment.js';
import { validateDeckSpec, type DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import * as shared from '../lib/deck-shared/index.js';
import { createDeckStore } from '../lib/deck-shared/index.js';
import { str, maybe, json, parse, iso, summaryOf, type DeckPreviewOut, type DeckRevisionSummary, type Result } from '../lib/deck-shared/index.js';
import { buildDeckFacts, clip, type DeckFacts } from '../lib/assessment-deck/facts.js';
import {
  buildDraftInput, buildReviseInput, mergeDraft, mergeRevise, mockDraftResult, mockReviseResult,
} from '../lib/assessment-deck/narrative.js';

export type { AssessmentDeckRow, AssessmentDeckRevisionRow, DeckRevisionSummary, DeckPreviewOut, Result };

// ─── Wire shapes ─────────────────────────────────────────────────────────────

export interface DeckListItem {
  id: string; teamId: string; title: string;
  latestRevision: DeckRevisionSummary | null;
  updatedAt: string;
}

export interface DeckRunRef {
  runId: string; command: string; status: M.RunStatus; summary: string; error: string | null;
}

export interface DeckDetail {
  id: string; teamId: string; title: string; audience: string | null;
  /** Newest first. */
  revisions: DeckRevisionSummary[];
  activeRevisionId: string | null;
  /** Locked slide ids of the active revision — kept by regeneration and agent revisions. */
  lockedSlideIds: string[];
  /** Present while a generation/revise run for this deck is running. */
  pendingRun?: DeckRunRef;
  /** The most recent run, whatever its outcome (so a failure can be shown). */
  lastRun?: DeckRunRef;
  createdAt: string; updatedAt: string;
}

export const isDeckId = (v: unknown): v is string => deckRevisions.isArtifactId(v);
export const isRevisionId = (v: unknown): v is string => deckRevisions.isRevisionId(v);
const MAX_INSTRUCTION_CHARS = 2000;
const MAX_AUDIENCE_CHARS = 80;

// ─── Store (mock fixture | Aurora) ───────────────────────────────────────────

const DECK_COLS = `id, team_id, title, audience, dimension_ids::text AS dimension_ids, created_by,
  ${iso('created_at')} AS created_at, ${iso('updated_at')} AS updated_at, head_revision_id, last_run_id`;

function deckFromRow(r: Record<string, unknown>): AssessmentDeckRow {
  return {
    id: String(r['id']), teamId: String(r['team_id']), title: String(r['title']),
    audience: r['audience'] == null ? null : String(r['audience']),
    dimensionIds: parse<string[]>(r['dimension_ids'], []),
    createdBy: r['created_by'] == null ? null : String(r['created_by']),
    createdAt: String(r['created_at']), updatedAt: String(r['updated_at']),
    headRevisionId: r['head_revision_id'] == null ? null : String(r['head_revision_id']),
    lastRunId: r['last_run_id'] == null ? null : String(r['last_run_id']),
  };
}

/** Revisions live in the shared flow-artifacts store, on this tenant's existing tables. */
export const deckRevisions = createArtifactRevisionStore<DeckSpec>({
  tenant: 'assessment', subjectKind: 'team', idPrefix: 'deck', revisionPrefix: 'rev',
  artifactTable: 'assessment_decks', revisionTable: 'assessment_deck_revisions',
  emptySpec: { title: '', slides: [] },
  mock: { artifacts: () => assessmentDecksFixture.rows(), revisions: () => assessmentDeckRevisionsFixture.rows() },
});

const baseDeckStore = createDeckStore<AssessmentDeckRow>({
  table: 'assessment_decks', cols: DECK_COLS, fixture: assessmentDecksFixture,
  subject: { col: 'team_id', prop: 'teamId' }, fromRow: deckFromRow, revisions: deckRevisions,
  insert: {
    columns: ['id', 'team_id', 'title', 'audience', 'dimension_ids', 'created_by', 'last_run_id'],
    exprs: { dimension_ids: 'CAST(:dimension_ids AS JSONB)' },
    params: (row) => [str('id', row.id), str('team_id', row.teamId), str('title', row.title), maybe('audience', row.audience),
      json('dimension_ids', row.dimensionIds), maybe('created_by', row.createdBy), maybe('last_run_id', row.lastRunId)],
  },
});

export const deckStore = {
  ...baseDeckStore,

  async setLastRun(deckId: string, runId: string): Promise<void> {
    if (config.mock.aurora) {
      const deck = assessmentDecksFixture.rows().find((d) => d.id === deckId);
      if (deck) { deck.lastRunId = runId; deck.updatedAt = clock.nowIso(); }
      return;
    }
    await exec('UPDATE assessment_decks SET last_run_id = :run_id, updated_at = NOW() WHERE id = :id',
      [str('id', deckId), str('run_id', runId)]);
  },
};

// ─── Facts ───────────────────────────────────────────────────────────────────

async function deckFacts(deck: AssessmentDeckRow): Promise<DeckFacts | null> {
  const source = await getTeamDeckSource(deck.teamId);
  if (!source) return null;
  return buildDeckFacts(source, {
    asOf: deck.createdAt, title: deck.title,
    ...(deck.audience ? { audience: deck.audience } : {}),
    ...(deck.dimensionIds.length ? { dimensionIds: deck.dimensionIds } : {}),
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listDecks(teamId?: string): Promise<DeckListItem[]> {
  const decks = await deckStore.listDecks(teamId);
  return Promise.all(decks.map(async (d) => {
    const latest = (await deckStore.listRevisions(d.id))[0];
    return { id: d.id, teamId: d.teamId, title: d.title, latestRevision: latest ? summaryOf(latest) : null, updatedAt: d.updatedAt };
  }));
}

export async function getDeck(id: string): Promise<DeckDetail | null> {
  const deck = await deckStore.getDeck(id);
  if (!deck) return null;
  const revisions = await deckStore.listRevisions(id);
  const active = revisions.find((r) => r.id === deck.headRevisionId);
  const run = deck.lastRunId ? await getRun(deck.lastRunId) : null;
  const runRef: DeckRunRef | undefined = run
    ? { runId: run.id, command: run.command, status: run.status, summary: run.summary, error: run.error }
    : undefined;
  return {
    id: deck.id, teamId: deck.teamId, title: deck.title, audience: deck.audience,
    revisions: revisions.map(summaryOf), activeRevisionId: deck.headRevisionId,
    lockedSlideIds: active?.lockedSlideIds ?? [],
    ...(runRef && runRef.status === 'running' ? { pendingRun: runRef } : {}),
    ...(runRef ? { lastRun: runRef } : {}),
    createdAt: deck.createdAt, updatedAt: deck.updatedAt,
  };
}

export const getRevisionSpec = (deckId: string, revisionId: string): Promise<DeckSpec | null> =>
  shared.getRevisionSpec(deckRevisions, null, deckId, revisionId);

// ─── Generation and agent revisions (runs) ───────────────────────────────────

export async function createDeck(
  teamId: string, body: { title?: unknown; dimensionIds?: unknown; audience?: unknown }, sub: string | null,
): Promise<Result<{ deckId: string; runId: string }>> {
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 120)) {
    return { ok: false, status: 400, reason: 'title must be a string of at most 120 characters' };
  }
  if (body.audience !== undefined && (typeof body.audience !== 'string' || body.audience.length > MAX_AUDIENCE_CHARS)) {
    return { ok: false, status: 400, reason: `audience must be a string of at most ${MAX_AUDIENCE_CHARS} characters` };
  }
  let dimensionIds: string[] = [];
  if (body.dimensionIds !== undefined) {
    if (!Array.isArray(body.dimensionIds) || body.dimensionIds.some((d) => typeof d !== 'string' || !M.DIMENSION_IDS.includes(d))) {
      return { ok: false, status: 400, reason: 'dimensionIds must be rubric dimension ids' };
    }
    dimensionIds = [...new Set(body.dimensionIds as string[])];
  }
  const source = await getTeamDeckSource(teamId);
  if (!source) return { ok: false, status: 404, reason: `team ${teamId} not found` };
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : `${source.team.name} — assessment review`;
  const audience = typeof body.audience === 'string' && body.audience.trim() ? body.audience.trim() : null;
  const deckId = deckRevisions.newArtifactId();
  // The facts as they stand now; the run rebuilds them at completion from the
  // same provider, so a score that lands meanwhile is what the deck states.
  const facts = buildDeckFacts(source, {
    asOf: config.mock.aurora ? clock.nowIso() : new Date().toISOString(), title,
    ...(audience ? { audience } : {}), ...(dimensionIds.length ? { dimensionIds } : {}),
  });
  const launched = await launchRun('draft-review-deck', { deck_id: deckId }, teamId, sub,
    buildDraftInput(facts) as unknown as Record<string, unknown>);
  if (!launched.ok) return { ok: false, status: launched.status, reason: launched.reason };
  await deckStore.insertDeck({
    id: deckId, teamId, title, audience, dimensionIds, createdBy: sub, headRevisionId: null, lastRunId: launched.run_id,
  });
  return { ok: true, value: { deckId, runId: launched.run_id } };
}

export async function reviseDeck(
  deckId: string, body: { instruction?: unknown; slideId?: unknown; baseRevisionId?: unknown }, sub: string | null,
): Promise<Result<{ runId: string }>> {
  if (typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > MAX_INSTRUCTION_CHARS) {
    return { ok: false, status: 400, reason: `instruction must be 1–${MAX_INSTRUCTION_CHARS} characters` };
  }
  if (!isRevisionId(body.baseRevisionId)) return { ok: false, status: 400, reason: 'baseRevisionId must name a revision' };
  if (body.slideId !== undefined && typeof body.slideId !== 'string') return { ok: false, status: 400, reason: 'slideId must be a string' };
  const deck = await deckStore.getDeck(deckId);
  if (!deck) return { ok: false, status: 404, reason: 'deck not found' };
  if (deck.headRevisionId !== body.baseRevisionId) {
    return { ok: false, status: 409, reason: 'the deck has a newer revision', details: { activeRevisionId: deck.headRevisionId } };
  }
  const base = await deckStore.getRevision(deckId, body.baseRevisionId);
  if (!base) return { ok: false, status: 404, reason: 'revision not found' };
  const slideId = body.slideId as string | undefined;
  if (slideId && !base.spec.slides.some((s) => s.id === slideId)) return { ok: false, status: 400, reason: 'slideId does not name a slide in this revision' };
  if (slideId && base.lockedSlideIds.includes(slideId)) return { ok: false, status: 409, reason: `slide ${slideId} is locked` };
  const facts = await deckFacts(deck);
  if (!facts) return { ok: false, status: 404, reason: `team ${deck.teamId} not found` };
  const instruction = body.instruction.trim();
  const launched = await launchRun('revise-review-deck',
    { deck_id: deckId, base_revision_id: base.id, instruction, ...(slideId ? { slide_id: slideId } : {}) },
    deck.teamId, sub, buildReviseInput(base.spec, facts, instruction, slideId) as unknown as Record<string, unknown>);
  if (!launched.ok) return { ok: false, status: launched.status, reason: launched.reason };
  await deckStore.setLastRun(deckId, launched.run_id);
  return { ok: true, value: { runId: launched.run_id } };
}

/** The offline drafter's answer for a mock run — the same input a real run gets. */
export async function mockDeckRunResult(run: M.MockRun): Promise<unknown> {
  const deck = await deckStore.getDeck(String(run.args['deck_id'] ?? ''));
  if (!deck) throw new Error('deck not found');
  const facts = await deckFacts(deck);
  if (!facts) throw new Error(`team ${deck.teamId} not found`);
  if (run.command === 'draft-review-deck') return mockDraftResult(buildDraftInput(facts), facts);
  const base = await deckStore.getRevision(deck.id, String(run.args['base_revision_id'] ?? ''));
  if (!base) throw new Error('base revision not found');
  const slideId = typeof run.args['slide_id'] === 'string' ? run.args['slide_id'] : undefined;
  return mockReviseResult(buildReviseInput(base.spec, facts, String(run.args['instruction'] ?? ''), slideId), facts);
}

/**
 * Called by completeRun for a review-deck command: merge the drafter's output
 * over the facts and append exactly one revision (`producedBy` = run id).
 * A refused agent edit is a completed run with no revision ("no change").
 */
export async function applyDeckRunResult(run: M.MockRun, result: unknown): Promise<{ ok: true; summary: string } | { ok: false; reason: string }> {
  const deck = await deckStore.getDeck(String(run.args['deck_id'] ?? ''));
  if (!deck) return { ok: false, reason: 'deck not found' };
  if (result === undefined) return { ok: false, reason: 'the drafter returned no result' };
  const facts = await deckFacts(deck);
  if (!facts) return { ok: false, reason: `team ${deck.teamId} not found` };

  if (run.command === 'draft-review-deck') {
    const head = deck.headRevisionId ? await deckStore.getRevision(deck.id, deck.headRevisionId) : null;
    const merged = mergeDraft(facts, result, head ? { previous: head.spec, locked: head.lockedSlideIds } : {});
    const valid = validateDeckSpec(merged.spec);
    if (!valid.ok) return { ok: false, reason: `the drafted deck is not valid: ${valid.errors.join('; ')}` };
    const appended = await deckStore.appendRevision({
      id: deckRevisions.newRevisionId(), deckId: deck.id, baseRevisionId: deck.headRevisionId,
      label: 'Draft by agent', spec: valid.spec, lockedSlideIds: head?.lockedSlideIds ?? [],
      producedBy: run.id, createdBy: null, summary: merged.summary,
    });
    if (!appended.ok) return { ok: false, reason: appended.reason === 'missing' ? 'deck not found' : 'the deck changed while the draft was running' };
    const templated = merged.templated.length ? ` ${merged.templated.length} slide${merged.templated.length === 1 ? '' : 's'} kept template text.` : '';
    return { ok: true, summary: `${merged.summary} Saved revision ${appended.revision.seq}.${templated}` };
  }

  const baseId = String(run.args['base_revision_id'] ?? '');
  if (deck.headRevisionId !== baseId) return { ok: false, reason: 'the deck has a newer revision than the one this revise started from' };
  const base = await deckStore.getRevision(deck.id, baseId);
  if (!base) return { ok: false, reason: 'base revision not found' };
  const instruction = String(run.args['instruction'] ?? '');
  const slideId = typeof run.args['slide_id'] === 'string' ? run.args['slide_id'] : undefined;
  const merged = mergeRevise(base.spec, result, facts, { instruction, ...(slideId ? { slideId } : {}), locked: base.lockedSlideIds });
  if (!merged.ok) return { ok: false, reason: merged.reason };
  if (!merged.changed) return { ok: true, summary: merged.summary };
  const appended = await deckStore.appendRevision({
    id: deckRevisions.newRevisionId(), deckId: deck.id, baseRevisionId: base.id,
    label: clip(`Agent: ${instruction}`, 80), spec: merged.spec, lockedSlideIds: base.lockedSlideIds,
    producedBy: run.id, createdBy: null, summary: merged.summary,
  });
  if (!appended.ok) return { ok: false, reason: appended.reason === 'missing' ? 'deck not found' : 'the deck has a newer revision than the one this revise started from' };
  return { ok: true, summary: `${merged.summary} Saved revision ${appended.revision.seq} (${merged.changedSlideIds.join(', ')}).` };
}

// ─── Person edits, preview, file ─────────────────────────────────────────────

export const savePersonRevision = (
  deckId: string, body: { spec?: unknown; baseRevisionId?: unknown; lockedSlideIds?: unknown; label?: unknown }, sub: string | null,
): Promise<Result<DeckRevisionSummary>> =>
  shared.savePersonRevision(deckRevisions, () => deckStore.getDeck(deckId), deckId, body, sub);

export const previewDeck = (deckId: string, spec: unknown): Promise<Result<DeckPreviewOut>> =>
  shared.previewDeck(() => deckStore.getDeck(deckId), spec);

export const renderRevisionFile = (deckId: string, revisionId: string): Promise<{ bytes: Buffer; filename: string } | null> =>
  shared.renderRevisionFile(deckRevisions, () => deckStore.getDeck(deckId), deckId, revisionId, 'review-deck');
