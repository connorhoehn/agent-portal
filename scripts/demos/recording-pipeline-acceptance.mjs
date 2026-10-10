// Read-only acceptance rules. A terminal run is not necessarily a usable artifact.
export function recordingPipelineAcceptance(recordings, pipelines, sfuRows, {
  expected = 1, waitPipeline = false, requireSummary = false,
} = {}) {
  const unique = [...new Map(recordings.map(row => [row.recordingId, row])).values()];
  const composed = unique.filter(recording => recording.endedAt
    && ['ok', 'degraded'].includes(recording.composeStatus)
    && sfuRows.some(channel => channel.channelArn === recording.channelArn
      && channel.recordings?.some(row => row.recordingId === recording.recordingId
        && ['ok', 'degraded'].includes(row.composeStatus)))
    && pipelines.some(run => run.recordingId === recording.recordingId
      && run.pipelineId === 'recording-finalize' && run.status === 'completed'));
  const currentRun = recording => {
    const runs = pipelines.filter(run => run.recordingId === recording.recordingId
      && run.pipelineId === 'call-transcription');
    const latest = runs.sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0))[0];
    if (recording.summaryRunId && latest?.runId !== recording.summaryRunId) return undefined;
    return latest;
  };
  const terminal = composed.filter(recording => ['completed', 'failed', 'cancelled', 'rejected']
    .includes(currentRun(recording)?.status));
  const ready = composed.filter(recording => recording.transcriptStatus === 'ready'
    && recording.transcriptSpeechSegments > 0 && recording.summaryStatus === 'ready'
    && recording.summaryChars > 0 && currentRun(recording)?.status === 'completed');
  return {
    expected, freshRecordings: unique.length, composedWithCompletedNativeFinalize: composed.length,
    expectedComposed: composed.length >= expected, withTerminalTranscription: terminal.length,
    withStoredTranscriptAndSummary: ready.length, summaryRequired: requireSummary,
    observationFinished: composed.length >= expected
      && (!waitPipeline || terminal.length >= expected)
      && (!requireSummary || ready.length >= expected),
  };
}
