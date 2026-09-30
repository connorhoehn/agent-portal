// One social page in its phase-S0 state: the page's own header over an empty
// state that says what the page will hold and which lane brings it
// (socialSurfaces.ts). Composed from the library only.

import { Chip, EmptyState, PageHeader, Stack } from '@connorhoehnslalom/ui-components/shared';
import { SOCIAL_SURFACES, type SocialSurfaceId } from './socialSurfaces';

export default function SocialSurfacePage({ surface }: { surface: SocialSurfaceId }) {
  const s = SOCIAL_SURFACES[surface];
  return (
    <Stack gap="lg" data-testid={`social-page-${s.id}`}>
      <PageHeader
        title={s.title}
        description={s.description}
        badge={<Chip tone="neutral" size="xs">Coming in lane {s.phase}</Chip>}
      />
      <EmptyState
        testId={`social-empty-${s.id}`}
        align="start"
        title={s.emptyTitle}
        description={s.emptyBody}
        details={{ title: 'What comes next', body: s.next }}
      />
    </Stack>
  );
}
