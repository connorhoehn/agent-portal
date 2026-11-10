// readsSocialBindings asks exactly the binding read's gate (ViewSocial with a
// grant in orgiq), and any refusal or error is "no": a /comment then follows
// the pane that viewer sees (sweep 12 L2's edge: membership outlives a grant).
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, region: 'us-east-1', aurora: {} } }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
const mockAuthority = jest.fn();
jest.mock('../social-authority.js', () => ({ currentSocialAuthority: (...args: unknown[]) => mockAuthority(...args) }));

import { readsSocialBindings } from '../initiative-discussion.js';
import type { Session } from '../session.js';

const session = { sub: 'u-mira', tenant: 'orgiq', role: 'member', grants: { orgiq: ['member'] } } as unknown as Session;

beforeEach(() => mockAuthority.mockReset());

it('asks the binding read\'s own gate', async () => {
  mockAuthority.mockResolvedValue(session);
  await expect(readsSocialBindings(session)).resolves.toBe(true);
  expect(mockAuthority).toHaveBeenCalledWith(session, 'ViewSocial', { grantIn: 'orgiq' });
});

it('a refusal (no Social grant, or none in orgiq) is false', async () => {
  mockAuthority.mockRejectedValue(Object.assign(new Error('Your Social grants do not allow this action'), { status: 403 }));
  await expect(readsSocialBindings(session)).resolves.toBe(false);
});

it('a directory outage is false too: the strict reading', async () => {
  mockAuthority.mockRejectedValue(new Error('directory unavailable'));
  await expect(readsSocialBindings(session)).resolves.toBe(false);
});
