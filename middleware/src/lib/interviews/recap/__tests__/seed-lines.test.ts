// The recap's seeded statements quote lines the record's seeded transcript holds, at the same line numbers (round 5 combine).
import { interviewRecordLinesFixture } from '../../../../mock/interviews-records.js';

describe('seeded recap quotes', () => {
  const rows = interviewRecordLinesFixture.rows('default');
  it.each([['iv-ingrid-together', 8, 'I paged the on-call lead and we split the investigation'], ['iv-mateo-coding', 19, 'each key gets a fixed window that resets every minute']] as const)(
    '%s line %i holds the quote', (id, seq, quote) => {
      const line = rows.find((r) => r.interviewId === id && r.seq === seq);
      expect(line?.text.includes(quote)).toBe(true);
    });
});
