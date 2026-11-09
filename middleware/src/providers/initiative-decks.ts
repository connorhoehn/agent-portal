import { config } from '../config.js';
import { archivedDeckHistoryFixture, initializeInitiativeDeckDurability, persistInitiativeDecks, trackInitiativeDeckCreation } from '../mock/initiative-deck-durability.js';
// Orgiq initiative status decks — storage and orchestration
// (docs/agentic-flows-migration.md, slice 6). Same shape as
// providers/pipeline-decks.ts, with `project_id` as the subject.
//
// Generation is synchronous: read the initiative's own rows (project, work
// items, sprints, decisions and — for a budget-tier reader only — the budget
// ledger, sprint envelopes and the 30-day maintenance floor), build the facts
// deck (lib/initiative-deck/facts.ts), optionally ask Nova for prose through the
// existing `draft-review-deck` command, merge with the same verbatim-grounded
// validation as the assessment deck (`mergeDraft`), and append revision 1.
//
// BUDGET TIER. A deck built with budget figures is stored with
// `includes_budget = true`. Every read, preview, download and edit of such a
// deck is refused (as "not found") to a caller who cannot read budgets, and it
// is left out of their lists. A caller without the tier gets a deck built
// without any money slide, so what a non-reader holds never carried the figures.
//
// Storage: Aurora `initiative_decks` + `initiative_deck_revisions`
// (schema/initiative_deck_schema.sql) or the registered mock fixtures.
// ⚠️ The Aurora SQL has not run against a live cluster; tests assert its shape.

import { clock } from '../mock/core/index.js';
import {
  initiativeDecksFixture, initiativeDeckRevisionsFixture,
  type InitiativeDeckRevisionRow, type InitiativeDeckRow,
} from '../mock/initiative-decks.js';
import { createArtifactRevisionStore } from '../lib/flow-artifacts/index.js';
import { getProject } from './projects.js';
import { getProjectWorkItems, getProjectDecisions } from './work-items.js';
import { listSprints } from './sprints.js';
import { getBudget, getMaintenance30d, listGrants } from './budgets.js';
import { validateDeckSpec, type DeckSpec } from '@connorhoehn/realtime-modules/deck';
import * as shared from '../lib/deck-shared/index.js';
import { createDeckStore } from '../lib/deck-shared/index.js';
import { INITIATIVE_STATUS_DECK_MODE } from '../lib/deck-shared/narrative-modes.js';
import { str, maybe, iso, summaryOf, type DeckPreviewOut, type DeckRevisionSummary, type NarrativeOutcome, type Result } from '../lib/deck-shared/index.js';
import { clip } from '../lib/deck-shared/plan.js';
import { buildInitiativeDeckFacts, buildInitiativeDraftInput, type InitiativeDeckSource } from '../lib/initiative-deck/facts.js';
import { canReadBudgets } from '../lib/budget-read-tier.js';
import { briefLine, readBrief, resolveBrief, type DeckBrief } from '../lib/initiative-deck/brief.js';

/** The agent that drafts this tenant's narrative slides. */
const DRAFTER_AGENT_ID = 'orgiq-assessment-drafter';

export type { InitiativeDeckRow, InitiativeDeckRevisionRow, DeckRevisionSummary, DeckPreviewOut, NarrativeOutcome, Result };

// ─── Wire shapes ─────────────────────────────────────────────────────────────

export interface DeckListItem {
  id: string; projectId: string; title: string; includesBudget: boolean;
  latestRevision: DeckRevisionSummary | null; updatedAt: string;
}
export interface DeckDetail {
  id: string; projectId: string; title: string; includesBudget: boolean;
  /** Newest first. */
  revisions: DeckRevisionSummary[];
  activeRevisionId: string | null;
  lockedSlideIds: string[];
  createdAt: string; updatedAt: string;
}
/** What the caller may see of money. Decided by the route from the session. */
export interface DeckViewer { canReadBudgets: boolean }

export const isDeckId = (v: unknown): v is string => initiativeDeckRevisions.isArtifactId(v);
export const isRevisionId = (v: unknown): v is string => initiativeDeckRevisions.isRevisionId(v);

initializeInitiativeDeckDurability();

// ─── Store (mock fixture | Aurora) ───────────────────────────────────────────


