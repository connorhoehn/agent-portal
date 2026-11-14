// /iq/meetings/:callId — what the meeting assistant left behind: who was there, the summary, decisions, action items
// and the transcript. Only the people who were in the call can read it; everyone else, admins included, gets the
// same "not found" the server gives them. The inviter can delete the record (minutes and transcript together).
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Button, ConfirmDialog, DataTable, DetailPage, DetailSection, EmptyState, Inline, LoadingState, MetaLine, Modal, Stack, T,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { TranscriptPanel } from '@connorhoehn/ui-components/video';
import { useSession } from '../../lib/auth';
import { useFetch } from '../../hooks/useFetch';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { sendJson } from '../../lib/writeJson';
import { NewItemForm, type NewItemDraft } from '../project-detail/NewItemForm';
import { surfaceWriteError } from '../project-detail/writeJson';
import {
  canCreateFor, durationLabel, peopleLabel, transcriptSegments, whenLabel, minutesUrl,
  type MinutesActionItem, type MinutesView,
} from './meetingsModel';
import { useMeetingTranscript } from './useMeetingTranscript';

export default function MeetingPage() {
  const { callId = '' } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  const minutes = useFetch<MinutesView>(callId ? minutesUrl(callId) : null);
  const transcript = useMeetingTranscript(minutes.data ? callId : null);
  const [drafting, setDrafting] = useState<MinutesActionItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);

  if (minutes.isLoading && !minutes.data) return <LoadingState label="Loading the meeting…" />;
  const m = minutes.data;
  if (!m && minutes.failure && minutes.failure.status !== 404) {
    return <EmptyState testId="meeting-error" title="This meeting could not be loaded"
      description={minutes.failure.message} action={<Button size="sm" variant="secondary" data-testid="meeting-retry" onClick={minutes.refresh}>Try again</Button>} />;
  }
  if (!m) {
    return <EmptyState testId="meeting-not-found" title="Meeting not found"
      description="There is no meeting record here, or you were not in that call. Only the people who were in a call can read its minutes." />;
  }

  const viewer = session?.sub ?? null;
  const names = m.attendees.map((a) => a.name);
  const createItem = async (draft: NewItemDraft) => {
    setDrafting(null);
    if (!m.initiativeId || creating) return;
    setCreating(true);
    try {
      const created = await sendJson<{ id?: string }>('/api/graph/work-items', 'POST', {
        projectId: m.initiativeId, parentId: null, type: draft.type, title: draft.title, priority: draft.priority, storyPoints: draft.storyPoints,
      });
      toastSuccess(null, 'Work item created', created.id ? draft.title : undefined);
    } catch (err) { surfaceWriteError(err, 'Creating this work item'); } finally { setCreating(false); }
  };
  const deleteRecord = async () => {
    setDeleting(true);
    try { await sendJson(`/api/calls/${encodeURIComponent(callId)}/assistant/minutes`, 'DELETE'); navigate('/iq/meetings'); } catch (err) {
      toastError(null, 'Could not delete this record', err instanceof Error ? err.message : String(err));
    } finally { setDeleting(false); setConfirmDelete(false); }
  };

  const columns: DataTableColumn<MinutesActionItem>[] = [
    { key: 'text', header: 'Action item', render: (i) => <T size="sm">{i.text}</T> },
    { key: 'owner', header: 'Owner', width: '208px', render: (i) => <T size="sm">{i.ownerName ?? 'Nobody named'}</T> },
    { key: 'create', header: '', width: '176px', render: (i) => (m.initiativeId && canCreateFor(i, viewer)
      ? <Button size="sm" variant="secondary" data-testid="meeting-create-work-item" disabled={creating || drafting !== null} onClick={() => setDrafting(i)}>Create work item</Button>
      : i.done ? <T size="sm" tone="secondary">Done in the call</T> : null) },
  ];

  return (
    <>
      <DetailPage
        data-testid="meeting-page"
        title={m.callName}
        meta={<MetaLine size="sm" items={[whenLabel(m.startedAt), durationLabel(m.startedAt, m.endedAt), peopleLabel(names), `Nova invited by ${m.invitedByName}`]} />}
        actions={m.youAreInviter
          ? <Button variant="danger" size="sm" data-testid="meeting-delete" onClick={() => setConfirmDelete(true)}>Delete this record</Button> : undefined}
      >
        <Stack gap="md" className="pb-6">
          <DetailSection title="Summary" as="h2" first>
            <T size="sm" data-testid="meeting-summary">{m.summary}</T>
          </DetailSection>
          <DetailSection title="Decisions" as="h2" hint={String(m.decisions.length)}>
            {m.decisions.length
              ? <Stack gap="xs" data-testid="meeting-decisions">{m.decisions.map((d, i) => <T key={i} size="sm">{d}</T>)}</Stack>
              : <T size="sm" tone="secondary">No decisions were recorded.</T>}
          </DetailSection>
          <DetailSection title="Action items" as="h2" hint={String(m.actionItems.length)}>
            {m.actionItems.length
              ? <DataTable data={m.actionItems} columns={columns} keyField={(i) => `${i.text}|${i.ownerUserId ?? ''}`} narrow data-testid="meeting-action-items" />
              : <T size="sm" tone="secondary">No action items were recorded.</T>}
          </DetailSection>
          <DetailSection title="Transcript" as="h2" hint={`${m.lineCount} ${m.lineCount === 1 ? 'line' : 'lines'}`}>
            <TranscriptPanel
              title="By speaker"
              status={transcript.error ? 'failed' : transcript.lines.length || !transcript.loading ? 'ready' : 'processing'}
              segments={transcriptSegments(transcript.lines, m.attendees, m.startedAt)}
              {...(transcript.error ? { errorMessage: transcript.error } : {})}
              idleState={<T size="sm" tone="secondary">Nothing was transcribed.</T>}
            />
            {transcript.hasMore && (
              <Inline justify="center" className="pt-2">
                <Button size="sm" variant="secondary" data-testid="meeting-more-transcript" disabled={transcript.loading} onClick={transcript.loadMore}>Load more lines</Button>
              </Inline>
            )}
          </DetailSection>
        </Stack>
      </DetailPage>

      {drafting && (
        <Modal open onClose={() => setDrafting(null)} ariaLabel="New work item from this meeting" maxWidth={560}>
          <NewItemForm defaultType="story" typeOptions={['story', 'bug']} defaultTitle={drafting.text}
            onSave={(draft) => void createItem(draft)} onCancel={() => setDrafting(null)} />
        </Modal>
      )}
      <ConfirmDialog
        open={confirmDelete}
        tone="destructive"
        title="Delete this meeting record?"
        body="The minutes and the transcript are deleted for everyone who was in the call, and Nova will not write them again. Work items created from them stay."
        confirmLabel={deleting ? 'Deleting…' : 'Delete record'}
        confirmDisabled={deleting}
        onConfirm={() => void deleteRecord()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
