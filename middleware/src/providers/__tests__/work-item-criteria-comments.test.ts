// Acceptance-criteria checklist + comments (mock path) — providers/work-items.ts.
//
// The route layer (routes/__tests__/work-item-criteria-comments.test.ts) pins
// the HTTP contract with the provider mocked; this file pins the provider
// itself against the REAL mock fixtures (work-item-criteria.ts,
// work-item-comments.ts, people.ts), because the renumbering logic is where a
// bug would actually hide — an off-by-one in a splice, not in the routing.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import {
  listWorkItemCriteria,
  createWorkItemCriterion,
  updateWorkItemCriterion,
  deleteWorkItemCriterion,
  listWorkItemComments,
  createWorkItemComment,
  addWorkItemComment,
} from '../work-items.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { workItemCriteria } from '../../mock/work-item-criteria.js';
import { workItemComments } from '../../mock/work-item-comments.js';
import { fixtureRegistry, freezeClock } from '../../mock/core/index.js';

const NOON = '2026-09-23T12:00:00.000Z';

beforeEach(() => {
  freezeClock(NOON);
  workItemCriteria.reset();
  workItemComments.reset();
  socialChannelMessagesFixture.reset();
  socialChannelMembersFixture.reset();
});

const LAYLA = { userId: 'u-layla', displayName: 'Layla Hassan', personId: 'p-008' };

describe('registration', () => {
  it('registers with the real fixture registry the control plane resets', () => {
    expect(fixtureRegistry.get('work-item-criteria')).toBe(workItemCriteria);
  });
});