const DECK_COLS = `id, project_id, title, includes_budget, created_by, ${iso('created_at')} AS created_at, ${iso('updated_at')} AS updated_at, head_revision_id`;
const deckFromRow = (r: Record<string, unknown>): InitiativeDeckRow => ({
  id: String(r['id']), projectId: String(r['project_id']), title: String(r['title']),
  includesBudget: r['includes_budget'] === true || r['includes_budget'] === 'true',
  createdBy: r['created_by'] == null ? null : String(r['created_by']),
  createdAt: String(r['created_at']), updatedAt: String(r['updated_at']),
  headRevisionId: r['head_revision_id'] == null ? null : String(r['head_revision_id']),
});

/** Revisions live in the shared flow-artifacts store, on this tenant's own tables. */
export const initiativeDeckRevisions = createArtifactRevisionStore<DeckSpec>({
  tenant: 'orgiq', subjectKind: 'initiative', idPrefix: 'idk', revisionPrefix: 'irev',
  artifactTable: 'initiative_decks', revisionTable: 'initiative_deck_revisions',
  emptySpec: { title: '', slides: [] },
  mock: { artifacts: () => initiativeDecksFixture.rows(), revisions: () => initiativeDeckRevisionsFixture.rows(), afterAppend: persistInitiativeDecks },
});

export const initiativeDeckStore = createDeckStore<InitiativeDeckRow>({
  table: 'initiative_decks', cols: DECK_COLS, fixture: initiativeDecksFixture,
  subject: { col: 'project_id', prop: 'projectId' }, fromRow: deckFromRow, revisions: initiativeDeckRevisions,
  insert: {
    columns: ['id', 'project_id', 'title', 'includes_budget', 'created_by'],
    params: (row) => [str('id', row.id), str('project_id', row.projectId), str('title', row.title),
      { name: 'includes_budget', value: { booleanValue: row.includesBudget } }, maybe('created_by', row.createdBy)],
  },
});

// ─── Visibility (the ONE rule: REST routes and the orgiq:deck presence channel) ─

/** Roles that read the budgets surface outright (routes/budgets.ts readGate). */
export { BUDGET_READ_ROLES } from '../lib/budget-read-tier.js';

/** The budgets read tier of `session`: those roles, else whoever holds ManageBudgets.
 * Asked per call (no cache): routes/initiative-decks.ts per request and
 * lib/live-principal.ts per presence subscribe/delivered frame. One predicate
 * (lib/budget-read-tier.ts) shared with the local data assistant. */
export async function deckViewerFor(session: { sub: string; tenant: string; role: string; grants?: Record<string, string[]> | null } | null | undefined): Promise<DeckViewer> {
  return { canReadBudgets: await canReadBudgets(session) };
}

/** May `viewer` see this deck at all? A budget deck is invisible below the tier. */
export const deckVisibleTo = (deck: Pick<InitiativeDeckRow, 'includesBudget'>, viewer: DeckViewer): boolean =>
  !deck.includesBudget || viewer.canReadBudgets;

/** A deck the viewer may open, else null: malformed id, unknown deck and a budget
 * deck seen below the tier are one indistinguishable "not found". */
export async function visibleDeck(deckId: string, viewer: DeckViewer): Promise<InitiativeDeckRow | null> {
  if (!isDeckId(deckId)) return null;
  const deck = await initiativeDeckStore.getDeck(deckId);
  return deck && deckVisibleTo(deck, viewer) ? deck : null;
}

// ─── Facts from the initiative's rows ────────────────────────────────────────

