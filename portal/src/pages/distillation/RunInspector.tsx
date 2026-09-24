// The Activity run inspector (spec §1): one compaction job — status + time,
// Input / Output / Duration / Cost, What changed, Produced (links into
// Knowledge, from the job's own output ids), Inputs N, Run log, Technical
// details. Every figure is this job's own; tier totals live in the strip.
import { useEffect, useState } from 'react';
import { Disclosure, KeyValue, LinkedItemsSection, type LinkedItem } from '@connorhoehnslalom/ui-components';
import {
  Button, CloseIcon, DetailHeader, DetailSection, IconButton, InlineAlert, LogStream, Stack, StatusPill, T,
  TechnicalDetails,
} from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';
import {
  inputRefs, logLines, outputLevel, producedRefs, runFacts, runStatus, runTechnicalText, transformationLabel,
  whatChanged,
} from './activityModel';
import { knowledgeHref, knowledgeItemHref, viewForLevel } from './distillationRoutes';
import { recordFileKind } from './sourcesModel';
import type { CompactionRun, Item, Level } from './types';

const MAX_TITLES = 24;

/** Titles for a job's ids, read one item at a time (GET /items/:id) — a job
 *  touches a handful, and a bare id is never the row's label when the record
 *  exists. Unreadable ids keep their id and say so. */
function useItemTitles(ids: string[]): Record<string, string | null> {
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  const key = ids.slice(0, MAX_TITLES).join(',');
  useEffect(() => {
    let cancelled = false;
    const want = key ? key.split(',') : [];
    void Promise.all(want.map(async (id) => {
      try {
        const res = await fetch(`/api/distillation/items/${encodeURIComponent(id)}`, { credentials: 'include' });
        if (!res.ok) return [id, null] as const;
        const body = (await res.json()) as Item;
        return [id, body.title] as const;
      } catch {
        return [id, null] as const;
      }
    })).then((pairs) => { if (!cancelled) setTitles(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [key]);
  return titles;
}

function refsToLinks(refs: Array<{ id: string; level: Level }>, titles: Record<string, string | null>, onOpen: (href: string) => void): LinkedItem[] {
  return refs.slice(0, MAX_TITLES).map((r) => ({
    id: r.id,
    title: titles[r.id] ?? r.id,
    kind: recordFileKind(r.level === 'L2' ? 'artifact' : r.level === 'L1' ? 'cluster' : 'observation'),
    relation: titles[r.id] === null ? 'Could not be read' : undefined,
    onOpen: () => onOpen(knowledgeItemHref(r.id, r.level)),
  }));
}

function InputsList({ job, onOpen }: { job: CompactionRun; onOpen: (href: string) => void }) {
  const refs = inputRefs(job);
  const titles = useItemTitles(refs.map((r) => r.id));
  return (
    <LinkedItemsSection
      first
      title="Input records"
      items={refsToLinks(refs, titles, onOpen)}
      emptyLabel="The server did not list this job's inputs."
    />
  );
}

export function RunInspector({ job, onClose, onOpen }: {
  job: CompactionRun;
  onClose: () => void;
  /** Open a Knowledge record or view (pushes history, so Back returns here). */
  onOpen: (href: string) => void;
}) {
  const status = runStatus(job.status);
  const produced = producedRefs(job);
  const titles = useItemTitles(produced.map((r) => r.id));
  const outView = viewForLevel(outputLevel(job.level));
  const inputs = inputRefs(job);
  const lines = logLines(job);

  return (
    <Stack gap="md" className="h-full overflow-y-auto border-l border-border bg-surface p-4" data-testid="run-inspector">
      <DetailHeader
        title={transformationLabel(job.level)}
        badge={<StatusPill tone={status.tone} label={status.label} size="sm" />}
        meta={<T className="text-[12px] text-text-tertiary">Started {relativeTime(job.startedAt)}{job.repo ? ` · ${job.repo}` : ''}</T>}
        aside={<IconButton aria-label="Close run" size="sm" variant="ghost" icon={<CloseIcon size={16} />} onClick={onClose} />}
        // The aside is only the close button; its default width squeezed the
        // title into ~70px ("Run / notes → / Patterns").
        asideWidth={32}
      />
      {job.status === 'failed' && <InlineAlert tone="error">{job.error ?? 'Failed without an error message.'}</InlineAlert>}
      <KeyValue layout="row" labelWidth="w-24" items={runFacts(job)} aria-label="Run facts" />
      {/* heading variant, like the Produced list beside it — the mockup draws
          "What changed" and "Produced" as the same heading. */}
      <DetailSection title="What changed" variant="heading">
        <T className="text-[13px] text-text-secondary" wrap>{whatChanged(job)}</T>
      </DetailSection>
      {/* LinkedItemsSection draws its own heading (default "Dependencies &
          decisions"), so it IS the Produced section rather than sitting inside
          one. */}
      <Stack gap="sm">
        <LinkedItemsSection
          title={produced.length ? `Produced · ${produced.length}` : 'Produced'}
          items={refsToLinks(produced, titles, onOpen)}
          emptyLabel={job.status === 'succeeded' ? 'This pass produced nothing new.' : 'Nothing produced yet.'}
        />
        {produced.length > 0 && (
          <Button size="sm" variant="secondary" className="self-start" onClick={() => onOpen(knowledgeHref({ view: outView }))}>
            Browse {outView === 'guides' ? 'guides & findings' : 'patterns'} →
          </Button>
        )}
      </Stack>
      <Disclosure summary={`Inputs ${inputs.length || job.inputItems}`} variant="plain" density="compact">
        <InputsList job={job} onOpen={onOpen} />
      </Disclosure>
      <Disclosure summary={`Run log${lines.length ? ` (${lines.length})` : ''}`} variant="plain" density="compact">
        <LogStream lines={lines} title={null} showLevel showTimestamp tone="surface" maxHeight="240px" emptyMessage="No log lines for this job." />
      </Disclosure>
      <TechnicalDetails text={runTechnicalText(job)} label="Technical details" hideLabel="Hide technical details" />
    </Stack>
  );
}
