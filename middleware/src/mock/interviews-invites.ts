// The invites fixture (docs/interviews-tenant-plan.md, row I2.1): the mock world's interview_invites table.
//
// One invite is seeded: the link Greta sent Kwame for his coding round, live now (mock/interviews.ts
// LIVE_INTERVIEW_ID). He opened it yesterday and has not knocked yet. Every other link is made on purpose by a
// walk, which resets the world after. The token is a made-up string that exists only here, so the row is
// there to be read (the desk's invite state, a lead's room) and the link itself is not handed out. Registered from
// its own module (lib/interviews/invite/store.ts imports it). `POST /api/__mock/reset` restores it.
import { clock, defineFixture } from './core/index.js';
import type { Invite } from '../lib/interviews/invite/store.js';
import { inviteCeiling } from '../lib/interviews/invite/rules.js';
import { hashInviteToken } from '../lib/interviews/invite/token.js';
import { GRETA, LIVE_INTERVIEW_ID } from './interviews.js';

export const interviewInvitesFixture = defineFixture<Invite>({
  key: 'interviews.invites',
  scenarios: {
    default: () => [
      { id: 'inv-seed-kwame-coding', interviewId: LIVE_INTERVIEW_ID, tokenHash: hashInviteToken('seed-only-kwame-coding-round'),
        issuedBy: GRETA, issuedAt: clock.daysAgo(2), expiresAt: inviteCeiling(clock.daysAgo(2)),
        revokedAt: null, revokedBy: null, firstOpenedAt: clock.daysAgo(1), lastOpenedAt: clock.daysAgo(1), openCount: 1,
        sessionHash: null, admissionState: 'not-knocked', knockedAt: null, admissionDecidedAt: null },
    ],
    empty: () => [],
  },
});
