import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingPipelineAcceptance as check } from './recording-pipeline-acceptance.mjs';

const recording = { recordingId: 'r', channelArn: 'channel', endedAt: '2026-10-10T12:00:00Z',
  composeStatus: 'ok', transcriptStatus: 'ready', transcriptSpeechSegments: 4,
  summaryStatus: 'ready', summaryChars: 100, summaryRunId: 'attempt-2' };
const finalize = { recordingId: 'r', pipelineId: 'recording-finalize', status: 'completed' };
const run = { recordingId: 'r', pipelineId: 'call-transcription', runId: 'attempt-2', status: 'completed', startedAt: '2026-10-10T12:00:00Z' };
const sfu = [{ channelArn: 'channel', recordings: [{ recordingId: 'r', composeStatus: 'ok' }] }];
const strict = (row = recording, runs = [finalize, run]) => check([row], runs, sfu, { requireSummary: true });

test('a completed native pipeline with stored speech and summary passes', () => {
  assert.equal(strict().observationFinished, true);
});
test('a failed summary is settled for observation but cannot pass summary acceptance', () => {
  const row = { ...recording, summaryStatus: 'failed', summaryChars: 0 };
  const runs = [finalize, { ...run, status: 'failed' }];
  assert.equal(check([row], runs, sfu, { waitPipeline: true }).observationFinished, true);
  assert.equal(strict(row, runs).observationFinished, false);
});
test('ready metadata alone cannot certify empty or silent artifacts', () => {
  assert.equal(strict({ ...recording, transcriptSpeechSegments: 0 }).observationFinished, false);
  assert.equal(strict({ ...recording, summaryChars: 0 }).observationFinished, false);
  assert.equal(strict({ ...recording, summaryStatus: 'skipped' }).observationFinished, false);
});
test('an old completed attempt cannot certify the current pending summary', () => {
  const runs = [finalize, { ...run, runId: 'attempt-1', startedAt: '2026-10-10T11:00:00Z' }, { ...run, status: 'running' }];
  assert.equal(strict(recording, runs).observationFinished, false);
  assert.equal(strict(recording, runs).withTerminalTranscription, 0);
  assert.equal(strict(recording, [finalize, { ...run, runId: 'attempt-1' }]).observationFinished, false);
});
test('a new transcription cannot borrow the previous attempt’s stored summary', () => {
  const runs = [finalize, run, { ...run, runId: 'attempt-3', status: 'running', startedAt: '2026-10-10T13:00:00Z' }];
  assert.equal(strict(recording, runs).observationFinished, false);
});
test('legacy rows use newest attempt rather than any old terminal attempt', () => {
  const row = { ...recording, summaryRunId: undefined };
  const runs = [finalize, { ...run, startedAt: '2026-10-10T11:00:00Z' },
    { ...run, runId: 'new', status: 'running', startedAt: '2026-10-10T12:00:00Z' }];
  assert.equal(strict(row, runs).observationFinished, false);
});
test('duplicates and unrelated composed media do not satisfy expected recordings', () => {
  assert.equal(check([recording, recording], [finalize, run], sfu, { expected: 2, requireSummary: true }).observationFinished, false);
  assert.equal(check([recording], [finalize, run], [{ channelArn: 'other', recordings: sfu[0].recordings }], { requireSummary: true }).observationFinished, false);
});
