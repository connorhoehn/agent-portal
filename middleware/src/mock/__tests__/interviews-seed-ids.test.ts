// A guard on the seeded ids (row E3, O-189): an id is not a place to read a person's name. No seeded interview, scorecard,
// application or candidate id may contain a first name from the candidate cast.
// All four kinds are random since 18 November (O-189): the walk's seed table (scripts/journeys/interviews/seed.mjs) names them.
import { interviewApplicationsFixture, interviewCandidatesFixture, interviewScorecardsFixture, interviewsFixture } from '../interviews.js';

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const firstNames = () => [...new Set(interviewCandidatesFixture.rows().map((c) => plain(c.name.split(/\s+/)[0]!)))];
const offenders = (ids: string[]) => {
  const names = firstNames();
  return ids.filter((id) => names.some((n) => plain(id).includes(n)));
};

describe('seeded ids carry no first name', () => {
  it('the cast has first names to look for', () => {
    expect(firstNames().length).toBeGreaterThanOrEqual(5);
  });
  it('interview ids', () => {
    expect(offenders(interviewsFixture.rows().map((r) => r.id))).toEqual([]);
  });
  it('candidate ids', () => {
    expect(offenders(interviewCandidatesFixture.rows().map((r) => r.id))).toEqual([]);
  });
  it('application ids', () => {
    expect(offenders(interviewApplicationsFixture.rows().map((r) => r.id))).toEqual([]);
  });
  it('scorecard ids', () => {
    expect(offenders(interviewScorecardsFixture.rows().map((r) => r.id))).toEqual([]);
  });
});
