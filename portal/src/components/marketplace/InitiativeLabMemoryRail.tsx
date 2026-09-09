// InitiativeLabMemoryRail — what the fleet has LEARNED working this initiative.
//
// Lab sessions are wiped on redeploy; experiences are the part a session is
// allowed to keep (POST /api/lab/experiences from inside the microVM). This
// card is the human read on that memory, on the page where it accrues: the
// initiative. The same records are what a NEW session recalls before starting
// work — so a person reading this list is reading exactly the context the
// next agent will start with.

import {
  Card, Chip, EntityCell, Inline, MetaLine, SectionLabel, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

interface LabExperience {
  id: string;
  kind: 'worked' | 'failed' | 'gotcha' | 'decision' | 'convention';
  title: string;
  body: string | null;
  repo: string | null;
  tags: string[];
  createdAt: string;
}

const KIND_TONE = {
  worked: 'success',
  failed: 'danger',
  gotcha: 'warning',
  decision: 'info',
  convention: 'neutral',
} as const;

export function LabMemoryRailCard({ initiativeId }: { initiativeId: string | undefined }) {
  const { data } = useFetch<{ experiences: LabExperience[] }>(
    initiativeId ? `/api/lab/experiences?initiative=${encodeURIComponent(initiativeId)}&limit=6` : null,
  );
  const experiences = data?.experiences ?? [];

  // No memory yet is the normal state for most initiatives — render nothing
  // rather than an empty panel apologising for it.
  if (experiences.length === 0) return null;

  return (
    <Card padding="none" className="overflow-hidden">
      <Inline gap="sm" align="center" className="px-3 py-2.5 border-b border-border">
        <SectionLabel>LAB MEMORY</SectionLabel>
        <Chip tone="neutral" size="xs" mono className="ml-auto">{experiences.length}</Chip>
      </Inline>
      {experiences.map((e) => (
        <Stack key={e.id} gap="none" className="px-3 py-2 border-b border-border last:border-b-0">
          <Inline gap="xs" align="center" className="min-w-0">
            <Chip tone={KIND_TONE[e.kind] ?? 'neutral'} size="xs">{e.kind}</Chip>
            <EntityCell label={e.title} className="min-w-0" />
            {e.repo && (
              <MetaLine
                size="xs"
                className="ml-auto font-mono truncate max-w-[110px]"
                items={[e.repo]}
              />
            )}
          </Inline>
          {e.body && (
            <MetaLine
              size="xs"
              className="mt-0.5 leading-snug line-clamp-2"
              items={[<span key="b" title={e.body}>{e.body}</span>]}
            />
          )}
        </Stack>
      ))}
    </Card>
  );
}
