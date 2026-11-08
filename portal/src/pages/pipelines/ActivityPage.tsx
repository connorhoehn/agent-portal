// /pipelines/activity — the pipelines workspace activity graph, full page
// (docs/activity-graph-migration.md §8). The counterpart of /iq/activity on the
// same projection, snapshot assembly and live stream: run definitions, runs and
// their steps, approvals waiting on a person, run report decks and the agent
// flows you asked for, with the people acting on them as participants.
//
// Open to every pipelines role, like the API (`requireTenant('pipelines')` and
// ViewPipelines, which every pipelines role holds). Approvals inside it are
// withheld server-side from a role without ApproveStep, per request. One run's
// own graph sits on its detail page (/pipelines/runs/:id).
// `?day=YYYY-MM-DD` picks another day in the viewer's zone.

import { useNavigate, useSearchParams } from 'react-router';
import { IconButton, Tooltip, ListIcon, PageHeader, Stack } from '@connorhoehn/ui-components/shared';
import { WorkGraphActivity } from '../../components/work-graph/WorkGraphActivity';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export default function PipelinesActivityPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const day = params.get('day');
  return (
    <Stack gap="md" className="min-w-0" data-testid="pipelines-activity">
      <PageHeader density="compact"
        title="Work graph"
        description="Runs, their steps, approvals waiting on a person and run report decks across every pipeline, for the day."
        actions={<Tooltip content="All runs"><IconButton size="sm" aria-label="All runs" icon={<ListIcon />} data-testid="pipelines-activity-runs" onClick={() => navigate('/pipelines/runs')} /></Tooltip>}
      />
      <WorkGraphActivity
        subject={{ kind: 'pipelines' }}
        mode="full"
        {...(day && DAY.test(day) ? { day } : {})}
        className="h-[calc(100dvh-12rem)] min-h-[320px]"
      />
    </Stack>
  );
}