describe('listWorkItemCriteria', () => {
  it('returns the seeded checklist for wi-obs-e1-s4, ordered by position', async () => {
    const rows = await listWorkItemCriteria('wi-obs-e1-s4');
    expect(rows.map((r) => r.text)).toEqual([
      'Route metrics through the collector',
      'Verify dashboard and alert parity',
      'Keep a rollback path during migration',
    ]);
    expect(rows.every((r) => r.done === false)).toBe(true);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it('returns a mix of done/open for wi-obs-e3-s2', async () => {
    const rows = await listWorkItemCriteria('wi-obs-e3-s2');
    expect(rows.map((r) => r.done)).toEqual([true, true, false]);
  });

  it('answers empty for a work item with no checklist', async () => {
    expect(await listWorkItemCriteria('wi-obs-e2-s2')).toEqual([]);
  });
});

describe('createWorkItemCriterion', () => {
  it('appends at the end with a dense position', async () => {
    const created = await createWorkItemCriterion('wi-obs-e1-s4', 'Confirm no consumer still reads the old StatsD topic');
    expect(created.position).toBe(3);
    expect(created.done).toBe(false);
    expect(created.createdAt).toBe(NOON);
    expect(created.id).toMatch(/^wicr-/);

    const rows = await listWorkItemCriteria('wi-obs-e1-s4');
    expect(rows).toHaveLength(4);
    expect(rows[3]!.id).toBe(created.id);
  });

  it('starts a fresh work item at position 0', async () => {
    const created = await createWorkItemCriterion('wi-obs-e2-s2', 'First criterion');
    expect(created.position).toBe(0);
  });
});

describe('updateWorkItemCriterion', () => {
  it('edits text and done without touching position', async () => {
    const before = (await listWorkItemCriteria('wi-obs-e1-s4'))[0]!;
    const updated = await updateWorkItemCriterion('wi-obs-e1-s4', before.id, { done: true });
    expect(updated?.done).toBe(true);
    expect(updated?.text).toBe(before.text);
    expect(updated?.position).toBe(0);
    expect(updated?.updatedAt).toBe(NOON);
  });

  it('moving an item to the end renumbers every sibling densely', async () => {
    const rows = await listWorkItemCriteria('wi-obs-e1-s4');
    const first = rows[0]!; // 'Route metrics through the collector'
    const moved = await updateWorkItemCriterion('wi-obs-e1-s4', first.id, { position: 2 });
    expect(moved?.position).toBe(2);

    const after = await listWorkItemCriteria('wi-obs-e1-s4');
    expect(after.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(after.map((r) => r.text)).toEqual([
      'Verify dashboard and alert parity',
      'Keep a rollback path during migration',
      'Route metrics through the collector',
    ]);
  });

  it('clamps an out-of-range position instead of erroring', async () => {
    const rows = await listWorkItemCriteria('wi-obs-e1-s4');
    const last = rows[2]!;
    const moved = await updateWorkItemCriterion('wi-obs-e1-s4', last.id, { position: 999 });
    expect(moved?.position).toBe(2); // clamps to the end (n-1)

    const after = await listWorkItemCriteria('wi-obs-e1-s4');
    expect(after.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it('returns null for a criterion id that exists under a DIFFERENT work item', async () => {
    const rows = await listWorkItemCriteria('wi-obs-e1-s4');
    const result = await updateWorkItemCriterion('wi-obs-e3-s1', rows[0]!.id, { done: true });
    expect(result).toBeNull();
  });

  it('returns null for an unknown criterion id', async () => {
    expect(await updateWorkItemCriterion('wi-obs-e1-s4', 'wicr-does-not-exist', { done: true })).toBeNull();
  });
});

describe('deleteWorkItemCriterion', () => {
  it('removes the row and renumbers the remaining siblings densely', async () => {
    const rows = await listWorkItemCriteria('wi-obs-e1-s4');
    const middle = rows[1]!; // 'Verify dashboard and alert parity'
    expect(await deleteWorkItemCriterion('wi-obs-e1-s4', middle.id)).toBe(true);

    const after = await listWorkItemCriteria('wi-obs-e1-s4');
    expect(after.map((r) => r.text)).toEqual([
      'Route metrics through the collector',
      'Keep a rollback path during migration',
    ]);
    expect(after.map((r) => r.position)).toEqual([0, 1]);
  });

  it('returns false for an unknown criterion id', async () => {
    expect(await deleteWorkItemCriterion('wi-obs-e1-s4', 'wicr-nope')).toBe(false);
  });

  it('returns false for a criterion under the wrong work item', async () => {
    const rows = await listWorkItemCriteria('wi-obs-e1-s4');
    expect(await deleteWorkItemCriterion('wi-obs-e3-s1', rows[0]!.id)).toBe(false);
  });
});

describe('reset restores the seeded checklist', () => {
  it('undoes a create, an edit and a delete', async () => {
    const created = await createWorkItemCriterion('wi-obs-e1-s4', 'Extra');
    await updateWorkItemCriterion('wi-obs-e1-s4', created.id, { done: true });
    await deleteWorkItemCriterion('wi-obs-e1-s4', (await listWorkItemCriteria('wi-obs-e1-s4'))[0]!.id);

    workItemCriteria.reset();

    const rows = await listWorkItemCriteria('wi-obs-e1-s4');
    expect(rows.map((r) => r.text)).toEqual([
      'Route metrics through the collector',
      'Verify dashboard and alert parity',
      'Keep a rollback path during migration',
    ]);
  });
});

describe('listWorkItemComments', () => {
  it('orders oldest-first and resolves author name + title', async () => {
    const { comments, total } = await listWorkItemComments('wi-obs-e1-b5');
    expect(comments.map((c) => c.id)).toEqual(['wic-prog-1', 'wic-prog-2']);
    expect(comments[0]!.authorName).toBe('Layla Hassan');
    expect(comments[0]!.authorTitle).toBe('SRE Lead');
    expect(comments[1]!.authorName).toBe('Nora DaSilva');
    expect(total).toBe(2);
  });

  it('answers empty for a work item with no comments', async () => {
    expect(await listWorkItemComments('wi-obs-e2-b4')).toEqual({ comments: [], total: 0 });
  });

  it('the two fixed-age planning notes on wi-obs-e1-s4 are Nora and Eli', async () => {
    const { comments } = await listWorkItemComments('wi-obs-e1-s4');
    expect(comments.map((c) => c.authorName)).toEqual(['Nora DaSilva', 'Eli Garcia']);
    expect(comments.every((c) => c.isSystem === false)).toBe(true);
  });
});

describe('createWorkItemComment — one store: the thread', () => {
  it('posts on orgiq:work:<id> with the session user as sender and the clock timestamp', async () => {
    const before = workItemComments.rows().length;
    const comment = await createWorkItemComment('wi-obs-e1-s4', LAYLA, 'Sequencing looks right to me.');
    expect(comment.authorName).toBe('Layla Hassan');
    expect(comment.authorTitle).toBe('SRE Lead');
    expect(comment.isSystem).toBe(false);
    expect(comment.createdAt).toBe(NOON);
    // The comments table is audit history: the write never lands there.
    expect(workItemComments.rows()).toHaveLength(before);
    const stored = socialChannelMessagesFixture.rows().find((m) => m.id === comment.id)!;
    expect(stored).toMatchObject({ channel: 'orgiq:work:wi-obs-e1-s4', userId: 'u-layla', message: 'Sequencing looks right to me.',
      metadata: { displayName: 'Layla Hassan', authorPersonId: 'p-008' } });

    const { comments, total } = await listWorkItemComments('wi-obs-e1-s4');
    expect(comments).toHaveLength(3);
    expect(comments[2]!.id).toBe(comment.id);
    expect(total).toBe(3);
  });

  it('reset of the thread fixture undoes the post', async () => {
    await createWorkItemComment('wi-obs-e1-s4', LAYLA, 'Temporary note.');
    socialChannelMessagesFixture.reset();
    const { comments } = await listWorkItemComments('wi-obs-e1-s4');
    expect(comments).toHaveLength(2);
  });

  it('the table refuses a human row: addWorkItemComment is audit-only', async () => {
    await expect(addWorkItemComment('wi-obs-e1-s4', 'a human note', { authorId: 'p-008' })).rejects.toThrow(/audit-only/);
    await addWorkItemComment('wi-obs-e1-s4', 'Status changed from open to done', { authorId: 'p-008', isSystem: true });
    const { comments, total } = await listWorkItemComments('wi-obs-e1-s4');
    expect(comments.filter((c) => c.isSystem).map((c) => c.body)).toEqual(['Status changed from open to done']);
    expect(total).toBe(2);
  });
});

describe('listWorkItemComments — history floor', () => {
  it('a reader whose history starts after a comment does not read it (strictly after historyFrom)', async () => {
    const channel = 'orgiq:work:wi-obs-e1-b5';
    const [first, second] = socialChannelMessagesFixture.rows().filter((m) => m.channel === channel)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    socialChannelMembersFixture.rows().push({ channel, userId: 'u-late', role: 'member', addedBy: 'u-nora',
      addedAt: second!.timestamp, historyFrom: first!.timestamp, removedAt: null });
    expect((await listWorkItemComments('wi-obs-e1-b5', 'u-late')).comments.map((c) => c.id)).toEqual(['wic-prog-2']);
    expect((await listWorkItemComments('wi-obs-e1-b5', null)).comments.map((c) => c.id)).toEqual(['wic-prog-1', 'wic-prog-2']);
  });
});