export async function loadInitiativeDeckSource(projectId: string, includeBudget: boolean): Promise<InitiativeDeckSource | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const [workItems, decisions, sprints] = await Promise.all([
    getProjectWorkItems(projectId), getProjectDecisions(projectId), listSprints({ orgProjectId: projectId, limit: 200 }),
  ]);
  let budget: InitiativeDeckSource['budget'] = null;
  let grants: InitiativeDeckSource['grants'] = null;
  if (includeBudget) {
    const [row, floor, g] = await Promise.all([getBudget(projectId), getMaintenance30d(projectId), listGrants(projectId)]);
    budget = {
      period: row?.period ?? null, allocatedUsd: row?.allocatedUsd ?? null,
      spentThisPeriodUsd: row?.spentThisPeriodUsd ?? 0, runCountThisPeriod: row?.runCountThisPeriod ?? 0,
      maintenance30dUsd: floor.costUsd, cronRuns30d: floor.cronRuns,
    };
    grants = g;
  }
  return {
    project: {
      id: project.id, name: project.name, status: project.status, summary: project.summary,
      ownerName: project.ownerName, sponsorName: project.sponsorName, repoFullName: project.repoFullName,
    },
    asOf: clock.nowIso().slice(0, 10),
    workItems, sprints, decisions, budget, grants,
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listDecks(viewer: DeckViewer, projectId?: string): Promise<DeckListItem[]> {
  const decks = (await initiativeDeckStore.listDecks(projectId)).filter((d) => deckVisibleTo(d, viewer));
  return Promise.all(decks.map(async (d) => {
    const latest = (await initiativeDeckStore.listRevisions(d.id))[0];
    return { id: d.id, projectId: d.projectId, title: d.title, includesBudget: d.includesBudget, latestRevision: latest ? summaryOf(latest) : null, updatedAt: d.updatedAt };
  }));
}

export async function getDeck(id: string, viewer: DeckViewer): Promise<DeckDetail | null> {
  const deck = await visibleDeck(id, viewer);
  if (!deck) return null;
  const revisions = await initiativeDeckStore.listRevisions(id);
  const active = revisions.find((r) => r.id === deck.headRevisionId);
  return {
    id: deck.id, projectId: deck.projectId, title: deck.title, includesBudget: deck.includesBudget,
    revisions: [...revisions.map(r => ({ ...summaryOf(r), seq: r.seq })),
      ...(config.mock.aurora ? archivedDeckHistoryFixture.rows().filter(r => r.deckId === id) : [])]
      .sort((a, b) => b.seq - a.seq).map(({ seq: _seq, ...summary }) => summary),
    activeRevisionId: deck.headRevisionId, lockedSlideIds: active?.lockedSlideIds ?? [],
    createdAt: deck.createdAt, updatedAt: deck.updatedAt,
  };
}

export const getRevisionSpec = (deckId: string, revisionId: string, viewer: DeckViewer): Promise<DeckSpec | null> =>
  shared.getRevisionSpec(initiativeDeckRevisions, () => visibleDeck(deckId, viewer), deckId, revisionId);

// ─── Generation ──────────────────────────────────────────────────────────────

/**
 * `brief` (G55, ≤ 200 characters) is the requester's words ("progress this past
 * sprint"): resolved against the initiative's own sprints into a window
 * (lib/initiative-deck/brief.ts), handed to the drafter as quoted data, quoted
 * in the title slide's notes and the revision summary, and answered back as
 * `brief: { words, window }`. The facts stay the record's.
 */
export async function createDeck(
  projectId: string, body: { title?: unknown; narrative?: unknown; includeBudget?: unknown; brief?: unknown }, viewer: DeckViewer, sub: string | null,
): Promise<Result<{ deckId: string; revisionId: string; includesBudget: boolean; narrative: NarrativeOutcome; brief: DeckBrief | null }>> {
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 120)) {
    return { ok: false, status: 400, reason: 'title must be a string of at most 120 characters' };
  }
  if (body.narrative !== undefined && typeof body.narrative !== 'boolean') return { ok: false, status: 400, reason: 'narrative must be a boolean' };
  if (body.includeBudget !== undefined && typeof body.includeBudget !== 'boolean') return { ok: false, status: 400, reason: 'includeBudget must be a boolean' };
  const said = readBrief(body.brief);
  if (!said.ok) return { ok: false, status: 400, reason: said.reason };
  // Money is read only for a budget-tier caller who did not opt out; never from the body alone.
  const includeBudget = viewer.canReadBudgets && body.includeBudget !== false;
  const source = await loadInitiativeDeckSource(projectId, includeBudget);
  if (!source) return { ok: false, status: 404, reason: `initiative ${projectId} not found` };
  const brief = resolveBrief(said.words, source.sprints, source.asOf);
  const facts = buildInitiativeDeckFacts(source, { ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim() } : {}), brief });

  const requested = body.narrative === true;
  const drafted = await shared.applyNarrative(
    facts, buildInitiativeDraftInput(facts, brief), requested, sub, { tenant: 'orgiq', mode: INITIATIVE_STATUS_DECK_MODE, message: 'Execute initiative status command initiative-status-deck', agentId: DRAFTER_AGENT_ID }, 'Status deck built from the initiative record.',
  );
  const { spec, outcome } = drafted;
  const summary = brief ? `${drafted.summary} ${briefLine(brief)}` : drafted.summary;
  const valid = validateDeckSpec(spec);
  if (!valid.ok) return { ok: false, status: 400, reason: 'the generated deck is not valid', details: { errors: valid.errors } };

  const deckId = initiativeDeckRevisions.newArtifactId();
  const finishCreation = trackInitiativeDeckCreation(deckId);
  try {
    await initiativeDeckStore.insertDeck({ id: deckId, projectId, title: valid.spec.title, includesBudget: includeBudget, createdBy: sub, headRevisionId: null });
    const removeNewMockOrphan = () => {
      if (!config.mock.aurora) return;
      const rows = initiativeDecksFixture.rows();
      const index = rows.findIndex(d => d.id === deckId && d.headRevisionId === null);
      if (index >= 0 && !initiativeDeckRevisionsFixture.rows().some(r => r.deckId === deckId)) rows.splice(index, 1);
    };
    let appended: Awaited<ReturnType<typeof initiativeDeckStore.appendRevision>>;
    try {
      appended = await initiativeDeckStore.appendRevision({
        id: initiativeDeckRevisions.newRevisionId(), deckId, baseRevisionId: null,
        label: requested && outcome.status !== 'unavailable' ? 'Generated with narrative' : 'Generated from initiative',
        spec: valid.spec, lockedSlideIds: [], producedBy: 'generated', createdBy: sub, summary: clip(summary, 800),
      });
    } catch (error) { removeNewMockOrphan(); throw error; }
    if (!appended.ok) { removeNewMockOrphan(); return { ok: false, status: 409, reason: 'the deck changed while it was generated' }; }
    return { ok: true, value: { deckId, revisionId: appended.revision.id, includesBudget: includeBudget, narrative: outcome, brief } };
  } finally { finishCreation(); }
}

