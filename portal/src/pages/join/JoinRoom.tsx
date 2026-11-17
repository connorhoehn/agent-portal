// The candidate's room (docs/interviews-tenant-plan.md rows I2.3, I2.4; decision 21): the boundary round 4
// fills. It receives the guest's interview view (what GET /api/interview-invite/interview answers) and, once
// round 4 lands, joins the call in this window with the guest's realtime token (C2 `GET /realtime-token`) on
// the `interviews:interview:<id>` lobby, in ROOM's layout without Milo's context.
//
// This round it says the interviewer has let the candidate in and that the call opens in this window: the one
// state the page is allowed to stop at.
import { Card, KeyValue, Stack, T } from '@connorhoehn/ui-components/shared';

export interface GuestInterview {
  opening: { title: string };
  round: { name: string; minutes: number };
  scheduledAt: string | null;
}

export default function JoinRoom({ interview }: { interview: GuestInterview }) {
  return (
    <Stack gap="md" className="max-w-xl" data-testid="join-room">
      <Card padding="lg">
        <Stack gap="sm">
          <T size="base" weight="semibold" as="p">Your interviewer has let you in.</T>
          <T size="sm" as="p">The call opens in this window. Keep this page open.</T>
          <KeyValue items={[{ label: 'Round', value: interview.round.name }, { label: 'Length', value: `${interview.round.minutes} minutes` }]} />
        </Stack>
      </Card>
    </Stack>
  );
}
