// Run with:  cd portal && node --test 'src/pages/sprints/__tests__/*.test.ts'
//
// Plain node:test — the portal has no test runner in package.json. sprintForm
// is pure TypeScript (no DOM, no fetch), so Node's type-stripping loader runs
// it directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  grantsUrl, sprintItemsUrl, sprintItemUrl, grantUrl,
  isIsoDate, validateNewSprint, validateGrantAmount,
  type NewSprintForm,
} from '../sprintForm.ts';

// ─── URL builders ────────────────────────────────────────────────────────────

test('URL builders hit the documented endpoints', () => {
  assert.equal(grantsUrl('spr-1'), '/api/grants?sprintId=spr-1');
  assert.equal(sprintItemsUrl('spr-1'), '/api/sprints/spr-1/items');
  assert.equal(sprintItemUrl('spr-1', 'wi-9'), '/api/sprints/spr-1/items/wi-9');
  assert.equal(grantUrl('g-3'), '/api/grants/g-3');
});

test('URL builders encode ids that carry reserved characters', () => {
  assert.equal(grantsUrl('a/b'), '/api/grants?sprintId=a%2Fb');
  assert.equal(sprintItemUrl('s p', 'i&d'), '/api/sprints/s%20p/items/i%26d');
});

// ─── Date validation ─────────────────────────────────────────────────────────

test('isIsoDate accepts real dates and rejects malformed or rolled-over ones', () => {
  assert.equal(isIsoDate('2026-08-24'), true);
  assert.equal(isIsoDate('2026-2-4'), false);   // not zero-padded
  assert.equal(isIsoDate('24-08-2026'), false); // wrong order
  assert.equal(isIsoDate('2026-02-30'), false); // Feb 30 rolls over
  assert.equal(isIsoDate('2026-13-01'), false); // no month 13
  assert.equal(isIsoDate(''), false);
});

// ─── New-sprint validation ───────────────────────────────────────────────────

const base: NewSprintForm = {
  initiativeId: 'p-observability',
  name: 'Sprint 7',
  startsOn: '2026-08-01',
  endsOn: '2026-08-14',
  status: 'planned',
};

test('a well-formed sprint validates and omits empty optionals', () => {
  const r = validateNewSprint({ ...base, stewardPersonId: '  ', goal: '' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.value, {
      initiativeId: 'p-observability', name: 'Sprint 7',
      startsOn: '2026-08-01', endsOn: '2026-08-14', status: 'planned',
    });
    assert.ok(!('stewardPersonId' in r.value));
    assert.ok(!('goal' in r.value));
  }
});

test('optional steward and goal are trimmed and carried through', () => {
  const r = validateNewSprint({ ...base, stewardPersonId: ' per-1 ', goal: '  ship it ' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.stewardPersonId, 'per-1');
    assert.equal(r.value.goal, 'ship it');
  }
});

test('an empty status defaults to planned', () => {
  const r = validateNewSprint({ ...base, status: '' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.status, 'planned');
});

test('each rule fails closed with a message', () => {
  for (const [patch, needle] of [
    [{ initiativeId: '' }, 'initiative'],
    [{ name: '   ' }, 'name'],
    [{ startsOn: '2026-2-1' }, 'Start date'],
    [{ endsOn: 'nope' }, 'End date'],
    [{ startsOn: '2026-08-14', endsOn: '2026-08-01' }, 'after the start'],
    [{ endsOn: '2026-08-01' }, 'after the start'], // equal dates are not "after"
    [{ status: 'shipping' }, 'planned, active, or done'],
  ] as Array<[Partial<NewSprintForm>, string]>) {
    const r = validateNewSprint({ ...base, ...patch });
    assert.equal(r.ok, false, `expected ${JSON.stringify(patch)} to fail`);
    if (!r.ok) assert.match(r.error, new RegExp(needle));
  }
});

// ─── Grant amount ────────────────────────────────────────────────────────────

test('grant amount accepts positive numbers and rounds to cents', () => {
  assert.deepEqual(validateGrantAmount('1200'), { ok: true, value: 1200 });
  assert.deepEqual(validateGrantAmount(' 99.005 '), { ok: true, value: 99.01 });
});

test('grant amount rejects blank, non-numeric, zero, and negative', () => {
  for (const raw of ['', '   ', 'abc', '0', '-5']) {
    assert.equal(validateGrantAmount(raw).ok, false, `expected ${JSON.stringify(raw)} to fail`);
  }
});
