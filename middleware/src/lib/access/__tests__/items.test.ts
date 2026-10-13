// lib/access/items.ts: what a request names. A grant resolves only to a
// catalog item; a revocation (lane A2) may name any standing role.
import { requestItem, roleItem, roleItemId } from '../items.js';
import { item } from './fixtures.js';

const catalog = [item()];

it('a grant resolves to its catalog item only; a revocation also to a role outside the catalog', () => {
  expect(requestItem({ kind: 'grant', itemId: 'role:orgiq:sme' }, catalog)).toBe(catalog[0]);
  expect(requestItem({ kind: 'grant', itemId: 'role:orgiq:member' }, catalog)).toBeUndefined();
  expect(requestItem({ kind: 'revocation', itemId: 'role:orgiq:member' }, catalog)).toMatchObject({
    id: 'role:orgiq:member', kind: 'tenant-role', tenant: 'orgiq', role: 'member', title: 'Member in Work',
  });
  expect(requestItem({ kind: 'revocation', itemId: 'role:orgiq:sme' }, catalog)).toBe(catalog[0]);
});

it('role ids name only the four reviewable tenants', () => {
  expect(roleItemId('pipelines', 'pipeline-admin')).toBe('role:pipelines:pipeline-admin');
  expect(roleItem('role:pipelines:pipeline-admin')?.title).toBe('Pipeline admin in Pipelines');
  expect(roleItem('role:access:access-admin')).toBeNull();
  expect(roleItem('initiative:p-auth-migration')).toBeNull();
});
