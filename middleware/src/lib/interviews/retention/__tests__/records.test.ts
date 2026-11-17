// Retention's own statements (lib/interviews/retention/records.ts): consents and scorecards by interview, and the
// redaction of a candidate's contact details, in memory over the fixtures and as SQL.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewConsentsFixture } from '../../../../mock/interviews-consents.js';
import { interviewApplicationsFixture, interviewCandidatesFixture, interviewScorecardsFixture } from '../../../../mock/interviews.js';
import { MemoryRecordStatements, REDACT_CANDIDATE_SQL, REDACT_STAGE_REASONS_SQL, SqlRecordStatements } from '../records.js';
import { REDACTED_REASON } from '../rules.js';

afterEach(() => fixtureRegistry.resetAll('default'));

describe('in memory', () => {
  const r = new MemoryRecordStatements();
  it('erases the consents and scorecards of the named interviews only, and a repeat erases nothing', async () => {
    expect(await r.eraseConsents(['iv-d7q4n9xe', 'iv-f2b6t5zh'])).toBe(2);
    expect(await r.eraseConsents(['iv-d7q4n9xe'])).toBe(0);
    expect(interviewConsentsFixture.rows().map((c) => c.interviewId)).not.toContain('iv-d7q4n9xe');
    expect(interviewConsentsFixture.rows().length).toBeGreaterThan(0);
    const before = interviewScorecardsFixture.rows().length;
    expect(await r.eraseScorecards(['iv-j6x2d9sb'])).toBeGreaterThan(0);
    expect(interviewScorecardsFixture.rows().length).toBeLessThan(before);
  });
  it('redacts a candidate once', async () => {
    expect(await r.redactCandidate('cand-lucia')).toBe(1);
    expect(await r.redactCandidate('cand-lucia')).toBe(0);
    expect(await r.redactCandidate('cand-nobody')).toBe(0);
    expect(interviewCandidatesFixture.rows().find((c) => c.id === 'cand-lucia')).toMatchObject({ name: 'Name removed', email: '', location: '', source: 'Careers page' });
  });
  it('replaces every reason on the candidate\'s stage moves with the one phrase, keeps the stage, time and mover, and a repeat changes nothing', async () => {
    const before = structuredClone(interviewApplicationsFixture.rows().find((a) => a.id === 'app-mateo')!.history);
    const others = structuredClone(interviewApplicationsFixture.rows().filter((a) => a.candidateId !== 'cand-mateo'));
    expect(before.some((h) => h.reason !== null)).toBe(true);
    expect(await r.redactStageReasons('cand-mateo')).toBe(1);
    const after = interviewApplicationsFixture.rows().find((a) => a.id === 'app-mateo')!.history;
    expect(after.map((h) => [h.stage, h.at, h.by])).toEqual(before.map((h) => [h.stage, h.at, h.by]));
    expect(after.map((h) => h.reason)).toEqual(before.map((h) => (h.reason === null ? null : REDACTED_REASON)));
    expect(JSON.stringify(after)).not.toMatch(/payments interest/);
    expect(await r.redactStageReasons('cand-mateo')).toBe(0);
    expect(await r.redactStageReasons('cand-kwame')).toBe(0); // no reasons written
    expect(await r.redactStageReasons('cand-nobody')).toBe(0);
    expect(interviewApplicationsFixture.rows().filter((a) => a.candidateId !== 'cand-mateo')).toEqual(others);
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
    expect(await r.redactStageReasons('cand-1')).toBe(2);
    expect(seen[2]![0]).toBe(REDACT_STAGE_REASONS_SQL);
    expect(seen[2]![1]).toEqual([{ name: 'id', value: { stringValue: 'cand-1' } }, { name: 'phrase', value: { stringValue: REDACTED_REASON } }]);
    // Only the candidate's applications, only an application that still holds a reason of its own; the stage, time and mover stay.
    expect(REDACT_STAGE_REASONS_SQL).toMatch(/WHERE a\.candidate_id = :id/);
    expect(REDACT_STAGE_REASONS_SQL).toMatch(/x\.e->>'reason' <> :phrase/);
    expect(REDACT_STAGE_REASONS_SQL).toMatch(/jsonb_set\(e, '\{reason\}'/);
    expect(seen).toHaveLength(3);
  });
});
