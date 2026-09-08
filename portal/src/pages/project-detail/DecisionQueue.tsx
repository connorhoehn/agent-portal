// Decisions raised against this initiative — reachable, deliberately not a
// headline.

import { Card, Chip, Inline, InlinePlaceholder, MetaLine, Stack } from '@connorhoehnslalom/ui-components/shared';
import { T } from './Text';
import { DECISION_TONE } from './projectFormat';
import type { ProjectDecision } from './types';

export function DecisionQueue({ decisions }: { decisions: ProjectDecision[] }) {
  if (decisions.length === 0) {
    return (
      <InlinePlaceholder size="sm" align="center">
        No decisions linked to this project yet.
      </InlinePlaceholder>
    );
  }
  return (
    <Stack gap="sm">
      {decisions.map((d) => (
        <Card key={d.id} padding="sm">
          <Stack gap="xs">
            <Inline gap="sm" align="start" wrap={false}>
              <Chip tone={DECISION_TONE[d.status] ?? 'warning'} size="xs" uppercase>
                {d.status}
              </Chip>
              <T className="min-w-0 flex-1 text-[14px] font-semibold text-text-primary">
                {d.topic}
              </T>
              {d.requiredRole && (
                <Chip tone="purple" size="xs" className="shrink-0">needs {d.requiredRole}</Chip>
              )}
            </Inline>
            {d.summary && (
              <T as="p" className="m-0 text-[13px] leading-relaxed text-text-secondary">{d.summary}</T>
            )}
            <MetaLine
              items={[
                d.workItemTitle ? `🔗 ${d.workItemTitle}` : null,
                d.escalatedAt ? `Escalated ${new Date(d.escalatedAt).toLocaleDateString()}` : null,
              ]}
            />
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}
