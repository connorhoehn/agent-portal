// The coach reads only the competencies a round assesses (kit.ts competenciesOfRound; docs/interviews-tenant-plan.md
// decision 22). Kept out of coach/__tests__ so the coach's own suites stay as they are.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { fixtureRegistry } from '../../../mock/core/index.js';
import { interviewApplicationsFixture, interviewOpeningsFixture, interviewsFixture } from '../../../mock/interviews.js';
import { coachInput } from '../coach/service.js';

afterEach(() => fixtureRegistry.resetAll('default'));

const refOf = (id: string) => {
  const interview = interviewsFixture.rows().find((i) => i.id === id)!;
  const app = interviewApplicationsFixture.rows().find((a) => a.id === interview.applicationId)!;
  return { interview, opening: interviewOpeningsFixture.rows().find((o) => o.id === app.openingId)! };
};

describe('the coach chooses a competency from the round only', () => {
  it('a coding round offers problem solving, code quality and communication, never system design', () => {
    const input = coachInput(refOf('iv-s4e8u2zk'), [], []);
    expect(input.competencies.map((c) => c.id)).toEqual(['problem-solving', 'code-quality', 'communication']);
  });

  it('a round saved without a list still offers every competency of the kit', () => {
    const ref = refOf('iv-s4e8u2zk');
    const kit = { ...ref.opening.kit, rounds: ref.opening.kit.rounds.map(({ competencyIds: _c, ...r }) => r) };
    expect(coachInput({ ...ref, opening: { ...ref.opening, kit } }, [], []).competencies.map((c) => c.id)).toEqual(kit.competencies.map((c) => c.id));
  });
});
