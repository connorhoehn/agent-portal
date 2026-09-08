// The Sprints page and the Grants table must agree about the same envelope.
//
// THE BUG THIS PINS (mock mode, dev:mock — what the portal actually runs):
// PATCH a grant and `/api/grants` reported the new amount while `/api/sprints`
// kept reporting the old one. Both were "working"; they were reading different
// things. providers/grants.ts keeps mutations in an OVERLAY and treats
// budgets.MOCK_GRANTS as a read-only seed, but the sprint rollup read the raw
// seed — so every create, patch and revoke was invisible to it.
//
// The cause was structural rather than careless: grants.ts imports getSprint
// from sprints.ts, so sprints.ts could not import the overlay back without
// closing a cycle, and a comment recorded that as the reason. The overlay now
// lives in providers/grantOverlay.ts, which imports neither of them.
//
// These tests go through the PUBLIC provider functions in mock mode, so they
// fail if the rollup ever reads the seed directly again — which is the mistake
// worth catching, not the specific arithmetic.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import { MOCK_GRANTS } from '../budgets.js';
import { listSprints } from '../sprints.js';
import { updateGrant, createGrant, revokeGrant } from '../grants.js';
import { _resetMockGrants } from '../grantOverlay.js';

beforeEach(() => _resetMockGrants());
afterEach(() => _resetMockGrants());

/** The sprint rollup's view of one sprint's envelope. */
async function envelopeOf(sprintId: string): Promise<{ grantedUsd: number; grantCount: number }> {
  const rows = await listSprints({ sprintId });
  const row = rows.find((r) => r.id === sprintId);
  if (!row) throw new Error(`sprint ${sprintId} not in mock fixtures`);
  return { grantedUsd: row.grantedUsd, grantCount: row.grantCount };
}

/** The envelope a sprint carries in the SEED — read from the fixture's own rows
 *  rather than typed, so it cannot drift from mock/budgets.ts. Callers use it
 *  as the "before" of a mutation without having to snapshot one first. */
function seedEnvelopeOf(sprintId: string): number {
  return MOCK_GRANTS.filter((g) => g.sprintId === sprintId).reduce((n, g) => n + g.allocatedUsd, 0);
}

/** A seed grant that is scoped to a sprint the mock sprint list also carries. */
function aSeededGrant() {
  const g = MOCK_GRANTS.find((x) => x.sprintId != null);
  if (!g) throw new Error('no seeded grant carries a sprintId');
  return g;
}

describe('a grant mutation is visible to the sprint rollup', () => {
  it('reflects a PATCHed amount, rather than the seed value', async () => {
    const seed = aSeededGrant();
    const sprintId = seed.sprintId!;
    const before = await envelopeOf(sprintId);

    // Move the envelope by a distinctive amount so the assertion cannot pass by
    // coincidence with some other seeded number.
    const delta = 1234;
    const patched = await updateGrant(seed.id, { amountUsd: seed.allocatedUsd + delta });
    expect(patched).not.toBeNull();

    const after = await envelopeOf(sprintId);
    expect(after.grantedUsd).toBe(before.grantedUsd + delta);
    // The count is unchanged — a patch is not a new envelope.
    expect(after.grantCount).toBe(before.grantCount);
  });

  it('counts a newly created grant', async () => {
    const seed = aSeededGrant();
    const sprintId = seed.sprintId!;
    const before = await envelopeOf(sprintId);

    await createGrant({
      orgProjectId: seed.orgProjectId,
      sprintId,
      granteePersonId: seed.granteePersonId,
      amountUsd: 500,
    });

    const after = await envelopeOf(sprintId);
    expect(after.grantCount).toBe(before.grantCount + 1);
    expect(after.grantedUsd).toBe(before.grantedUsd + 500);
  });

  it('drops a revoked grant from the envelope', async () => {
    const seed = aSeededGrant();
    const sprintId = seed.sprintId!;
    const before = await envelopeOf(sprintId);

    expect(await revokeGrant(seed.id)).toBe(true);

    const after = await envelopeOf(sprintId);
    expect(after.grantCount).toBe(before.grantCount - 1);
    expect(after.grantedUsd).toBe(before.grantedUsd - seed.allocatedUsd);
  });

  // The seed used to be a read-only array with an overlay Map on top, and this
  // case pinned "the array is never mutated in place". That invariant is gone
  // ON PURPOSE: the seed is a REGISTERED fixture now (`budget-grants`), so a
  // patch writes straight into it and the reset — the same one
  // `POST /api/__mock/reset` performs — is what puts it back. The overlay only
  // ever existed because nothing could restore the seed. What has to hold is
  // the stronger claim: the mutation is visible everywhere, and it is undoable.
  it('writes through to the fixture, and a reset puts the seed back', async () => {
    const seed = aSeededGrant();
    const original = seed.allocatedUsd;
    const seededEnvelope = seedEnvelopeOf(seed.sprintId!);

    await updateGrant(seed.id, { amountUsd: original + 99 });

    // Visible in the table itself, not parked in a side Map beside it.
    expect(MOCK_GRANTS.find((g) => g.id === seed.id)?.allocatedUsd).toBe(original + 99);
    expect((await envelopeOf(seed.sprintId!)).grantedUsd).toBe(seededEnvelope + 99);

    // ...and the reset puts both back where they started.
    _resetMockGrants();
    expect(MOCK_GRANTS.find((g) => g.id === seed.id)?.allocatedUsd).toBe(original);
    expect((await envelopeOf(seed.sprintId!)).grantedUsd).toBe(seededEnvelope);
  });

  it('drops a created grant on reset, so a create is replayable', async () => {
    const seed = aSeededGrant();
    const sprintId = seed.sprintId!;
    const before = await envelopeOf(sprintId);

    const created = await createGrant({
      orgProjectId: seed.orgProjectId,
      sprintId,
      granteePersonId: seed.granteePersonId,
      amountUsd: 77,
    });
    expect(MOCK_GRANTS.some((g) => g.id === created.id)).toBe(true);

    _resetMockGrants();
    expect(MOCK_GRANTS.some((g) => g.id === created.id)).toBe(false);
    expect(await envelopeOf(sprintId)).toEqual(before);
  });

  it('brings a revoked grant back on reset', async () => {
    const seed = aSeededGrant();
    const before = await envelopeOf(seed.sprintId!);

    expect(await revokeGrant(seed.id)).toBe(true);
    expect(MOCK_GRANTS.some((g) => g.id === seed.id)).toBe(false);

    _resetMockGrants();
    expect(MOCK_GRANTS.some((g) => g.id === seed.id)).toBe(true);
    expect(await envelopeOf(seed.sprintId!)).toEqual(before);
  });
});
