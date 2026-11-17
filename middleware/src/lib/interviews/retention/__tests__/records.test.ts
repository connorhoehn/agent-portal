// Retention's own statements (lib/interviews/retention/records.ts): consents and scorecards by interview, and the
// redaction of a candidate's contact details, in memory over the fixtures and as SQL.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewConsentsFixture } from '../../../../mock/interviews-consents.js';
import { interviewCandidatesFixture, interviewScorecardsFixture } from '../../../../mock/interviews.js';
import { MemoryRecordStatements, REDACT_CANDIDATE_SQL, SqlRecordStatements } from '../records.js';

afterEach(() => fixtureRegistry.resetAll('default'));

describe('in memory', () => {
  const r = new MemoryRecordStatements();
  it('erases the consents and scorecards of the named interviews only, and a repeat erases nothing', async () => {
    expect(await r.eraseConsents(['iv-ingrid-coding', 'iv-ingrid-together'])).toBe(2);
    expect(await r.eraseConsents(['iv-ingrid-coding'])).toBe(0);
    expect(interviewConsentsFixture.rows().map((c) => c.interviewId)).not.toContain('iv-ingrid-coding');
    expect(interviewConsentsFixture.rows().length).toBeGreaterThan(0);
    const before = interviewScorecardsFixture.rows().length;
    expect(await r.eraseScorecards(['iv-mateo-coding'])).toBeGreaterThan(0);
    expect(interviewScorecardsFixture.rows().length).toBeLessThan(before);
  });
  it('redacts a candidate once', async () => {
    expect(await r.redactCandidate('cand-lucia')).toBe(1);
    expect(await r.redactCandidate('cand-lucia')).toBe(0);
    expect(await r.redactCandidate('cand-nobody')).toBe(0);
    expect(interviewCandidatesFixture.rows().find((c) => c.id === 'cand-lucia')).toMatchObject({ name: 'Name removed', email: '', location: '', source: 'Careers page' });
  });
});

describe('as SQL', () => {
  it('names each id as its own parameter and counts the rows returned', async () => {
    const seen: [string, unknown][] = [];
    const r = new SqlRecordStatements(async (sql, params) => { seen.push([sql, params]); return [{ id: 'a' }, { id: 'b' }]; });
    expect(await r.eraseScorecards(['iv-1', 'iv-2'])).toBe(2);
    expect(await r.eraseConsents([])).toBe(0);
    expect(await r.redactCandidate('cand-1')).toBe(2);
    expect(seen[0]![0]).toBe('DELETE FROM interview_scorecards WHERE interview_id IN (:id0, :id1) RETURNING id');
    expect(seen[0]![1]).toEqual([{ name: 'id0', value: { stringValue: 'iv-1' } }, { name: 'id1', value: { stringValue: 'iv-2' } }]);
    expect(seen[1]![0]).toBe(REDACT_CANDIDATE_SQL);
    expect(seen).toHaveLength(2);
  });
});
