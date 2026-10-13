import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesAction, matchesUser, roleActionsAdapter, usersAdapter } from '../identityCommands.ts';

for (const [name, make, noun] of [['users', usersAdapter, 'users'], ['roles', roleActionsAdapter, 'actions']] as const) {
  test(`${name}: advertised examples drive search and refresh; mutations change nothing`, async () => {
    let query = 'q'; let refreshes = 0;
    const adapter = make({ setQuery: (v) => { query = v; }, refresh: () => { refreshes++; } });
    await adapter.execute(`search ${noun} for "Manage"`); assert.equal(query, 'Manage');
    await adapter.execute('clear search'); assert.equal(query, '');
    await adapter.execute('refresh'); assert.equal(refreshes, 1);
    for (const example of adapter.examples) await adapter.execute(example);
    assert.ok(!adapter.examples.some((e) => e.startsWith('open ')));
    query = 'kept'; refreshes = 0;
    for (const phrase of ['grant admin to u-mira', 'revoke all grants', 'sign in as u-mira', 'open u-mira', 'delete users']) {
      await assert.rejects(() => Promise.resolve(adapter.execute(phrase)), phrase);
    }
    assert.equal(query, 'kept'); assert.equal(refreshes, 0);
  });
}

test('user and action matching', () => {
  const u = { id: 'u-mira', displayName: 'Mira Chen', email: 'mira@example.com', personId: 'p-012' };
  for (const q of ['mira', 'U-MIRA', 'example.com', 'p-012', '']) assert.ok(matchesUser(u, q), q);
  assert.equal(matchesUser(u, 'lena'), false);
  assert.ok(matchesAction('ManageUsers', 'manage'));
  assert.equal(matchesAction('ViewSocial', 'manage'), false);
});
