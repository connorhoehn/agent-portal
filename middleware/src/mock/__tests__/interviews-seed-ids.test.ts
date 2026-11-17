// A guard on the seeded ids (row E3, O-189): an id is not a place to read a person's name. No seeded interview, scorecard,
// application or candidate id may contain a first name from the candidate cast.
// The interview ids are clean. The candidate, application and scorecard ids still carry first names (`cand-mateo`, `app-ingrid`,
// `sc-ravi-coding`), so those three are written `it.failing` with the list below: they turn green, and this file must be
// changed to plain `it`, once the reseed script renames them. Renaming is that script's job, not this guard's.
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
  it.failing('candidate ids (reseed renames cand-*)', () => {
    expect(offenders(interviewCandidatesFixture.rows().map((r) => r.id))).toEqual([]);
  });
  it.failing('application ids (reseed renames app-*)', () => {
    expect(offenders(interviewApplicationsFixture.rows().map((r) => r.id))).toEqual([]);
  });
  it.failing('scorecard ids (reseed renames sc-*)', () => {
    expect(offenders(interviewScorecardsFixture.rows().map((r) => r.id))).toEqual([]);
  });
});
