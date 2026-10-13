// The request discussion's admission (lib/access/thread.ts, reached through
// lib/page-resources.ts `access-request`): the REST read rule of
// GET /api/access/requests/:id, asked for one reader against the directory
// and the store NOW. The real memory identity provider and the registered
// access fixtures — the gateway's family half (standing in `access`,
// ViewAccess) is pinned by lib/gateway/__tests__/authority-facade.test.ts.

jest.mock('../../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { policyStoreId: undefined, sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import { pageResourceVisible } from '../../page-resources.js';
import { requestIdOfThread } from '../thread.js';
import { setGrants } from '../../../providers/identity.js';
import { accessEventsFixture, accessRequestsFixture, accessStepsFixture } from '../../../mock/access-requests.js';
import { identityGrantWritesFixture } from '../../../mock/identity-grants.js';

const reads = (reader: string | undefined, thread = 'access:req:req-0001') => pageResourceVisible('access-request', thread, reader);

beforeEach(() => { for (const f of [accessRequestsFixture, accessStepsFixture, accessEventsFixture, identityGrantWritesFixture]) f.reset(); });

it('names a request only in the family\'s shape', () => {
  expect(requestIdOfThread('access:req:req-0001')).toBe('req-0001');
  expect(requestIdOfThread('access:req:nope')).toBeNull();
  expect(requestIdOfThread('orgiq:work:req-0001')).toBeNull();
});

it('admits the requester, the beneficiary\'s manager / live approver and the access admins', async () => {
  expect(await reads('u-rhea')).toBe(true);     // requester and beneficiary
  expect(await reads('u-omar')).toBe(true);     // her manager, eligible on step 1 now
  expect(await reads('u-priya')).toBe(true);    // access-admin (and the escalated steward)
  expect(await reads('u-operator')).toBe(true); // the cross-tenant admin's access grant
});

it('refuses everyone else, an unknown request, and a call with no reader', async () => {
  expect(await reads('u-nora')).toBe(false);
  expect(await reads('u-dara')).toBe(false);
  expect(await reads('u-nobody')).toBe(false);
  expect(await reads('u-rhea', 'access:req:req-0004')).toBe(false); // Nora's grant: not Rhea's to read
  expect(await reads('u-nora', 'access:req:req-0004')).toBe(true);  // …but it is Nora's own
  expect(await reads('u-priya', 'access:req:req-9999')).toBe(false);
  expect(await reads('u-priya', 'access:req:nope')).toBe(false);
  expect(await reads(undefined)).toBe(false);
});

it('is live: an access admin who loses the grant is refused on the next decision', async () => {
  expect(await reads('u-priya')).toBe(true);
  await setGrants('u-priya', {});
  expect(await reads('u-priya')).toBe(false);
});
