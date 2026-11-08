// /assessment/activity — the assessment workspace activity graph, full page
// (docs/activity-graph-migration.md §9). The counterpart of /iq/activity and
// /pipelines/activity on the same projection, snapshot assembly and live stream:
// the teams (assessments) with work in the day, the dimensions assessed, the
// evidence and evidence/follow-up drafts, review decks and agent runs, with the
// people acting on them as participants.
//
// Open to every assessment role, like the API (`requireTenant('assessment')` and
// ViewAssessment, which every assessment role holds). Drafts and runs inside it
// follow the REST gates per request on the server. One team's own graph sits on
// its scorecard (Activity tab). `?day=YYYY-MM-DD` picks another day in the viewer's zone.

import { useNavigate, useSearchParams } from 'react-router';
import { Button, PageHeader, Stack } from '@connorhoehn/ui-components/shared';
import { WorkGraphActivity } from '../../components/work-graph/WorkGraphActivity';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export default function AssessmentActivityPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const day = params.get('day');
  return (
    <Stack gap="md" data-testid="assessment-activity">
      <PageHeader
        title="Work graph"
        description="Teams, the dimensions assessed, evidence, drafts, review decks and agent runs across every assessment, for the day."
        actions={<Button variant="secondary" size="sm" data-testid="assessment-activity-runs" onClick={() => navigate('/assessment/runs')}>Agent run ledger</Button>}
      />
      <WorkGraphActivity
        subject={{ kind: 'assessment' }}
        mode="full"
        {...(day && DAY.test(day) ? { day } : {})}
        className="h-[calc(100vh-18rem)] min-h-[480px]"
      />
    </Stack>
  );
}
