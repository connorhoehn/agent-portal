// One tile per person (lib/callTileMerge.ts): the candidate's media, cut short to pid `guest` by the library, joins the
// roster's candidate; nothing else moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inCallCount, mergeCutShortTiles, type TileLike } from '../callTileMerge.ts';

const STREAM = { id: 'stream' };
const me: TileLike & { displayName: string } = { id: 'u-hugo-a1', userId: 'u-hugo', displayName: 'Hugo', isLocal: true, state: 'in-call', participantId: 'u-hugo-a1', stream: STREAM };
const cut = { id: 'guest', userId: 'guest', displayName: 'guest', state: 'in-call', participantId: 'guest', stream: STREAM, cameraOn: true };
const cand = { id: 'guest:inv-1', userId: 'guest:inv-1', displayName: 'Mateo Rossi', state: 'in-call', participantId: 'guest:inv-1-lq3k9', stream: null, cameraOn: false };

test('the cut-short media tile and the roster\'s candidate are one tile with the candidate\'s name and the video', () => {
  const out = mergeCutShortTiles([me, cut, cand]);
  assert.equal(out.length, 2);
  const joined = out[1] as typeof cand;
  assert.equal(joined.userId, 'guest:inv-1');
  assert.equal(joined.displayName, 'Mateo Rossi');
  assert.equal(joined.stream, STREAM);
  assert.equal(joined.cameraOn, true);
  assert.equal(joined.participantId, 'guest:inv-1-lq3k9');
  assert.equal(inCallCount(out), 2);
});

test('leaves everything else alone: matched tiles, no owner, two possible owners, the local tile', () => {
  const staff = { id: 'u-wen-b2', userId: 'u-wen', state: 'in-call', participantId: 'u-wen-b2', stream: STREAM };
  const plain = [me, staff];
  assert.equal(mergeCutShortTiles(plain), plain);
  const lonely = [me, cut];
  assert.equal(mergeCutShortTiles(lonely), lonely);
  const two = [me, cut, cand, { ...cand, id: 'guest:inv-2', userId: 'guest:inv-2', participantId: 'guest:inv-2-zz' }];
  assert.equal(mergeCutShortTiles(two), two);
  const withVideo = [me, cut, { ...cand, stream: STREAM }];
  assert.equal(mergeCutShortTiles(withVideo), withVideo);
  const noId = mergeCutShortTiles([me, cut, { ...cand, participantId: null }]);
  assert.equal(noId.length, 2);
  assert.equal((noId[1] as typeof cand).displayName, 'Mateo Rossi');
});
