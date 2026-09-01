// InitiativeLabMemoryRail — what the fleet has LEARNED working this initiative.
//
// Lab sessions are wiped on redeploy; experiences are the part a session is
// allowed to keep (POST /api/lab/experiences from inside the microVM). This
// card is the human read on that memory, on the page where it accrues: the
// initiative. The same records are what a NEW session recalls before starting
// work — so a person reading this list is reading exactly the context the
// next agent will start with.

import { Card, Chip } from '@connorhoehnslalom/ui-components/shared';
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
      <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">LAB MEMORY</span>
        <div className="flex-1" />
        <Chip tone="neutral" size="xs" mono>{experiences.length}</Chip>
      </div>
      {experiences.map((e) => (
        <div key={e.id} className="px-3 py-2 border-b border-border last:border-b-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <Chip tone={KIND_TONE[e.kind] ?? 'neutral'} size="xs">{e.kind}</Chip>
            <span className="text-[12px] font-semibold text-text-primary truncate" title={e.title}>
              {e.title}
            </span>
            {e.repo && (
              <>
                <div className="flex-1" />
                <span className="text-[10px] text-text-tertiary font-mono truncate max-w-[110px]">{e.repo}</span>
              </>
            )}
          </div>
          {e.body && (
            <div className="mt-0.5 text-[10.5px] text-text-tertiary leading-snug line-clamp-2" title={e.body}>
              {e.body}
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}
