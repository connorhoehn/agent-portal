// A mock reset brings a removed seeded résumé back (row I1.6's 404 table runs after every piece, and row I6.3 removes Mateo's file).
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { MemoryResumeBytes } from '../bytes-store.js';
import { resetMockResumeBytes, setResumeStores, resumeBytes } from '../service.js';

const SEEDED = 'interviews/resumes/cand-rx6tcaqj/rf-rx6tcaqj.pdf';
const UPLOAD = 'interviews/resumes/cand-9p2atayb/rf-new.pdf';

describe('the memory résumé store across a mock reset', () => {
  afterEach(() => setResumeStores({ bytes: null }));

  it('a removed seeded file comes back and an upload goes', async () => {
    const s = new MemoryResumeBytes();
    setResumeStores({ bytes: s });
    await s.remove(SEEDED);
    await s.put(UPLOAD, Buffer.from('%PDF-1.4 fake'));
    expect(await s.get(SEEDED)).toBeNull();
    resetMockResumeBytes();
    expect(await resumeBytes().get(SEEDED)).not.toBeNull();
    expect(await resumeBytes().get(UPLOAD)).toBeNull();
  });

  it('does nothing to a store that is not the memory one', () => {
    const other = { put: jest.fn(), get: jest.fn(), remove: jest.fn() };
    setResumeStores({ bytes: other });
    expect(() => resetMockResumeBytes()).not.toThrow();
    expect(other.remove).not.toHaveBeenCalled();
  });
});
