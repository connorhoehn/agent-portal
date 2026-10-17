import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationCallDockProps, ConversationCallDockState } from '@connorhoehn/realtime-modules/client/video';
import { separateCallScreenTiles } from '../callScreenTiles.ts';

const state = (screenSharing: boolean, readyState = 'live') => ({
  call: { participants: [{ id: 'vera', displayName: 'Vera', isLocal: true, screenSharing,
    screenStream: { getVideoTracks: () => [{ readyState }] } }, { id: 'nora', displayName: 'Nora', isLocal: false, screenSharing,
    screenStream: { getVideoTracks: () => [{ readyState }] } }] },
}) as unknown as ConversationCallDockState;
const dock = { participantCount: 2, localParticipantId: 'vera', participants: [
  { id: 'vera', userId: 'vera', displayName: 'Vera', isLocal: true, screenSharing: true, cameraOn: false, videoElement: 'vera-camera', connection: 'connected' },
  { id: 'nora', userId: 'nora', displayName: 'Nora', isLocal: false, screenSharing: true, cameraOn: true, videoElement: 'nora-camera-with-audio', connection: 'connected' },
] } as ConversationCallDockProps;

test('local and remote shares add independent tiles while preserving cameras, voice and person count', () => {
  const result = separateCallScreenTiles(state(true), dock, person => `${person.id}-screen`)!;
  assert.equal(result.participantCount, 2);
  assert.equal(result.localParticipantId, 'vera');
  assert.deepEqual(result.participants.map(tile => [tile.id, tile.videoElement]), [
    ['vera', 'vera-camera'], ['vera:screen', 'vera-screen'], ['nora', 'nora-camera-with-audio'], ['nora:screen', 'nora-screen'],
  ]);
  assert.equal(result.participants[0].cameraOn, false);
  assert.equal(result.participants[0].screenSharing, false);
  assert.equal(result.participants[1].audioElement, undefined);
  assert.equal(result.participants[3].audioElement, undefined);
  assert.equal(new Set(result.participants.map(tile => tile.userId)).size, 4);
});

test('stopping or ending capture removes only the screen tile', () => {
  for (const current of [state(false), state(true, 'ended')]) {
    const result = separateCallScreenTiles(current, dock, () => { throw new Error('Stopped capture must not be rendered'); })!;
    assert.deepEqual(result.participants.map(tile => tile.id), ['vera', 'nora']);
    assert.equal(result.participants[1].videoElement, 'nora-camera-with-audio');
  }
  assert.equal(separateCallScreenTiles(state(false), null, () => ''), null);
});
