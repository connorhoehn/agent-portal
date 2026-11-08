// One pipelines page in its registration state: the page's own header over an
// empty state that says what the page will hold and which lane brings it
// (pipelinesSurfaces.ts). Composed from the library only.

import { Chip, EmptyState, PageHeader, Stack } from '@connorhoehn/ui-components/shared';
import { PIPELINES_SURFACES, type PipelinesSurfaceId } from './pipelinesSurfaces';

export default function PipelinesSurfacePage({ surface }: { surface: PipelinesSurfaceId }) {
  const s = PIPELINES_SURFACES[surface];
  return (
    <Stack gap="md" className="min-w-0" data-testid={`pipelines-page-${s.id}`}>
      <PageHeader density="compact"
        title={s.title}
        description={s.description}
        badge={<Chip tone="neutral" size="xs">Coming in lane {s.phase}</Chip>}
      />
      <EmptyState
        testId={`pipelines-empty-${s.id}`}
        align="start"
        title={s.emptyTitle}
        description={s.emptyBody}
        details={{ title: 'What comes next', body: s.next }}
      />
    </Stack>
  );
}
