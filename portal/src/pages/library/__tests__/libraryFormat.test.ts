// Run with:  cd portal && node --test 'src/pages/library/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contractLine, usageLine, evalLabel, facetOptions, isFenced, KIND_ORDER } from '../libraryFormat.ts';
import type { LibraryAsset } from '../types.ts';

function asset(over: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    id: 'a', name: 'A', description: 'd', kind: 'prompt', tier: 'sandbox',
    roles: [], tags: [], ownerName: null, version: '1', lifecycleStatus: 'published',
    contract: { kind: 'prompt', tier: 'sandbox', variables: [] },
    evalPassRate: null, usedBy: [], updatedAt: '2026-01-01', template: '', signoffs: 0,
    ...over,
  };
}

test('isFenced marks exactly the untrusted sources', () => {
  assert.equal(isFenced('untrusted'), true);
  assert.equal(isFenced('retrieved'), true);
  assert.equal(isFenced('caller'), false);
  assert.equal(isFenced('literal'), false);
});

test('contractLine counts fenced variables, and says nothing when there are none', () => {
  assert.equal(contractLine(asset()), null);
  const a = asset({ contract: { kind: 'prompt', tier: 'sandbox', variables: [
    { name: 'x', type: 'text', required: true, source: 'caller' },
    { name: 'y', type: 'longtext', required: true, source: 'untrusted' },
  ] } });
  assert.equal(contractLine(a), '2 variables · 1 fenced');
});

test('usageLine treats "nothing yet" as an answer, not a defect', () => {
  assert.equal(usageLine(asset()), 'nothing calls it yet');
  assert.equal(usageLine(asset({ usedBy: ['devbox'] })), 'devbox');
  assert.equal(usageLine(asset({ usedBy: ['a', 'b', 'c'] })), 'a +2 more');
});

test('evalLabel distinguishes never-evaluated from zero', () => {
  assert.equal(evalLabel(null), 'never evaluated');
  assert.equal(evalLabel(0), '0%');
  assert.equal(evalLabel(0.935), '94%');
});

test('facetOptions offers only kinds present in the catalog, in canonical order', () => {
  const opts = facetOptions({ skill: 2, prompt: 1, insight: 0 }, KIND_ORDER);
  assert.deepEqual(opts, [{ value: 'prompt', count: 1 }, { value: 'skill', count: 2 }]);
});

import { readinessRows } from '../libraryFormat.ts';

const checks = {
  contractComplete: true, undeclared: [] as string[], hasOwner: true,
  evaluated: true, evalPassRate: 0.9, guardrailBound: false, signoffs: 0,
};

test('a sandbox asset is asked for nothing — no cargo-cult checklist', () => {
  assert.deepEqual(readinessRows({ tier: 'sandbox', checks }), []);
});

test('internal asks for contract, owner and a green eval — not guardrails', () => {
  const rows = readinessRows({ tier: 'internal', checks });
  assert.deepEqual(rows.map((r) => r.label), ['Contract complete', 'Owner', 'Eval baseline ≥ 80%']);
  assert.ok(rows.every((r) => r.met));
});

test('endpoint additionally asks for a guardrail and two sign-offs', () => {
  const rows = readinessRows({ tier: 'endpoint', checks });
  assert.deepEqual(rows.map((r) => r.label).slice(3), ['Guardrail bound', '2 sign-offs']);
  assert.equal(rows.find((r) => r.label === 'Guardrail bound')!.met, false);
});

test('an unmet row explains itself rather than just failing', () => {
  const rows = readinessRows({ tier: 'internal', checks: {
    ...checks, contractComplete: false, undeclared: ['rogue'], evaluated: false, evalPassRate: null,
  } });
  assert.match(rows[0]!.detail!, /rogue would render as untrusted/);
  assert.equal(rows[2]!.detail, 'never evaluated');
});
