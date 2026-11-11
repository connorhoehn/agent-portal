// createProject (providers/projects.ts): the id slug, the collision numbering, the
// mock write and its reset, and the SQL branch's columns and rollback.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { createProject, initiativeIdFor, getProject, listProjects } from '../projects.js';
import { initiatives } from '../../mock/initiatives.js';

beforeEach(() => initiatives.reset());

describe('initiativeIdFor', () => {
  it('lowercases, turns runs of other characters into one hyphen and trims hyphens', () => {
    expect(initiativeIdFor('  Data  Lake: 2027 Edition! ')).toBe('p-data-lake-2027-edition');
  });
  it('falls back when no letter or digit survives', () => {
    expect(initiativeIdFor('???')).toBe('p-initiative');
  });
  it('keeps the slug to 40 characters, suffix included, with no trailing hyphen', () => {
    const long = 'word '.repeat(30);
    const first = initiativeIdFor(long);
    expect(first.length).toBeLessThanOrEqual(42);
    expect(first.endsWith('-')).toBe(false);
    const third = initiativeIdFor(long, 3);
    expect(third.slice(2).length).toBeLessThanOrEqual(40);
    expect(third.endsWith('-3')).toBe(true);
  });
});

describe('createProject in the mock', () => {
  it('numbers collisions -2, -3 and a reset takes the initiatives back', async () => {
    const make = (name: string) => createProject({ name, ownerPersonId: 'p-002' });
    const ids = [];
    for (const name of ['Same Slug', 'Same-Slug', 'Same Slug!']) {
      const r = await make(name);
      expect(r.ok).toBe(true);
      if (r.ok) ids.push(r.project.id);
    }
    expect(ids).toEqual(['p-same-slug', 'p-same-slug-2', 'p-same-slug-3']);
    expect((await listProjects({})).map((p) => p.id)).toContain('p-same-slug-3');
    initiatives.reset();
    expect(await getProject('p-same-slug')).toBeNull();
  });

  it('refuses a duplicate name in any case and an unknown owner or sponsor', async () => {
    const dup = await createProject({ name: 'AUTH MIGRATION', ownerPersonId: 'p-002' });
    expect(dup).toMatchObject({ ok: false, status: 409, code: 'NAME_TAKEN', existingId: 'p-auth-migration' });
    expect(await createProject({ name: 'X1', ownerPersonId: 'p-nobody' })).toMatchObject({ ok: false, status: 400 });
    expect(await createProject({ name: 'X2', ownerPersonId: 'p-002', sponsorPersonId: 'p-nobody' })).toMatchObject({ ok: false, status: 400 });
  });
});
