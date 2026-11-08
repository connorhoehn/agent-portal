import type { RecordingStage } from '@connorhoehn/ui-components/social';
import type { InitiativeRecording, RecordingProgress } from '../../pages/projects/initiativeRecordingApi.ts';
import { documentRecordingHref, type DocumentRecordingNavigation } from './documentRecordingContext.ts';

const active = (status: string | undefined) => status === 'pending' || status === 'processing';
export function recordingStage(row: InitiativeRecording): RecordingStage {
  if (row.composeStatus === 'failed' || row.composeStatus === 'skipped') return 'failed';
  if (!['ok', 'degraded'].includes(row.composeStatus ?? '')) return 'saving';
  if ((row.transcriptionRequested === true && !row.transcriptStatus) || active(row.transcriptStatus)) return 'transcribing';
  if (active(row.summaryStatus)) return 'summarizing';
  return 'ready';
}
export function recordingIsProcessing(row: InitiativeRecording): boolean {
  return ['saving', 'transcribing', 'summarizing'].includes(recordingStage(row));
}
export function recordingProcessingLabel(row: InitiativeRecording): string {
  const stage = recordingStage(row);
  if (stage === 'saving') return 'Saving recording';
  if (stage === 'transcribing') return row.transcriptStatus ? 'Creating transcript' : 'Waiting for transcription';
  if (stage === 'summarizing') return 'Creating summary';
  if (stage === 'failed') return 'Recording could not be prepared';
  if (row.transcriptStatus === 'failed') return 'Video ready · Transcript failed';
  if (row.summaryStatus === 'failed') return 'Video and transcript ready · Summary failed';
  if (row.summaryStatus === 'ready') return 'Recording, transcript and summary ready';
  return row.transcriptStatus === 'ready' ? 'Recording and transcript ready' : 'Recording ready';
}
export function recordingHref(lobby: string, recordingId?: string, document?: DocumentRecordingNavigation): string | null {
  if (document) return documentRecordingHref(lobby, document, recordingId);
  const project = /^orgiq:initiative:([^:]+)$/.exec(lobby)?.[1];
  const team = /^assessment:team:([^:]+)$/.exec(lobby)?.[1];
  if (!project && !team) return null;
  const query = new URLSearchParams({ tab: project ? 'docs' : 'documents' });
  if (recordingId) query.set('recording', recordingId);
  return `${project ? '/iq/projects/' : '/assessment/teams/'}${encodeURIComponent(project ?? team!)}?${query}`;
}
export function progressDelay(value: Pick<RecordingProgress, 'terminal' | 'retryAfterMs'>): number | null {
  return value.terminal ? null : Math.max(5000, Math.min(60000, value.retryAfterMs ?? 5000));
}
