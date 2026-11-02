// The mock avatar fixture holds three things in step: the people fixture, the
// identity fallback's unlinked users, and the photographic assets
// `scripts/avatars/generate-local.mjs` checks in under portal/public/avatars.
// A URL with no file behind it would render a broken image instead of
// initials, so every row must name a file that exists.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true }, aurora: {} },
}));

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fixtureRegistry } from '../core/index.js';
import { avatars, mockAvatarUrl, UNLINKED_USER_IDS } from '../avatars.js';
import { seededPeople } from '../people.js';
import { listUsers } from '../../providers/identity.js';
import { userAvatars } from '../../providers/user-avatars.js';
import { claimableAvatarUrl, realtimeClaims } from '../../lib/realtime-token.js';

const PUBLIC = resolve(__dirname, '../../../../portal/public');

afterEach(() => fixtureRegistry.resetAll('default'));

describe('mock avatars', () => {
  it('covers every seeded person, unlinked app user and the generic demo session', async () => {
    const ids = new Set(avatars.rows().map((row) => row.subjectId));
    for (const person of seededPeople) expect(ids.has(person.id)).toBe(true);
    expect(ids.has('demo-user')).toBe(true);
    const unlinked = (await listUsers()).filter((user) => user.personId === null).map((user) => user.id).sort();
    expect([...UNLINKED_USER_IDS].sort()).toEqual(unlinked);
  });

  it('names a checked-in file for every row, and the generator index agrees', () => {
    const index = JSON.parse(readFileSync(join(PUBLIC, 'avatars', 'index.json'), 'utf8')) as { avatars: Array<{ id: string; url: string | null }> };
    const indexed = new Map(index.avatars.map((a) => [a.id, a.url]));
    const hashes = new Set<string>();
    for (const row of avatars.rows()) {
      expect(row.url).toBe(`/avatars/photos/${row.subjectId}.jpg`);
      const path = join(PUBLIC, row.url!);
      expect(existsSync(path)).toBe(true);
      const bytes = readFileSync(path);
      expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      const hash = createHash('sha256').update(bytes).digest('hex');
      expect(hashes.has(hash)).toBe(false);
      hashes.add(hash);
      expect(indexed.get(row.subjectId)).toBe(row.url);
    }
    expect(indexed.size).toBe(avatars.rows().length);
  });

  it('answers null outside the cast and under the empty scenario', () => {
    expect(mockAvatarUrl('p-large-00-001')).toBeNull();
    expect(mockAvatarUrl(null)).toBeNull();
    fixtureRegistry.resetAll('empty');
    expect(mockAvatarUrl('p-001')).toBeNull();
  });

  it("gives a linked user their person's face and an unlinked user their own", async () => {
    const map = await userAvatars([{ id: 'u-theo', personId: 'p-001' }, { id: 'u-mira', personId: null }, { id: 'u-new', personId: null }, { id: 'demo-user', personId: null }]);
    expect(map.get('u-theo')).toBe('/avatars/photos/p-001.jpg');
    expect(map.get('u-mira')).toBe('/avatars/photos/u-mira.jpg');
    expect(map.get('u-new')).toBeNull();
    expect(map.get('demo-user')).toBe('/avatars/photos/demo-user.jpg');
  });
});

describe('avatar claim', () => {
  it('accepts a same-origin path or an https URL only', () => {
    expect(claimableAvatarUrl('/avatars/p-001.svg')).toBe('/avatars/p-001.svg');
    expect(claimableAvatarUrl('https://cdn.example/a.png')).toBe('https://cdn.example/a.png');
    for (const bad of ['//evil.example/a.png', 'javascript:alert(1)', 'http://x/a.png', '', 7, null, `/${'a'.repeat(600)}`]) {
      expect(claimableAvatarUrl(bad)).toBeUndefined();
    }
  });

  it('carries the directory avatar on the realtime token, and leaves it off when absent', () => {
    const session = { sub: 'u-mira', name: 'Mira Okafor', tenant: 'social', role: 'community-admin', grants: { social: ['community-admin'] } } as never;
    expect(realtimeClaims(session, { avatarUrl: '/avatars/u-mira.svg' }).avatarUrl).toBe('/avatars/u-mira.svg');
    expect('avatarUrl' in realtimeClaims(session, { avatarUrl: null })).toBe(false);
  });
});
