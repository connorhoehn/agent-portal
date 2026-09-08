// The lab loop's offline stores stamp from mock/core/clock.ts.
//
// `recordExperience`, `openConsult` and `answerConsult` each minted
// `new Date().toISOString()` inside their `config.mock.aurora` branch — rule 3
// of the mock floor: a fixture timestamp living outside src/mock, unfreezable
// and liable to land in yesterday just after UTC midnight.
//
// The consult expiry is the interesting half. A consult is expired on READ
// (`expireStale`), by comparing its age with the 30-minute window — and that
// comparison used `Date.now()`. Move the WRITE onto the clock and leave the
// READ on wall time and you get a new bug rather than a fix: a consult opened
// under a freeze set in the past is instantly older than 30 minutes, so every
// test that opens one would find it already expired. Both sides read the same
// clock now, and the third test below is what holds that line.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { fixtureRegistry, freezeClock } from '../../mock/core/index.js';
import {
  answerConsult, getConsult, listConsults, listExperiences, openConsult, recordExperience,
} from '../lab.js';

let restore = () => {};
afterEach(() => {
  restore();
  // The two stores are registered fixtures now, so a test's writes are undone
  // the way an auditor undoes theirs — rather than leaking into the next test
  // and into whatever asserts on a row count later in the run.
  fixtureRegistry.resetAll('default');
});

function freeze(at: string): void {
  restore();
  restore = freezeClock(at);
}

describe('lab experiences', () => {
  it('records createdAt at the frozen instant', async () => {
    freeze('2026-03-11T14:32:07.000Z');
    const exp = await recordExperience({
      kind: 'gotcha', title: 'The Data API is cold for the first call', repo: 'orgiq-portal',
    });
    expect(exp.createdAt).toBe('2026-03-11T14:32:07.000Z');
    const listed = await listExperiences({ repo: 'orgiq-portal' });
    expect(listed[0]?.createdAt).toBe('2026-03-11T14:32:07.000Z');
  });

  it('a record written a minute past UTC midnight belongs to the new day', async () => {
    freeze('2026-03-12T00:01:00.000Z');
    const exp = await recordExperience({ kind: 'worked', title: 'Pinned the ARM64 platform' });
    expect(exp.createdAt.slice(0, 10)).toBe('2026-03-12');
  });
});

describe('lab consults', () => {
  it('stamps createdAt on open and answeredAt on answer, from the clock', async () => {
    freeze('2026-03-11T09:00:00.000Z');
    const con = await openConsult({ question: 'Should I bump the sha or wait for the release?' });
    expect(con.createdAt).toBe('2026-03-11T09:00:00.000Z');
    expect(con.answeredAt).toBeNull();
    expect(con.status).toBe('pending');

    // Inside the 30-minute window, so it is still answerable.
    freeze('2026-03-11T09:12:00.000Z');
    const answered = await answerConsult(con.id, 'Wait for the release.', 'p-004');
    expect(answered?.answeredAt).toBe('2026-03-11T09:12:00.000Z');
    expect(answered?.answeredBy).toBe('p-004');
    expect(answered?.status).toBe('answered');
    // The open stamp is untouched by the answer.
    expect(answered?.createdAt).toBe('2026-03-11T09:00:00.000Z');
  });

  it('expiry measures age against the same clock the consult was stamped from', async () => {
    freeze('2026-03-11T09:00:00.000Z');
    const con = await openConsult({ question: 'Is this envelope still active?' });

    // Under a freeze in the past, a wall-clock expiry check would read this
    // consult as months old and expire it on the spot.
    expect((await getConsult(con.id))?.status).toBe('pending');
    expect((await listConsults({ status: 'pending' })).some((c) => c.id === con.id)).toBe(true);

    // Move the clock past the window and it expires — the check is real, not
    // simply disabled.
    freeze('2026-03-11T09:31:00.000Z');
    expect((await getConsult(con.id))?.status).toBe('expired');
    // …and an expired consult can no longer be answered.
    expect(await answerConsult(con.id, 'too late', 'p-004')).toBeNull();
  });
});
