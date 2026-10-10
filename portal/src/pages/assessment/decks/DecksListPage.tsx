// /assessment/decks — every review deck, table first. `?teamId=` narrows it.

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { DataTable, ErrorState, PageHeader, Stack, StatStrip } from '@connorhoehnslalom/ui-components/shared';
import { formatRelativeTime } from '../secondaryFormat';
import { listDecks, type DeckSummary } from './decksApi';

function DecksListPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const teamId = params.get('teamId') ?? undefined;
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    listDecks(teamId, ctl.signal).then(setDecks).catch((err: unknown) => {
      if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : 'The decks could not be loaded.');
    });
    return () => ctl.abort();
  }, [teamId, attempt]);

  return (
    <Stack gap="md">
      <PageHeader title="Review decks" description={teamId ? `Team ${teamId}` : 'PowerPoint reviews of each team’s assessment'} />
      {!error && decks && (
        <StatStrip
          aria-label="Deck summary"
          variant="line"
          size="sm"
          items={[
            { label: decks.length === 1 ? 'deck' : 'decks', value: decks.length },
            { label: decks.length === 1 ? 'team' : 'teams', value: new Set(decks.map((d) => d.teamId)).size },
          ]}
        />
      )}
      {error ? (
        <ErrorState title="Couldn't load review decks" description={error} actionLabel="Retry" onAction={() => setAttempt((n) => n + 1)} />
      ) : (
        <DataTable<DeckSummary>
          data={decks ?? []}
          loading={decks === null}
          emptyMessage="No review decks yet. Open a team's scorecard and choose Create review deck from its actions menu."
          keyField={(d) => d.id}
          size="sm"
          striped
          pageSize={20}
          onRowClick={(d) => navigate(`/assessment/decks/${encodeURIComponent(d.id)}`)}
          columns={[
            { key: 'title', header: 'Deck', render: (d) => d.title },
            { key: 'team', header: 'Team', render: (d) => d.teamId },
            { key: 'version', header: 'Latest', render: (d) => d.latestRevision?.label ?? '—' },
            { key: 'updated', header: 'Updated', numeric: true, render: (d) => formatRelativeTime(d.updatedAt) },
          ]}
        />
      )}
    </Stack>
  );
}

export default DecksListPage;