// ─── Person edits, preview, file ─────────────────────────────────────────────

export const savePersonRevision = (
  deckId: string, body: { spec?: unknown; baseRevisionId?: unknown; lockedSlideIds?: unknown; label?: unknown },
  viewer: DeckViewer, sub: string | null,
): Promise<Result<DeckRevisionSummary>> =>
  shared.savePersonRevision(initiativeDeckRevisions, () => visibleDeck(deckId, viewer), deckId, body, sub);

export const previewDeck = (deckId: string, spec: unknown, viewer: DeckViewer): Promise<Result<DeckPreviewOut>> =>
  shared.previewDeck(() => visibleDeck(deckId, viewer), spec);

export const renderRevisionFile = (deckId: string, revisionId: string, viewer: DeckViewer): Promise<{ bytes: Buffer; filename: string } | null> =>
  shared.renderRevisionFile(initiativeDeckRevisions, () => visibleDeck(deckId, viewer), deckId, revisionId, 'initiative-status');

// ─── Agent revise (synchronous) ──────────────────────────────────────────────
//
// `POST /:id/revise` (DispatchAgentRun, like a save). The facts are rebuilt from
// the initiative's CURRENT rows with the deck's own budget flag, so a revise of
// a budget deck re-applies money figures only for a budget-tier caller (the
// deck is "not found" to anyone below the tier before this runs).
export const reviseDeck = (
  deckId: string, body: { instruction?: unknown; slideId?: unknown; baseRevisionId?: unknown; requestId?: unknown },
  viewer: DeckViewer, sub: string | null,
): Promise<Result<shared.DeckReviseOut>> =>
  shared.reviseDeckSync<InitiativeDeckRow>({
    tenant: 'orgiq', revisions: initiativeDeckRevisions, lookup: () => visibleDeck(deckId, viewer), deckId, revisionPrefix: 'irev',
    facts: async (deck, base) => {
      const source = await loadInitiativeDeckSource(deck.projectId, deck.includesBudget);
      return source ? buildInitiativeDeckFacts(source, { title: base.title }) : null;
    },
    agentId: DRAFTER_AGENT_ID, sub, body,
  });
