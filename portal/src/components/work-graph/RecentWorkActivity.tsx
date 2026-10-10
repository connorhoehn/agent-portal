// The compact "Recent activity" list on a subject's Overview: the newest events
// from the same work-graph snapshot the Activity tab draws, with a way into that
// tab. No canvas here — the canvas is the Activity tab's whole content.

import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { ActionRowList, ActionRowPerson, type ActionRowColumn } from '@connorhoehnslalom/ui-components';
import { ArrowRightIcon, Button, Inline, PageSection, T } from '@connorhoehnslalom/ui-components/shared';
import { recentWorkEvents, type WorkGraphSubject } from '../../lib/workGraph';
import { relativeTime } from '../../lib/relativeTime';
import { useWorkGraphSource } from './WorkGraphActivity';

const COLUMNS: ActionRowColumn[] = [
  { id: 'who', width: 'xl', label: 'Who' },
  { id: 'when', width: 'sm', label: 'When' },
];

export function RecentWorkActivity({ subject, limit = 5, onOpenActivity }: {
  subject: WorkGraphSubject;
  limit?: number;
  /** "Open Activity →": the host switches to its Activity tab. */
  onOpenActivity: () => void;
}) {
  const navigate = useNavigate();
  const { result, liveHints } = useWorkGraphSource({ subject });
  const events = useMemo(() => recentWorkEvents(result.graph, limit), [result.graph, limit]);
  return (
    <PageSection
      size="sm"
      title="Recent activity"
      actions={(
        <Button variant="link" size="sm" onClick={onOpenActivity} data-testid="overview-open-activity">
          <Inline gap="sm" align="center">Open Activity<ArrowRightIcon size={16} /></Inline>
        </Button>
      )}
      data-testid="overview-recent-activity"
    >
      {liveHints}
      <ActionRowList
        aria-label="Recent activity"
        className="work-overview-striped-rows"
        size="sm"
        columns={COLUMNS}
        items={events.map(e => ({
          id: e.id,
          title: e.title,
          description: e.what,
          cells: {
            who: e.actor ? <ActionRowPerson name={e.actor} size={24} /> : <T tone="secondary">—</T>,
            when: relativeTime(e.at),
          },
        }))}
        emptyLabel={result.status === 'loading' ? 'Loading activity…' : 'No activity yet.'}
        onOpen={row => { const hit = events.find(e => e.id === row.id); if (hit?.href) navigate(hit.href); else onOpenActivity(); }}
        data-testid="overview-recent-activity-list"
      />
    </PageSection>
  );
}
