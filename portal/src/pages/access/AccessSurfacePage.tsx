// One access page in its registration state: the page's own header over an
// empty state that says what the page will hold and which lane brings it
// (accessSurfaces.ts). Composed from the library only — the same shape as
// PipelinesSurfacePage, so the DOM audit reads `access-empty-<id>` as the
// placeholder evidence.

import { Chip, EmptyState, PageHeader, Stack } from '@connorhoehnslalom/ui-components/shared';
import { ACCESS_SURFACES, type AccessSurfaceId } from './accessSurfaces';

export default function AccessSurfacePage({ surface }: { surface: AccessSurfaceId }) {
  const s = ACCESS_SURFACES[surface];
  return (
    <Stack gap="md" className="min-w-0" data-testid={`access-page-${s.id}`}>
      <PageHeader density="compact"
        title={s.title}
        description={s.description}
        badge={<Chip tone="neutral" size="xs">Coming in lane {s.phase}</Chip>}
      />
      <EmptyState
        testId={`access-empty-${s.id}`}
        align="start"
        title={s.emptyTitle ?? `${s.title} is not available yet`}
        description={s.emptyBody ?? s.description}
        details={{ title: 'What comes next', body: s.next ?? `Lane ${s.phase} brings this page.` }}
      />
    </Stack>
  );
}
