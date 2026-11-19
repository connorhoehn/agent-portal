jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { clearExportSections, exportSections, registerExportSection } from '../registry.js';
import { buildMiloExport } from '../service.js';
import type { Interview } from '../../types.js';

const interview = { id: 'iv-x', applicationId: 'app-x', roundId: 'rd-x', type: 'technical', minutes: 45, scheduledAt: null, endedAt: null, state: 'ended' } as Interview;
const ctx = { interview, candidateId: 'cand-x', openingId: 'op-x', roundName: 'Coding' };

describe('the export service', () => {
  afterEach(() => clearExportSections());

  it('registering a key twice keeps the later one', () => {
    registerExportSection({ key: 'a', read: async () => 1 });
    registerExportSection({ key: 'a', read: async () => 2 });
    expect(exportSections().filter((s) => s.key === 'a')).toHaveLength(1);
  });

  it('writes every section by key, the candidate by id, and an error code for a section that throws', async () => {
    registerExportSection({ key: 'ok', read: async (id) => ({ id }) });
    registerExportSection({ key: 'bad', read: async () => { throw new Error('secret detail'); } });
    const doc = await buildMiloExport(ctx, new Date('2026-11-17T10:00:00Z'));
    expect(doc.sections['ok']).toEqual({ id: 'iv-x' });
    expect(doc.sections['bad']).toEqual({ error: 'unavailable' });
    expect(JSON.stringify(doc)).not.toContain('secret detail');
    expect(doc.interview).toMatchObject({ candidateId: 'cand-x', round: { name: 'Coding' }, state: 'ended' });
    expect(doc.exportedAt).toBe('2026-11-17T10:00:00.000Z');
  });

  it('carries the competencies the round assesses, and none when the opening could not be read', async () => {
    const named = await buildMiloExport({ ...ctx, competencies: [{ id: 'problem-solving', name: 'Problem solving' }] });
    expect(named.interview.round.competencies).toEqual([{ id: 'problem-solving', name: 'Problem solving' }]);
    expect((await buildMiloExport(ctx)).interview.round.competencies).toEqual([]);
  });
});

