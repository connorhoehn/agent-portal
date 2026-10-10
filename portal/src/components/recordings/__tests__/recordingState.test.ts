import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingHref, recordingIsProcessing, recordingProcessingLabel, recordingStage } from '../recordingState.ts';
const ready = { recordingId: 'r', lobbyName: 'orgiq:initiative:p', startedAt: '2026-10-10T12:00:00Z', composeStatus: 'ok' };
test('media, transcript and summary have independent readiness and failure states', () => {
  assert.equal(recordingStage({ ...ready, transcriptStatus: 'processing' }), 'transcribing');
  assert.equal(recordingStage({ ...ready, transcriptStatus: 'ready', summaryStatus: 'processing' }), 'summarizing');
  const partial = { ...ready, transcriptStatus: 'ready' as const, summaryStatus: 'failed' as const };
  assert.equal(recordingStage(partial), 'ready'); // Ready to watch is media readiness, not a false successful summary.
  assert.equal(recordingIsProcessing(partial), false);
  assert.equal(recordingProcessingLabel(partial), 'Video and transcript ready · Summary failed');
  assert.equal(recordingProcessingLabel({ ...ready, transcriptStatus: 'failed' }), 'Video ready · Transcript failed');
});
test('recording links retain canonical exact subject and asset, never a cross-tenant fallback', () => {
  assert.equal(recordingHref('orgiq:initiative:p-observability', 'exact id'), '/iq/projects/p-observability?tab=docs&recording=exact+id');
  assert.equal(recordingHref('assessment:team:TEAM-005', 'exact'), '/assessment/teams/TEAM-005?tab=documents&recording=exact');
  assert.equal(recordingHref('social:dm:private'), null);
});


test('native requested transcription keeps polling through the compose-to-enqueue gap', () => {
  const row = { recordingId: 'rec-requested', lobbyName: 'orgiq:initiative:p1', startedAt: '2026-10-10T00:00:00Z', composeStatus: 'ok' };
  assert.equal(recordingIsProcessing({ ...row, transcriptionRequested: true }), true);
  assert.equal(recordingProcessingLabel({ ...row, transcriptionRequested: true }), 'Waiting for transcription');
  assert.equal(recordingIsProcessing({ ...row, transcriptionRequested: false }), false);
  assert.equal(recordingProcessingLabel(row), 'Recording ready');
});
