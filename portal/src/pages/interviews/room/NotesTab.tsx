// The room's Notes tab (gap audit 2026-11-20 §5): the signed-in interviewer's own notes on this round, one plain text
// that saves itself a moment after typing stops and says whether it did. Only the author reads them (the server answers
// the session's own and nobody else's); they are offered on the scorecard as its starting summary, never copied on
// their own. Read only once the author's scorecard is in, or the round did not go ahead.
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { FormField, LoadingState, PageSection, Stack, T, Textarea } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { NOTES_PRIVACY_LINE, SAVE_DELAY_MS, myNotesUrl, saveMyNotes, saveStateLine, saveStateTone, type MyNotes, type SaveState } from '../../../lib/interviewsPrivateNotes';
import type { RoomView } from '../../../lib/interviewsRoom';

export function NotesTab({ room }: { room: RoomView }): JSX.Element {
  const { data, error } = useFetch<{ notes: MyNotes }>(myNotesUrl(room.id));
  if (!data) {
    return <PageSection size="sm" title="My notes" description={NOTES_PRIVACY_LINE}>
      {error ? <T size="sm" tone="danger">Your notes could not be read. Reload the page to try again.</T> : <LoadingState label="Reading your notes" />}
    </PageSection>;
  }
  return <NotesEditor key={room.id} interviewId={room.id} initial={data.notes} />;
}

function NotesEditor({ interviewId, initial }: { interviewId: string; initial: MyNotes }): JSX.Element {
  const [body, setBody] = useState(initial.body);
  const [state, setState] = useState<SaveState>('idle');
  const [refusal, setRefusal] = useState(initial.refusal);
  const revision = useRef(initial.revision);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(body);

  const save = useCallback(async () => {
    pending.current = null;
    setState('saving');
    const sent = latest.current;
    const out = await saveMyNotes(interviewId, sent, revision.current);
    if (out.ok) {
      revision.current = out.value.revision;
      // Typing went on while it saved: the next save carries the rest.
      setState(latest.current === sent ? 'saved' : 'saving');
      if (latest.current !== sent) pending.current = setTimeout(() => void save(), SAVE_DELAY_MS);
      return;
    }
    if (out.value) {
      // Saved from another window, or the window closed: the page shows what the server holds.
      revision.current = out.value.revision;
      if (out.stale && out.value.canWrite) { latest.current = out.value.body; setBody(out.value.body); setState('stale'); return; }
      setRefusal(out.value.refusal);
    }
    setState('failed');
  }, [interviewId]);

  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  const onChange = (next: string) => {
    latest.current = next;
    setBody(next);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => void save(), SAVE_DELAY_MS);
  };

  const line = saveStateLine(state, refusal);
  return <PageSection size="sm" title="My notes" description={NOTES_PRIVACY_LINE} data-testid="interview-room-notes">
    <Stack gap="sm">
      <FormField label="Notes on this round" hint={`Plain text, up to ${initial.limits.chars.toLocaleString('en-US')} characters. You can start your scorecard from them.`}>
        {({ labelId: _labelId, ...wiring }) => (
          <Textarea {...wiring} minRows={8} autoResize value={body} maxLength={initial.limits.chars} readOnly={refusal !== null}
            onChange={(e) => onChange(e.target.value)} data-testid="interview-room-notes-text" />
        )}
      </FormField>
      {line && <T size="xs" tone={refusal ? 'secondary' : saveStateTone(state)} aria-live="polite" data-testid="interview-room-notes-state">{line}</T>}
    </Stack>
  </PageSection>;
}
