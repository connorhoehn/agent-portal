import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pythonTestCases, passingRun } from './coding-film-proof.mjs';

test('print-only empty input cannot satisfy requested test coverage', () => {
  const source = 'milo_test_cases = [(([3,3],6),[0,1])]\nmilo_edge_inputs = [([],6)]\n';
  assert.equal(pythonTestCases(source).ok, false);
  assert.equal(pythonTestCases(source).empty, false);
  assert.equal(pythonTestCases(source + 'milo_test_cases = [(([],6),[]),(([3,3],6),[0,1])]\nassert milo_failures == 0\n').ok, true);
  assert.equal(pythonTestCases(source + 'milo_test_cases = [(([],6),[]),(([3,3],6),[0,1])]\n# assert milo_failures == 0\n').ok, false);
});
test('one passing case or exit zero cannot hide a failing or missing case', () => {
  assert.equal(passingRun('Finished Exit code 0 ok ([3,3],6) DIFF ([],6)', 2), false);
  assert.equal(passingRun('Finished Exit code 0 ok ([3,3],6)', 2), false);
  assert.equal(passingRun('Finished Exit code 0 ok ([3,3],6) ok ([],6)', 2), true);
});
