// The opening's money line and who asks for it (lib/interviewsKit.ts; docs/interviews-tenant-plan.md row I0.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moneyLine, readsOpeningMoney, type OpeningMoney } from '../interviewsKit.ts';

const M: OpeningMoney = {
  capUsd: 150, interviewCapUsd: null, defaultInterviewCapUsd: 10, effectiveInterviewCapUsd: 10, spentUsd: 1.5, heldUsd: 3, leftUsd: 145.5, unknownCount: 0,
};

test('one line: cap, spent, set aside, left and the cap per interview', () => {
  assert.deepEqual(moneyLine(M), ['Spending cap $150.00', '$1.50 spent', '$3.00 set aside', '$145.50 left', 'Up to $10.00 per interview (the default)']);
  assert.equal(moneyLine({ ...M, interviewCapUsd: 8, effectiveInterviewCapUsd: 8, unknownCount: 2 }).slice(4).join(' · '), 'Up to $8.00 per interview · 2 costs not known yet');
});

test('with no cap the line says nothing can start', () => {
  assert.match(moneyLine({ ...M, capUsd: null, leftUsd: null })[0]!, /^No spending cap yet/);
});

test('an interviewer never asks for the money', () => {
  assert.deepEqual(['recruiter', 'hiring-manager', 'admin', 'interviewer', undefined].map(readsOpeningMoney), [true, true, true, false, false]);
});
