// Aurora half of the initiative status deck store: parameterized SQL, the CAS
// append as ONE statement, the budget flag on the row; plus narrative
// validation over initiative facts and budget-tier redaction in the facts.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: false, agentcore: false }, auth: {} } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn() }));

import { exec } from '../aurora.js';
import { initiativeDeckStore } from '../initiative-decks.js';
import { buildInitiativeDeckFacts, buildInitiativeDraftInput, type InitiativeDeckSource } from '../../lib/initiative-deck/facts.js';
import { mergeDraft } from '../../lib/deck-shared/narrative.js';
import type { WorkItem } from '../work-items.js';

const execMock = exec as unknown as jest.Mock;
const SPEC = { title: 'T', slides: [{ id: 'a', layout: 'bullets' as const, title: 'A', bullets: ['b'], sources: [{ documentId: 'initiative:p-1', title: 'S' }] }] };
const REV = { id: 'irev-1', deckId: 'idk-1', baseRevisionId: 'irev-0', label: 'Edited', spec: SPEC, lockedSlideIds: [], producedBy: 'person:u-a', createdBy: 'u-a', summary: null };

afterEach(() => execMock.mockReset());

describe('initiative deck store (Aurora)', () => {
  it('appends with one parameterized compare-and-set statement', async () => {
    execMock.mockResolvedValueOnce([{ id: 'irev-1', deck_id: 'idk-1', seq: 2, base_revision_id: 'irev-0', label: 'Edited',
      locked_slide_ids: '[]', produced_by: 'person:u-a', created_by: 'u-a', summary: null, created_at: '2026-10-06T12:00:00.000Z' }]);
    const result = await initiativeDeckStore.appendRevision(REV);
    expect(result).toMatchObject({ ok: true, revision: { id: 'irev-1', seq: 2, spec: SPEC } });
    const [sql] = execMock.mock.calls[0]!;
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(sql).toMatch(/UPDATE initiative_decks SET head_revision_id = :id/);
    expect(sql).toMatch(/head_revision_id IS NOT DISTINCT FROM CAST\(:base_revision_id AS TEXT\)/);
    expect(sql).toMatch(/INSERT INTO initiative_deck_revisions/);
    expect(sql).not.toContain('irev-0');
  });

  it('a stale base inserts nothing and reports the current head', async () => {
    execMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'idk-1', project_id: 'p-1', title: 'T', includes_budget: false, created_by: null, created_at: 'x', updated_at: 'x', head_revision_id: 'irev-9' }]);
    expect(await initiativeDeckStore.appendRevision(REV)).toEqual({ ok: false, reason: 'conflict', head: 'irev-9' });
  });

  it('inserts the deck with its budget flag as a boolean parameter and reads it back', async () => {
    execMock.mockResolvedValueOnce([{ id: 'idk-1', project_id: 'p-1', title: 'T', includes_budget: true, created_by: 'u-a', created_at: 'c', updated_at: 'u', head_revision_id: null }]);
    const row = await initiativeDeckStore.insertDeck({ id: 'idk-1', projectId: 'p-1', title: 'T', includesBudget: true, createdBy: 'u-a', headRevisionId: null });
    expect(row.includesBudget).toBe(true);
    const [sql, params] = execMock.mock.calls[0]!;
    expect(sql).toMatch(/INSERT INTO initiative_decks \(id, project_id, title, includes_budget, created_by\)/);
    expect(params).toContainEqual({ name: 'includes_budget', value: { booleanValue: true } });
  });

  it('lists by project with a bound parameter', async () => {
    execMock.mockResolvedValueOnce([]);
    await initiativeDeckStore.listDecks('p-1');
    const [sql, params] = execMock.mock.calls[0]!;
    expect(sql).toMatch(/WHERE project_id = :project_id/);
    expect(sql).not.toContain('p-1');
    expect(params).toEqual([{ name: 'project_id', value: { stringValue: 'p-1' } }]);
  });
});