// Lane H5 (OWED O-164, O-270): the export over the mock world's seeded stores, with the sections as the route registers them.
describe('the export of a seeded interview (row I6.2)', () => {
  const MATEO_CODING = 'iv-j6x2d9sb';
  const SAID_TEXT = 'Milo asked this out loud: describe the bucket refill.';
  let doc: (id: string) => Promise<import('../service.js').MiloExport>;

  beforeEach(async () => {
    const { fixtureRegistry } = await import('../../../../mock/core/index.js');
    fixtureRegistry.resetAll('default');
    const { exportNotices, exportSaidLog, exportSuggestions } = await import('../sections.js');
    const { exportRecap } = await import('../../recap/index.js');
    const { exportCoachLog } = await import('../../milo-notes/index.js');
    const { exportPanelNotices } = await import('../../consent/panel-notice.js');
    clearExportSections();
    registerExportSection({ key: 'suggestions', read: exportSuggestions });
    registerExportSection({ key: 'notices', read: exportNotices });
    registerExportSection({ key: 'recap', read: exportRecap });
    registerExportSection({ key: 'milo-for-you', read: exportCoachLog });
    registerExportSection({ key: 'panel-notices', read: exportPanelNotices });
    registerExportSection({ key: 'said-aloud', read: exportSaidLog });
    const { interviewsStore } = await import('../../store-select.js');
    doc = async (id) => {
      const iv = (await interviewsStore().listInterviews()).find((i) => i.id === id)!;
      return buildMiloExport({ interview: iv, candidateId: 'cand-rx6tcaqj', openingId: 'op-backend', roundName: 'Coding' }, new Date('2026-11-17T10:00:00Z'));
    };
  });
  afterEach(async () => {
    const { fixtureRegistry } = await import('../../../../mock/core/index.js');
    const { setSaidStore } = await import('../../speak/index.js');
    fixtureRegistry.resetAll('default');
    setSaidStore(null);
  });

  it('an erased interview exports every section by name, each empty; the staff\'s own notice acknowledgements stay', async () => {
    const before = await doc(MATEO_CODING);
    expect((before.sections['suggestions'] as { suggestions: unknown[] }).suggestions.length).toBeGreaterThan(0);
    expect((before.sections['notices'] as { answers: unknown }).answers).not.toBeNull();
    await import('../../retention/service.js');
    const { erasersOf } = await import('../../retention/registry.js');
    for (const e of [...erasersOf('record'), ...erasersOf('media').filter((m) => m.kind === 'pad-log' || m.kind === 'runs')]) await e.erase([MATEO_CODING]);
    const after = await doc(MATEO_CODING);
    expect(Object.keys(after.sections).sort()).toEqual(['milo-for-you', 'notices', 'panel-notices', 'recap', 'said-aloud', 'suggestions']);
    expect(after.sections['suggestions']).toEqual({ suggestions: [], dropped: {} });
    expect(after.sections['said-aloud']).toEqual({ lines: [] });
    expect(after.sections['notices']).toEqual({ notice: null, answers: null });
    expect(after.sections['recap']).toEqual({ recap: null, opens: [] });
    expect(after.sections['milo-for-you']).toEqual({ rows: [] });
    // The panel's acknowledgements are the staff's own record of reading the notice, not the candidate's: no eraser takes them.
    expect(after.sections['panel-notices']).toMatchObject({ interviewId: MATEO_CODING });
    expect(after.interview).toMatchObject({ id: MATEO_CODING, candidateId: 'cand-rx6tcaqj' });
    expect(JSON.stringify(after)).not.toMatch(/Mateo/);
  });

  it('a notice answered under an older version keeps its version and day, with textKept false and no text (O-162)', async () => {
    const { interviewConsentsFixture } = await import('../../../../mock/interviews-consents.js');
    const row = interviewConsentsFixture.rows().find((c) => c.interviewId === MATEO_CODING)!;
    row.noticeVersion = '2025-03-01.2';
    const notices = (await doc(MATEO_CODING)).sections['notices'] as { notice: Record<string, unknown>; answers: unknown };
    expect(notices.notice).toEqual({ version: '2025-03-01.2', title: null, paragraphs: null, textKept: false });
    expect(notices.answers).not.toBeNull();
  });

  it('what Milo said aloud (the said log) is its own section: each line with its time and kind, the candidate never by guest id (O-270)', async () => {
    const { MemorySaidStore, setSaidStore, saidStore } = await import('../../speak/index.js');
    setSaidStore(new MemorySaidStore());
    await saidStore().append({
      id: 'said-x', interviewId: MATEO_CODING, callId: null, kind: 'question', source: 'kit', questionId: 'q-limiter', suggestionId: null,
      text: SAID_TEXT, askedBy: 'u-hugo', saidAt: '2026-11-14T14:12:00.000Z', posted: true, spoken: true,
    });
    await saidStore().append({
      id: 'said-y', interviewId: MATEO_CODING, callId: null, kind: 'answer', source: 'time', questionId: null, suggestionId: null,
      text: 'About 20 minutes are left.', askedBy: 'guest:inv-abc123', saidAt: '2026-11-14T14:20:00.000Z', posted: true, spoken: false,
    });
    const out = await doc(MATEO_CODING);
    expect(Object.keys(out.sections).sort()).toEqual(['milo-for-you', 'notices', 'panel-notices', 'recap', 'said-aloud', 'suggestions']);
    expect(out.sections['said-aloud']).toEqual({ lines: [
      { id: 'said-x', saidAt: '2026-11-14T14:12:00.000Z', kind: 'question', source: 'kit', text: SAID_TEXT, spoken: true, questionId: 'q-limiter', suggestionId: null, askedBy: { side: 'panel', id: 'u-hugo' } },
      { id: 'said-y', saidAt: '2026-11-14T14:20:00.000Z', kind: 'answer', source: 'time', text: 'About 20 minutes are left.', spoken: false, questionId: null, suggestionId: null, askedBy: { side: 'candidate' } },
    ] });
    expect(JSON.stringify(out)).not.toContain('guest:');
  });
});
