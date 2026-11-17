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
});
