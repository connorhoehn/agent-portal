// Run with:  cd portal && node --test 'src/pages/social/__tests__/socialRoomSummary.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isRoomLobby, roomSummarizeApi, roomSummarizeText, roomSummaryTargets } from '../socialRoomSummary.ts';
import type { SocialChannel, SocialDm } from '../socialChat.ts';

const ch = (slug: string, joined: boolean) => ({ slug, channel: `social:ch:${slug}`, name: slug[0]!.toUpperCase() + slug.slice(1), joined }) as unknown as SocialChannel;
const dm = { channel: 'social:dm:u-lena:u-sana', peers: [{ userId: 'u-lena', displayName: 'Lena Brandt' }] } as unknown as SocialDm;

test('only a room lobby is summarized into the pane; a DM lobby uses its DM', () => {
  assert.equal(isRoomLobby('social:room:town-hall'), true);
  assert.equal(isRoomLobby('social:dm:u-lena:u-sana'), false);
  assert.equal(isRoomLobby('social:ch:general'), false);
  assert.equal(roomSummarizeText('rec-1'), '--recording rec-1');
});

test('post targets are the joined channels then the direct messages', () => {
  assert.deepEqual(roomSummaryTargets([ch('general', true), ch('moderators', false)], [dm]), [
    { channel: 'social:ch:general', label: '# General' },
    { channel: dm.channel, label: 'Lena Brandt' },
  ]);
});

test('Post refuses without a target, sends the target, and rejects a reply addressed elsewhere', async () => {
  const none = roomSummarizeApi(() => null);
  await assert.rejects(none.requestPost('sum-1'), /Choose where to post/);
  let body = '';
  const ok = (async (_u: string, init: RequestInit) => { body = String(init.body); return new Response(JSON.stringify({ channel: 'social:ch:general', text: 't', metadata: {} }), { status: 200 }); }) as unknown as typeof fetch;
  assert.equal((await roomSummarizeApi(() => 'social:ch:general', ok).requestPost('sum-1')).channel, 'social:ch:general');
  assert.deepEqual(JSON.parse(body), { channel: 'social:ch:general' });
  const wrong = (async () => new Response(JSON.stringify({ channel: 'social:ch:other', text: 't', metadata: {} }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(roomSummarizeApi(() => 'social:ch:general', wrong).requestPost('sum-1'), /another conversation/);
  const denied = (async () => new Response(JSON.stringify({ error: 'Not a member of this conversation' }), { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(roomSummarizeApi(() => 'social:ch:general', denied).requestPost('sum-1'), /Not a member/);
});
