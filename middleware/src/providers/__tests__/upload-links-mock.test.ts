// listUploadLinks (providers/upload-links.ts) — the offline read, and the
// reason it stopped being `[]`.
//
// This file used to pin "returns [] under MOCK_AURORA, without touching the
// Data API". That was honest while nothing offline could mint a link: the
// whole provider reached `exec` unguarded, so "no links" was the whole truth
// and the panel's own empty state covered it.
//
// It stopped being true the moment `createUploadLink` got a fixture to write
// into. A create that answers 201 over a list that still says none is a write
// that reports success and cannot be seen — the exact failure the mock floor
// exists to remove. So the contract pinned here is now the stronger one: the
// list reads the same rows the writes move, and still never touches the wire.
//
// The behavioural cover for minting, revoking, resolving a token and accepting
// a file lives in `src/mock/__tests__/kb-surface-offline.test.ts`, under a
// frozen clock.

const mockFlag = { value: true };

jest.mock('../../config.js', () => ({
  config: { get mock() { return { aurora: mockFlag.value }; } },
}));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../landing-zones.js', () => ({ uploadToLandingZone: jest.fn() }));

import { exec } from '../aurora.js';
import { createUploadLink, listUploadLinks, revokeUploadLink } from '../upload-links.js';
import { uploadLinks } from '../../mock/upload-links.js';

const execMock = exec as unknown as jest.Mock;

beforeEach(() => {
  mockFlag.value = true;
  execMock.mockReset();
  uploadLinks.reset();
});

describe('listUploadLinks (mock)', () => {
  it('serves the fixture rows without touching the Data API', async () => {
    const links = await listUploadLinks();
    expect(links).toHaveLength(uploadLinks.rows().length);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('filters by kbSlug, as the WHERE clause does', async () => {
    const all = await listUploadLinks();
    const scoped = await listUploadLinks('orgiq-onboarding');
    expect(scoped.length).toBeLessThan(all.length);
    expect(scoped.every((l) => l.kbSlug === 'orgiq-onboarding')).toBe(true);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('shows a link the offline create just minted', async () => {
    const before = (await listUploadLinks('orgiq-onboarding')).length;
    const { link } = await createUploadLink({ kbSlug: 'orgiq-onboarding', label: 'New partner' });
    const after = await listUploadLinks('orgiq-onboarding');
    expect(after).toHaveLength(before + 1);
    expect(after.map((l) => l.id)).toContain(link.id);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('reflects a revoke in the derived status', async () => {
    const { link } = await createUploadLink({ kbSlug: 'orgiq-onboarding', label: 'Short-lived' });
    await revokeUploadLink(link.id);
    const after = (await listUploadLinks()).find((l) => l.id === link.id);
    expect(after?.status).toBe('revoked');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('reset takes the mint back', async () => {
    const before = (await listUploadLinks()).length;
    await createUploadLink({ kbSlug: 'orgiq-onboarding', label: 'Temporary' });
    uploadLinks.reset();
    expect(await listUploadLinks()).toHaveLength(before);
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