const item = (over: Partial<WorkItem>): WorkItem => ({
  id: 'wi-1', projectId: 'p-1', projectName: 'Pilot', parentId: null, type: 'story', title: 'Ship it', description: null,
  status: 'open', priority: 'high', assigneeId: null, assigneeName: null, assigneeDept: null, labels: [], storyPoints: 3,
  summary: null, blockedReason: 'waiting on the key rotation window', nextStep: null, nextStepDetail: null, blockedByDecisionId: null, runbookPins: [], sprintId: null, estimatedCostUsd: 1.25,
  estimatedBy: null, estimatedByName: null, estimatedAt: null, estimateModel: null, estimateForecast: null,
  estimateReviewedBy: null, estimateReviewedByName: null, estimateReviewedAt: null, prUrl: null, prStatus: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', completedAt: null, childCount: 0, childDoneCount: 0, ...over,
});

const SOURCE: InitiativeDeckSource = {
  project: { id: 'p-1', name: 'Pilot', status: 'in_progress', summary: 'Moves auth off the legacy gateway.', ownerName: 'Ana', sponsorName: null, repoFullName: null },
  asOf: '2026-10-06',
  workItems: [item({}), item({ id: 'wi-2', status: 'done', storyPoints: 5, estimatedCostUsd: 2 })],
  sprints: [], decisions: [],
  budget: { period: 'monthly', allocatedUsd: 100, spentThisPeriodUsd: 40.5, runCountThisPeriod: 3, maintenance30dUsd: 12.34, cronRuns30d: 6 },
  grants: [],
};

describe('initiative deck facts', () => {
  it('states the rows; the budget slide appears only with the budget tier', () => {
    const withBudget = buildInitiativeDeckFacts(SOURCE);
    expect(withBudget.slides.find((s) => s.slideId === 'summary')!.facts).toMatchObject({ workItems: 2, open: 1, done: 1, pointsDone: 5, pointsTotal: 8, openEstimateUsd: '$1.25' });
    const budget = withBudget.spec.slides.find((s) => s.id === 'budget')!;
    expect(budget.bullets).toContain('Monthly allocation: $100.00');
    expect(budget.bullets).toContain('Spent this period: $40.50 across 3 runs');
    expect(budget.bullets).toContain('Maintenance floor, last 30 days: $12.34 across 6 cron runs');
    expect(budget.bullets).toContain('Floor against allocation: 12.3% of the monthly allocation');

    const redacted = buildInitiativeDeckFacts({ ...SOURCE, budget: null, grants: null });
    expect(redacted.spec.slides.map((s) => s.id)).not.toContain('budget');
    expect(JSON.stringify(redacted.spec)).not.toMatch(/\$100\.00|\$40\.50|\$12\.34|allocation/i);
  });

  it('a verbatim span is used; a non-verbatim span or invented number falls back to the template', () => {
    const facts = buildInitiativeDeckFacts({ ...SOURCE, budget: null, grants: null });
    expect(buildInitiativeDraftInput(facts).slides.map((s) => s.slideId)).toEqual(['summary']);
    const evidenceId = facts.slides.find((s) => s.slideId === 'summary')!.evidence[0]!.id;
    const good = { slideId: 'summary', bullets: ['Auth is moving off the legacy gateway.'], source_spans: [{ evidenceId, text: 'Moves auth off the legacy gateway.' }] };
    const badSpan = { slideId: 'summary', bullets: ['x'], source_spans: [{ evidenceId, text: 'moves everything to the new gateway' }] };
    const badNumber = { slideId: 'summary', bullets: ['11 items remain.'], source_spans: [{ evidenceId, text: 'Moves auth off the legacy gateway.' }] };
    expect(mergeDraft(facts, { narratives: [good] }).templated).toEqual([]);
    expect(mergeDraft(facts, { narratives: [badSpan] }).templated).toEqual(['summary']);
    expect(mergeDraft(facts, { narratives: [badNumber] }).templated).toEqual(['summary']);
  });
});
