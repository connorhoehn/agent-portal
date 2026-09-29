import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchWorkflowCommands, searchWorkflowIn, searchWorkflows } from '../searchWorkflows.ts';
import type { SearchRecord } from '../searchTypes.ts';

const vera: SearchRecord = { type: 'person', id: 'vera', title: 'Vera Green', href: '/iq/people/vera' };
const cutover: SearchRecord = { type: 'work', id: 'cutover', title: 'Tenant cutover', href: '/iq/work-items/cutover' };
const byId = (rows: ReturnType<typeof searchWorkflows>) => Object.fromEntries(rows.map(r => [r.id, r]));

test('an empty workspace disables every row with its reason', () => {
  const rows = byId(searchWorkflows({ query: '', selectedKeys: [], selectedRecords: [] }));
  assert.deepEqual(Object.keys(rows), ['who-can-help', 'explain-selection', 'summarize-results']);
  assert.equal(rows['who-can-help'].disabled, true); assert.equal(rows['who-can-help'].disabledReason, 'Search for something first');
  assert.equal(rows['explain-selection'].disabledReason, 'Select records first');
  assert.equal(rows['summarize-results'].disabledReason, 'Search for something first');
  for (const row of Object.values(rows)) assert.equal(row.prompt, '');
});

test('a query enables who-can-help and summarize over the query', () => {
  const rows = byId(searchWorkflows({ query: ' auth migration ', selectedKeys: [], selectedRecords: [], resultCount: 4 }));
  assert.equal(rows['who-can-help'].prompt, 'Who can help with auth migration? Name the owner, the SMEs and the blocked work.');
  assert.equal(rows['summarize-results'].prompt, 'Summarize the top results for auth migration in five bullets with a citation each.');
  assert.equal(rows['summarize-results'].disabled, undefined);
});

test('a scope alone names the initiative; zero results disables summarize', () => {
  const rows = byId(searchWorkflows({ query: '', scope: 'p-auth', scopeName: 'Auth Migration', selectedKeys: [], selectedRecords: [], resultCount: 0 }));
  assert.equal(rows['who-can-help'].prompt, 'Who can help with Auth Migration? Name the owner, the SMEs and the blocked work.');
  assert.equal(rows['summarize-results'].disabled, true);
  assert.match(byId(searchWorkflows({ query: '', scope: 'p-auth', selectedKeys: [], selectedRecords: [] }))['who-can-help'].prompt, /with p-auth\?/);
});

test('explain-selection counts the selection and names loaded records', () => {
  const two = byId(searchWorkflows({ query: '', selectedKeys: ['person:vera', 'work:cutover'], selectedRecords: [vera, cutover] }));
  assert.equal(two['explain-selection'].prompt, 'What connects these 2 records (Vera Green, Tenant cutover), and what needs attention?');
  const partial = byId(searchWorkflows({ query: '', selectedKeys: ['person:vera', 'work:x'], selectedRecords: [vera] }));
  assert.equal(partial['explain-selection'].prompt, 'What connects these 2 records, and what needs attention?');
  const one = byId(searchWorkflows({ query: '', selectedKeys: ['person:vera'], selectedRecords: [vera] }));
  assert.equal(one['explain-selection'].prompt, 'What is connected to Vera Green, and what needs attention?');
});

test('commands are the same rows, and a draft finds its workflow', () => {
  const rows = searchWorkflows({ query: 'auth', selectedKeys: [], selectedRecords: [] });
  assert.deepEqual(searchWorkflowCommands(rows), [
    { trigger: '/who-can-help', label: 'Who can help', hint: 'Owner, SMEs and blocked work for this search.', disabled: false },
    { trigger: '/explain-selection', label: 'Explain the selection', hint: 'Select records first', disabled: true },
    { trigger: '/summarize-results', label: 'Summarize results', hint: 'Five cited bullets over the top results.', disabled: false },
  ]);
  assert.equal(searchWorkflowIn('/who-can-help now', rows)?.id, 'who-can-help');
  assert.equal(searchWorkflowIn('who can help', rows), null);
});
