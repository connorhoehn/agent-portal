// /iq/activity — the orgiq workspace activity graph, full page
// (docs/activity-graph-migration.md). The counterpart of realtime-examples'
// standalone /social/work-graph/:personId page: reached from the initiative
// overview's pop-out, not the rail (the reference gives its page no nav entry
// either). `?initiative=<id>` scopes it to one initiative; `?person=<id>` shows
// one person's working day (their assigned work, sprints they steward, decisions
// they sit on — and, for yourself only, your own flow runs); `?day=YYYY-MM-DD`
// picks another day in the viewer's zone.
//
// Open to every orgiq role, like the API (requireTenant('orgiq')); runs and
// bots inside it follow the bots read gates server-side, per request.

import { useSearchParams } from 'react-router';
import { useMemo } from 'react';
import { Button, Inline, PageHeader, Select, Stack } from '@connorhoehnslalom/ui-components/shared';
import { WorkGraphActivity } from '../../components/work-graph/WorkGraphActivity';
import { useFetch } from '../../hooks/useFetch';
import type { WorkGraphSubject } from '../../lib/workGraph';

const INITIATIVE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `/api/graph/entities` (ViewOrgChart, held by every orgiq role): the people the selector offers. */
interface PersonEntity { id: string; name: string; title?: string | null }

export default function ActivityPage() {
  const [params, setParams] = useSearchParams();
  const initiative = params.get('initiative');
  const person = params.get('person');
  const day = params.get('day');
  const { data: entities } = useFetch<{ nodes?: PersonEntity[] }>('/api/graph/entities');
  const people = useMemo(
    () => [...(entities?.nodes ?? [])].filter(p => INITIATIVE.test(p.id)).sort((a, b) => a.name.localeCompare(b.name)),
    [entities],
  );
  const subject: WorkGraphSubject = person && INITIATIVE.test(person)
    ? { kind: 'person', id: person }
    : initiative && INITIATIVE.test(initiative) ? { kind: 'initiative', id: initiative } : { kind: 'workspace' };
  const personName = subject.kind === 'person' ? people.find(p => p.id === subject.id)?.name ?? null : null;
  const pick = (next: string) => setParams(prev => {
    const nextParams = new URLSearchParams(prev);
    if (next) { nextParams.set('person', next); nextParams.delete('initiative'); } else nextParams.delete('person');
    return nextParams;
  });
  const describe = {
    workspace: 'Work items, sprints, decisions, agent runs and linked documents across every initiative, for the day.',
    initiative: 'Work items, sprints, decisions, agent runs and linked documents on this initiative, for the day.',
    person: `${personName ?? 'This person'}’s day: work assigned to them, sprints they steward and decisions they sit on.`,
  }[subject.kind];
  return (
    <Stack gap="md" data-testid="iq-activity">
      <PageHeader
        title="Work graph"
        description={describe}
        {...(subject.kind === 'initiative' ? { back: { label: 'Back to the initiative', to: `/iq/projects/${encodeURIComponent(subject.id)}` } } : {})}
        actions={(
          <Inline gap="sm">
            <Select
              size="sm"
              value={subject.kind === 'person' ? subject.id : ''}
              onChange={e => pick(e.target.value)}
              options={[{ value: '', label: 'Everyone' }, ...people.map(p => ({ value: p.id, label: p.name }))]}
              aria-label="Show one person's day"
              data-testid="iq-activity-person"
            />
            {subject.kind !== 'workspace' && (
              <Button
                variant="secondary" size="sm" data-testid="iq-activity-workspace"
                onClick={() => setParams(prev => { const next = new URLSearchParams(prev); next.delete('initiative'); next.delete('person'); return next; })}
              >Whole workspace</Button>
            )}
          </Inline>
        )}
      />
      <WorkGraphActivity
        key={`${subject.kind}:${subject.kind === 'workspace' ? '' : subject.id}`}
        subject={subject}
        mode="full"
        {...(day && DAY.test(day) ? { day } : {})}
        className="h-[calc(100vh-18rem)] min-h-[480px]"
      />
    </Stack>
  );
}
