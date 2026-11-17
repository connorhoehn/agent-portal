// node --test scripts/journeys/tests/interviews-seed.test.mjs — the interviews walk's seeded ids and 404 tables
// (scripts/journeys/interviews/seed.mjs). No stack and no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SEED, seedPath, parseRefusalTable } from '../interviews/seed.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = fs.readFileSync(`${root}middleware/src/mock/interviews.ts`, 'utf8');

test('every seeded id the walk names is in the fixture, and every seeded interview is named', () => {
  const quoted = (id) => fixture.includes(`'${id}'`);
  for (const group of ['openings', 'candidates', 'applications', 'interviews']) {
    for (const [name, id] of Object.entries(SEED[group])) assert.ok(quoted(id), `${group}.${name} = ${id} is not in mock/interviews.ts`);
  }
  for (const id of Object.values(SEED.rounds)) assert.ok(quoted(id), `round ${id} is not in mock/interviews.ts`);
  for (const [who, constant] of [['recruiter', 'GRETA'], ['interviewer', 'HUGO'], ['interviewer2', 'WEN'], ['hiringManager', 'AMARA']]) {
    assert.ok(fixture.includes(`export const ${constant} = '${SEED.cast[who]}'`), `cast.${who} is not ${constant}`);
  }
  const seeded = [...fixture.matchAll(/interview\(\{ id: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...seeded].sort(), Object.values(SEED.interviews).sort(), 'SEED.interviews and the fixture name different interviews');
  assert.ok(Object.values(SEED.interviews).includes(SEED.guestInterview) && Object.values(SEED.interviews).includes(SEED.panelInterview));
});

test('no seeded interview id carries a first name', () => {
  const firstNames = Object.keys(SEED.candidates);
  for (const id of Object.values(SEED.interviews)) {
    assert.ok(!firstNames.some((n) => id.includes(n)), `${id} carries a candidate's first name`);
  }
});

test('a path names seeded ids, and an unknown name throws', () => {
  assert.equal(seedPath('/api/interviews/interviews/{interviews.mateoDesign}/record'), `/api/interviews/interviews/${SEED.interviews.mateoDesign}/record`);
  assert.equal(seedPath('/api/x/{openings.ios}/{candidates.aiko}'), '/api/x/op-ios/cand-aiko');
  assert.throws(() => seedPath('/api/interviews/interviews/{interviews.nobody}'), /no seeded id/);
});

test('a 404 table: refused defaults to 404, a principal may say otherwise, allowed and a body are optional', () => {
  const rows = parseRefusalTable([
    '# a comment',
    '',
    'GET /api/interviews/interviews/{interviews.aikoCoding} | interviewer hiringManager guest=401 workOnly=403 | recruiter interviewer2',
    'PUT /api/interviews/interviews/{interviews.mateoDesign}/questions | recruiter guest:aikoCoding=401 | | {"revision":1,"questionIds":[]}  # a write',
  ].join('\n'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].refused, [{ who: 'interviewer', want: 404 }, { who: 'hiringManager', want: 404 }, { who: 'guest', want: 401 }, { who: 'workOnly', want: 403 }]);
  assert.deepEqual(rows[0].allowed, [{ who: 'recruiter', want: null }, { who: 'interviewer2', want: null }]);
  assert.equal(rows[0].path, `/api/interviews/interviews/${SEED.interviews.aikoCoding}`);
  assert.deepEqual(rows[1].allowed, []);
  assert.deepEqual(rows[1].body, { revision: 1, questionIds: [] });
  assert.equal(rows[1].refused[1].who, 'guest:aikoCoding');
});

test('a 404 table refuses a line with no route, no refused principal or an unknown id', () => {
  assert.throws(() => parseRefusalTable('FETCH /api/x | recruiter'), /expected "METHOD \/path"/);
  assert.throws(() => parseRefusalTable('GET /api/x |'), /no refused principal/);
  assert.throws(() => parseRefusalTable('GET /api/x/{interviews.nobody} | recruiter'), /no seeded id/);
});

test('the round that is live now is one id in the fixture and in the walk\'s table', () => {
  assert.ok(fixture.includes(`export const LIVE_INTERVIEW_ID = '${SEED.interviews.kwameLive}'`), 'LIVE_INTERVIEW_ID is not SEED.interviews.kwameLive');
});
