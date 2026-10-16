import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contactCommandExamples, filterContacts, parseContactCommand, presenceTally, resolveContactTarget } from '../contactCommands.ts';
import type { ContactRow } from '../socialPlatform.ts';

const rows: ContactRow[] = [
  { userId: 'u-me', displayName: 'Theo Chang', roles: ['member'], online: true, idle: false },
  { userId: 'u-farah', displayName: 'Farah Osei', roles: ['member'], online: true, idle: false },
  { userId: 'u-mira', displayName: 'Mira Okafor', roles: ['member'], online: true, idle: true },
  { userId: 'u-farah2', displayName: 'Farah Adams', roles: ['member'], online: false, idle: true },
];

for (const [phrase, expected] of [
  ['show here contacts', { kind: 'presence', presence: 'here' }],
  ['please show people here now', { kind: 'presence', presence: 'here' }],
  ['show away contacts', { kind: 'presence', presence: 'away' }],
  ['status offline', { kind: 'presence', presence: 'offline' }],
  ['status all', { kind: 'presence', presence: 'all' }],
  ['show all contacts', { kind: 'reset' }],
  ['reset filters', { kind: 'reset' }],
  ['clear all filters', { kind: 'reset' }],
  ['refresh contacts', { kind: 'refresh' }],
  ['search contacts for "Farah"', { kind: 'search', query: 'Farah' }],
  ['find person named "Mira Okafor"', { kind: 'search', query: 'Mira Okafor' }],
  ['open Mira Okafor', { kind: 'open', target: 'Mira Okafor' }],
  ['message u-mira', { kind: 'open', target: 'u-mira' }],
  ['help', { kind: 'help' }],
  ["who's online now", { kind: 'presence', presence: 'online' }],
  ['who is here', { kind: 'presence', presence: 'here' }],
  ['Who is away?', { kind: 'presence', presence: 'away' }],
  ['who is offline', { kind: 'presence', presence: 'offline' }],
  ['show online contacts', { kind: 'presence', presence: 'online' }],
] as const) test(`interprets ${phrase}`, () => assert.deepEqual(parseContactCommand(phrase), expected));

for (const phrase of ['show not offline contacts', 'show here contacts from yesterday', 'show here and away contacts',
  'show people offline last week', 'show here contacts then message Mira', 'call Mira', 'start call with Mira',
  'delete Farah', 'show contacts in finance', '', 'x'.repeat(501)]) {
  test(`rejects unsupported or partial request: ${phrase.slice(0, 70)}`, () => assert.throws(() => parseContactCommand(phrase)));
}
for (const phrase of ['message everyone', 'open all contacts', 'message me', 'open myself', 'message selected contacts']) {
  test(`rejects bulk/self target: ${phrase}`, () => assert.throws(() => parseContactCommand(phrase), /one other person/));
}
test('the shared name search and presence filters compose without mutation', () => {
  assert.deepEqual(filterContacts(rows, { query: 'farah', presence: 'all' }).map(row => row.userId), ['u-farah', 'u-farah2']);
  assert.deepEqual(filterContacts(rows, { query: 'FARAH', presence: 'here' }).map(row => row.userId), ['u-farah']);
  assert.deepEqual(filterContacts(rows, { query: '', presence: 'away' }).map(row => row.userId), ['u-mira']);
  assert.deepEqual(filterContacts(rows, { query: '', presence: 'offline' }).map(row => row.userId), ['u-farah2']);
  assert.deepEqual(filterContacts(rows, { query: 'u-mira', presence: 'all' }).map(row => row.userId), ['u-mira']);
  assert.equal(rows.length, 4);
});
test('opening resolves exact ID, exact name or one partial name', () => {
  assert.equal(resolveContactTarget('u-farah', rows, 'u-me', true).userId, 'u-farah');
  assert.equal(resolveContactTarget('farah osei', rows, 'u-me', true).userId, 'u-farah');
  assert.equal(resolveContactTarget('Mira', rows, 'u-me', true).userId, 'u-mira');
});
test('ambiguous names and unknown people never open arbitrary conversations', () => {
  assert.throws(() => resolveContactTarget('Farah', rows, 'u-me', true), /matches 2 people/);
  assert.throws(() => resolveContactTarget('Nobody', rows, 'u-me', true), /No matching person/);
  assert.throws(() => resolveContactTarget('Farah Osei', [rows[1], { ...rows[1], userId: 'duplicate' }], 'u-me', true), /matches 2 people/);
});
test('targets outside current filtered table stay outside command scope', () => {
  const here = filterContacts(rows, { query: '', presence: 'here' });
  assert.throws(() => resolveContactTarget('u-mira', here, 'u-me', true), /No matching person/);
});
test('permission and self protections apply to both IDs and display names', () => {
  assert.throws(() => resolveContactTarget('u-farah', rows, 'u-me', false), /permission/);
  assert.throws(() => resolveContactTarget('u-me', rows, 'u-me', true), /yourself/);
  assert.throws(() => resolveContactTarget('Theo Chang', rows, 'u-me', true), /yourself/);
});
test('IDs remain case-sensitive and targets preserve punctuation', () => {
  const exact = [{ ...rows[1], userId: 'u-Case.' }, { ...rows[2], userId: 'u-case.' }];
  assert.equal(resolveContactTarget('u-case.', exact, 'u-me', true).displayName, 'Mira Okafor');
  assert.throws(() => resolveContactTarget('u-CASE.', exact, 'u-me', true), /No matching person/);
  assert.deepEqual(parseContactCommand('open "u-Case."'), { kind: 'open', target: 'u-Case.' });
});
test('read-only help omits message/open actions; every help variant omits call', () => {
  assert.ok(contactCommandExamples(true).some(example => example.startsWith('message')));
  assert.ok(!contactCommandExamples(false).some(example => /^(?:message|open)/.test(example)));
  assert.ok(!contactCommandExamples(true).some(example => example.startsWith('call')));
});

test('online is here plus away; the tally counts the loaded roster, never a fixed number', () => {
  assert.deepEqual(filterContacts(rows, { query: '', presence: 'online' }).map(row => row.userId), ['u-me', 'u-farah', 'u-mira']);
  assert.equal(presenceTally(rows, 'u-me'), 'Here now: 2 (Theo Chang (you), Farah Osei). Away: 1 (Mira Okafor). Offline: 1 of 4 people.');
  assert.equal(presenceTally([], 'u-me'), 'Here now: 0. Away: 0. Offline: 0 of 0 people.');
  assert.match(presenceTally(rows.filter(r => !r.online || r.idle), 'u-me'), /^Here now: 0\. Away: 1 \(Mira Okafor\)\. Offline: 1 of 2 people\.$/);
});
