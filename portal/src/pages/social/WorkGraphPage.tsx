// /social/work-graph — the Social workspace activity graph, full page
// (docs/activity-graph-migration.md §10). The counterpart of /iq/activity,
// /pipelines/activity and /assessment/activity on the same snapshot assembly,
// v2 validation and live stream: the channels, DMs, teams and rooms the viewer
// belongs to, their message threads, calls, recordings, decks and flow runs,
// with the people active in them as participants.
//
// Open to every social role, like the API (`requireTenant('social')` and
// ViewSocial). Every part follows the chat's own membership authority per
// request on the server. One conversation's graph sits in its chat workspace
// (the Work graph toggle, `?view=graph`). `?day=YYYY-MM-DD` picks another day.

import { useNavigate, useSearchParams } from 'react-router';
import { Button, PageHeader, Stack } from '@connorhoehn/ui-components/shared';
import { WorkGraphActivity } from '../../components/work-graph/WorkGraphActivity';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export default function SocialWorkGraphPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const day = params.get('day');
  return (
    <Stack gap="md" data-testid="social-work-graph">
      <PageHeader
        title="Work graph"
        description="The conversations you belong to, with their threads, calls, recordings, decks and agent runs, for the day."
        actions={<Button variant="secondary" size="sm" data-testid="social-work-graph-chat" onClick={() => navigate('/social/channels')}>Open channels</Button>}
      />
      <WorkGraphActivity
        subject={{ kind: 'social' }}
        mode="full"
        {...(day && DAY.test(day) ? { day } : {})}
        className="h-[calc(100vh-18rem)] min-h-[480px]"
      />
    </Stack>
  );
}
