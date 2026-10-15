// Runbooks → Briefs: the runs' frozen briefs, newest first (a list rail), and one brief as a page
// beside it (/iq/runbooks/briefs/:ref). The text is the same bytes the box received, with its sha.
import { useMemo, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router';
import { EmptyState, Stack, StatusPill, T } from '@connorhoehnslalom/ui-components/shared';
import { EditorShell } from '@connorhoehnslalom/ui-components/doc-editor';
import { useFetch } from '../../hooks/useFetch';
import { useRunbookNames } from './useRunbookNames';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { relativeTime } from '../../lib/relativeTime';
import { RunBriefPanel } from './RunBriefPanel';
import { RunbooksListFrame } from './RunbooksListFrame';
import type { RunbooksOutletContext } from './RunbooksModule';
import { briefGroups, briefHref, briefRows, briefsCommandAdapter, runPageHref, shortSha } from './runbooksModel';
import type { BriefSummary } from './types';
import { Button } from '@connorhoehnslalom/ui-components/shared';

export default function BriefsTab() {
  const { ref } = useParams();
  const navigate = useNavigate();
  const { breadcrumbs } = useOutletContext<RunbooksOutletContext>();
  const [query, setQuery] = useState('');
  const feed = useFetch<{ briefs: BriefSummary[] }>('/api/briefs?limit=200', 0);
  const all = feed.data?.briefs ?? [];
  const names = useRunbookNames();
  const rows = useMemo(() => briefRows(all, query, names), [all, query, names]);
  const current = all.find((b) => b.run_ref === ref) ?? null;
  useCrumbLabel(ref, ref ? names.run(ref) : undefined);
  const commands = briefsCommandAdapter(rows, { setQuery, refresh: feed.refresh, open: (r) => navigate(briefHref(r)) });

  return (
    <RunbooksListFrame
      breadcrumbs={breadcrumbs}
      title="Briefs"
      description="What each run was told when it started: the task, the project, the decisions that bind it and the runbooks selected for it."
      listTitle="Briefs"
      {...(feed.data ? { count: all.length } : {})}
      listLabel="briefs"
      query={query}
      onQuery={setQuery}
      searchLabel="Search briefs"
      loading={feed.isLoading && !feed.data}
      error={feed.error}
      onRetry={feed.refresh}
      errorWhat="the briefs"
      errorSource="Briefs are read from the runbook store"
      groups={briefGroups(rows)}
      rows={rows.map((r) => ({ id: r.id, groupId: r.groupId, title: r.title, subline: r.subline }))}
      currentId={ref ?? null}
      onOpen={(r) => navigate(briefHref(r))}
      emptyTitle="No briefs yet"
      emptyDescription="A brief is frozen on a run when it is dispatched or claimed. Open a work item’s Brief preview to see what the next run would get."
      onClear={() => setQuery('')}
      storageKey="runbooks.briefs.groups"
      footerNote={feed.data ? `${rows.length} of ${all.length} briefs` : 'Loading…'}
      commands={commands}
      data-testid="runbooks-briefs"
    >
      {ref ? (
        <EditorShell
          titleSize="sm" titleAs="h2"
          title={names.run(ref)}
          statusPill={current ? <StatusPill tone="neutral" label={`sha ${shortSha(current.sha256)}`} size="sm" /> : undefined}
          subtitle={<T size="xs" tone="tertiary">{current ? `${current.initiative_id ? `${names.initiative(current.initiative_id)} · ` : ''}frozen ${relativeTime(current.assembled_at)}` : 'A frozen brief'}</T>}
          tabsTrailing={<Button size="sm" variant="secondary" onClick={() => navigate(runPageHref(ref))}>Open the run</Button>}
          surface="plain"
          label="Brief"
          data-testid="brief-record"
        >
          <Stack gap="md" className="w-full max-w-4xl px-5 py-4">
            <RunBriefPanel key={ref} runRef={ref} />
          </Stack>
        </EditorShell>
      ) : (
        <Stack gap="md" className="w-full max-w-3xl px-6 pb-6">
          <EmptyState title={feed.isLoading ? 'Loading…' : 'Choose a brief'} description="Pick a run from the list to read the exact text it was given." />
        </Stack>
      )}
    </RunbooksListFrame>
  );
}
