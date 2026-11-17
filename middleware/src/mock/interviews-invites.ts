// The invites fixture (docs/interviews-tenant-plan.md, row I2.1): the mock world's interview_invites table.
//
// The seed holds no invite: a link is a secret a recruiter makes on purpose, so the walk makes one by request
// and resets the world after. Registered from its own module (lib/interviews/invite/store.ts imports it), so
// mock/interviews.ts and the rows the earlier walk pieces count are untouched. `POST /api/__mock/reset`
// empties it like every other fixture.
import { defineFixture } from './core/index.js';
import type { Invite } from '../lib/interviews/invite/store.js';

export const interviewInvitesFixture = defineFixture<Invite>({
  key: 'interviews.invites',
  scenarios: { default: () => [] },
});
