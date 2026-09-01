// The visibility rule for computers — the half of the authorization question
// Cedar's role-wide ManageDevbox does not answer.
//
// canSeeBox is pure, so these are the policy itself rather than a route's
// behaviour: the three shapes of computer × who is asking.

import { canSeeBox, FLEET_WIDE_ROLES, type VisibilityInput } from '../devbox-visibility.js';
import { type FleetBox } from '../devbox-fleet.js';

function box(patch: Partial<FleetBox> = {}): FleetBox {
  return {
    id: 'b1',
    label: 'computer-1',
    sessionId: 's'.repeat(40),
    createdAt: '2026-08-01T00:00:00Z',
    status: 'idle',
    lastActivityAt: '2026-08-01T00:00:00Z',
    ...patch,
  };
}

function who(patch: Partial<VisibilityInput> = {}): VisibilityInput {
  return { sub: 'u-nora', role: 'sme', attachedInitiatives: new Set(), ...patch };
}

describe('canSeeBox', () => {
  describe('personal — an owner, no project', () => {
    const personal = box({ ownerId: 'u-nora' });

    it('is visible to its owner', () => {
      expect(canSeeBox(personal, who({ sub: 'u-nora' }))).toBe(true);
    });

    it('is hidden from another SME, even one on the same initiatives', () => {
      expect(canSeeBox(personal, who({
        sub: 'u-eli',
        attachedInitiatives: new Set(['p-observability']),
      }))).toBe(false);
    });
  });

  describe('shared — charged to an initiative', () => {
    const shared = box({ ownerId: 'u-nora', projectId: 'p-observability' });

    it('is visible to anyone attached to that initiative', () => {
      expect(canSeeBox(shared, who({
        sub: 'u-eli',
        attachedInitiatives: new Set(['p-observability']),
      }))).toBe(true);
    });

    it('is hidden from an SME attached to different initiatives', () => {
      expect(canSeeBox(shared, who({
        sub: 'u-eli',
        attachedInitiatives: new Set(['p-auth-migration']),
      }))).toBe(false);
    });

    it('the project wins over the owner — being on the initiative is enough', () => {
      // Nobody needs to be the provisioner to use a shared computer. That is
      // the difference between "shared" and "mine that others may look at".
      expect(canSeeBox(shared, who({
        sub: 'u-someone-else',
        attachedInitiatives: new Set(['p-observability']),
      }))).toBe(true);
    });

    it('the owner does NOT keep access once it is shared elsewhere', () => {
      // The provisioner who leaves the initiative loses the computer with it.
      // Ownership is who paid for it, not a standing grant.
      expect(canSeeBox(shared, who({ sub: 'u-nora', attachedInitiatives: new Set() })))
        .toBe(false);
    });
  });

  describe('unattributed — neither owner nor project', () => {
    const orphan = box();

    it('is hidden from an SME', () => {
      expect(canSeeBox(orphan, who())).toBe(false);
    });

    it.each(FLEET_WIDE_ROLES)('is visible to %s', (role) => {
      expect(canSeeBox(orphan, who({ role }))).toBe(true);
    });
  });

  describe('fleet-wide roles', () => {
    it.each(FLEET_WIDE_ROLES)('%s sees a computer belonging to someone else', (role) => {
      expect(canSeeBox(box({ ownerId: 'u-nora' }), who({ sub: 'u-other', role }))).toBe(true);
    });

    it('does not include sme — that is the whole point', () => {
      expect(FLEET_WIDE_ROLES).not.toContain('sme');
    });

    it('does not include member', () => {
      expect(FLEET_WIDE_ROLES).not.toContain('member');
    });
  });

  describe('no session', () => {
    it('sees nothing, even a computer with no owner', () => {
      expect(canSeeBox(box(), who({ sub: null, role: null }))).toBe(false);
    });

    it('sees nothing owned by anyone', () => {
      expect(canSeeBox(box({ ownerId: 'u-nora' }), who({ sub: null, role: null }))).toBe(false);
    });
  });
});
