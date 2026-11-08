import { useState } from 'react';
import { Button, Card, Chip, EmptyState, Inline, InlineAlert, LoadingState, PageSection, Stack, T } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSocialPlane } from './socialPlane';
import { Markdown } from '../../components/Markdown';

interface RoomSession {
  sessionId: string; roomId: string | null; roomName: string; startedAt: string; endedAt: string | null;
  people: Array<{ userId: string; displayName: string; joinedAt: string; leftAt: string | null }>;
  summaries: Array<{ recordingId: string; status: string; text?: string }>;
  recordingEnabled: boolean | null;
}
interface ActivityResponse { sessions: RoomSession[]; cursor?: string }
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function RoomActivity({ slug }: { slug: string }) {
  const { api } = useSocialPlane();
  const url = `${api}/rooms/${encodeURIComponent(slug)}/activity`;
  const read = useFetch<ActivityResponse>(url, 15_000);
  const [older, setOlder] = useState<RoomSession[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursor = next === undefined ? read.data?.cursor : next;
  const rows = [...(read.data?.sessions ?? []), ...older].filter((r, i, all) => all.findIndex(s => s.sessionId === r.sessionId) === i);
  async function more() {
    if (!cursor) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`${url}?cursor=${encodeURIComponent(cursor)}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Earlier activity could not be loaded. Try again.');
      const page = await response.json() as ActivityResponse;
      setOlder(value => [...value, ...page.sessions]); setNext(page.cursor ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Activity unavailable'); }
    finally { setBusy(false); }
  }
  return <Stack gap="md" data-page-activity data-testid="hangout-activity">
    <PageSection size="sm" title="Activity and summaries" description="Participation comes from call attendance. Summaries appear when a recording has been transcribed and processed." />
    {read.isLoading && !read.data ? <LoadingState label="Loading activity…" /> : read.error ? <InlineAlert tone="error">{read.error}</InlineAlert>
      : !rows.length ? <EmptyState align="start" title="No captured activity yet" description="Call participation and available summaries will appear here after people join." />
        : rows.map(row => <Card key={row.sessionId} padding="sm"><Stack gap="md">
          <Inline gap="sm" justify="between"><T weight="semibold">{row.roomName}</T><T size="sm" tone="secondary">{when(row.startedAt)}</T></Inline>
          <T size="sm" tone="secondary">{row.people.length} participated{row.endedAt ? ` · Ended ${when(row.endedAt)}` : ''}</T>
          <Inline gap="xs" wrap>{row.people.map(person => <Chip key={person.userId} size="sm">{person.displayName === person.userId ? 'Name unavailable' : person.displayName}</Chip>)}</Inline>
          {!row.summaries.length && <T size="sm" tone="secondary">{row.recordingEnabled === false ? 'This call was not recorded.' : 'No dialogue summary is available to you yet.'}</T>}
          {row.summaries.map(summary => <Stack key={summary.recordingId} gap="sm">
            <T size="sm" weight="semibold">Dialogue summary</T>
            {summary.text ? <Markdown>{summary.text}</Markdown>
              : <T size="sm" tone="secondary">{summary.status === 'pending' || summary.status === 'processing' ? 'Processing the recorded dialogue…' : summary.status === 'failed' ? 'Summary processing failed.' : summary.status === 'skipped' ? 'No speech was found to summarize.' : 'A summary is not available yet.'}</T>}
          </Stack>)}
        </Stack></Card>)}
    {cursor && !read.error && <Button variant="secondary" size="sm" className="self-start" disabled={busy} onClick={() => void more()}>{busy ? 'Loading…' : 'Earlier activity'}</Button>}
    {error && <InlineAlert tone="error">{error}</InlineAlert>}
  </Stack>;
}
