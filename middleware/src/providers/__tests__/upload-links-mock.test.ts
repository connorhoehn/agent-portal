// listUploadLinks (providers/upload-links.ts) — regression cover for a
// transitive break: fixing the KB registry to return real fixture KBs (this
// sweep) means KnowledgeHomePage's ShareLinks widget now has a real kbSlug to
// query, and GET /api/admin/kb-registry/upload-links?kbSlug=... had no
// try/catch and no mock branch of its own. Pins that it returns [] under
// MOCK_AURORA rather than reaching exec() at all.

const mockFlag = { value: true };

jest.mock('../../config.js', () => ({
  config: { get mock() { return { aurora: mockFlag.value }; } },
}));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../landing-zones.js', () => ({ uploadToLandingZone: jest.fn() }));

import { exec } from '../aurora.js';
import { listUploadLinks } from '../upload-links.js';

const execMock = exec as unknown as jest.Mock;

beforeEach(() => {
  mockFlag.value = true;
  execMock.mockReset();
});

describe('listUploadLinks (mock)', () => {
  it('returns [] without touching the Data API', async () => {
    const links = await listUploadLinks('orgiq-default');
    expect(links).toEqual([]);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('listUploadLinks (real path, mock off)', () => {
  it('still calls exec when config.mock.aurora is false', async () => {
    mockFlag.value = false;
    execMock.mockResolvedValue([]);
    await listUploadLinks('orgiq-default');
    expect(execMock).toHaveBeenCalled();
  });
});
