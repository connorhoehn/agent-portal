import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIMENSION_STANDARDS, STANDARDS_FOLDER_ID, enterpriseDocPath, standardFor } from '../dimensionStandards.ts';

test('every mapped standard is a knowledge-tree node id under the enterprise context', () => {
  for (const [dim, std] of Object.entries(DIMENSION_STANDARDS)) {
    assert.match(dim, /^([1-9]|1[0-7])$/, `dimension id ${dim}`);
    assert.match(std.docId, /^ec:[a-z-]+\/[a-z-]+\.md$/, `${dim} → ${std.docId}`);
    assert.ok(std.clause.length > 0, `${dim} has a clause`);
  }
});

test('standardFor: the CI dimension is measured against the CI/CD standard; an unmapped one is an honest null', () => {
  assert.equal(standardFor('1')?.docId, 'ec:standards/ci-cd-standards.md');
  assert.equal(standardFor('7'), null);
  assert.equal(standardFor('99'), null);
});

test('enterpriseDocPath deep-links the explorer by node id', () => {
  assert.equal(enterpriseDocPath('ec:standards/ci-cd-standards.md'), '/assessment/enterprise?doc=ec%3Astandards%2Fci-cd-standards.md');
  assert.equal(enterpriseDocPath(STANDARDS_FOLDER_ID), '/assessment/enterprise?doc=ec%3Astandards');
});
