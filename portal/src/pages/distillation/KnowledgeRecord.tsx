// The Knowledge record pane (spec §1): one guide / pattern / run note on the
// library's EditorShell — crumbs (view / type), title, status + updated line,
// Content | History (+ Runs for a procedure), header actions Sources N and
// Open in Library ↗ (only when linked), and the docked explain-only composer.
//
// Each tier renders its content ONCE:
//   guide      markdown, "What the source run found", Technical details
//   procedure  steps (with the latest run's markers), the rest of its markdown
//   pattern    the claim, confidence, the run notes behind it
//   run note   session / repo / time / kind, the body, the rest of that run
import { useMemo, useState } from 'react';
import { Disclosure, KeyValue, SourceList, WorkActivityList } from '@connorhoehnslalom/ui-components';
import { EditorShell } from '@connorhoehnslalom/ui-components/doc-editor';
import {
  Button, DetailSection, MarkdownView, Stack, StatusPill, T,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { ExplainComposer } from './ExplainComposer';
import {
  itemFileKind, recordCrumbs, recordHistory, recordStatus, shortRepo, technicalDetails, withoutStepsSection,
  kindLabel,
} from './knowledgeModel';
import { ProcedureRunsTab, ProcedureStepList, useProcedure, type ProcedureData } from './ProcedureRuns';
import { knowledgeItemHref } from './distillationRoutes';
import { useItemSources } from './SourcesPanel';
import { recordFileKind, sourceRows } from './sourcesModel';
import type { Artifact, Item, Observation, SessionRecord } from './types';

type RecordTab = 'content' | 'history' | 'runs';

function TechnicalDetailsBlock({ item }: { item: Item }) {
  return (
    <Disclosure summary="Technical details" variant="plain" density="compact" data-testid="record-technical-details">
      <KeyValue layout="grid" items={technicalDetails(item).map((r) => ({ label: r.label, value: r.value, mono: r.mono, title: r.value }))} />
    </Disclosure>
  );
}

/** "What the source run found": the claim(s) of the patterns a guide was
 *  distilled from — read from the same sources response the inspector uses. */
function SourceRunFound({ item, onOpen }: { item: Item; onOpen: (href: string) => void }) {
  const sources = useItemSources(item.id);
  const clusters = sourceRows(sources.data).filter((r) => r.kind === 'cluster');
  if (sources.isLoading && !sources.data) return <T className="text-[12px] text-text-tertiary">Reading the source run…</T>;
  if (clusters.length === 0) return null;
  return (
    <DetailSection title="What the source run found">
      <Stack gap="sm">
        {clusters.map((c) => (
          <Stack key={c.id} gap="xs">
            <T className="text-[14px] leading-6 text-text-primary" wrap>{c.excerpt ?? c.title}</T>
            {c.href && (
              <Button size="sm" variant="link" className="self-start px-0" onClick={() => onOpen(c.href!)}>
                Pattern: {c.title} →
              </Button>
            )}
          </Stack>
        ))}
      </Stack>
    </DetailSection>
  );
}

function GuideContent({ item, onOpen }: { item: Extract<Item, { level: 'L2' }>; onOpen: (href: string) => void }) {
  return (
    <>
      <MarkdownView markdown={item.body_markdown} scale="md" data-testid="record-body" />
      <SourceRunFound item={item} onOpen={onOpen} />
    </>
  );
}

function ProcedureContent({ item, data, onOpen }: { item: Artifact & { level: 'L2' }; data: ProcedureData; onOpen: (href: string) => void }) {
  const rest = withoutStepsSection(item.body_markdown);
  return (
    <>
      {item.summary && <T className="text-[14px] leading-6 text-text-secondary" wrap>{item.summary}</T>}
      <ProcedureStepList data={data} />
      {rest && <MarkdownView markdown={rest} scale="md" data-testid="record-body" />}
      <SourceRunFound item={item} onOpen={onOpen} />
    </>
  );
}

function PatternContent({ item, onOpen }: { item: Extract<Item, { level: 'L1' }>; onOpen: (href: string) => void }) {
  const sources = useItemSources(item.id);
  const notes = sourceRows(sources.data).filter((r) => r.kind === 'observation');
  return (
    <>
      <DetailSection first title="The claim">
        <T className="text-[15px] leading-6 text-text-primary" wrap>{item.summary}</T>
      </DetailSection>
      <KeyValue
        layout="row"
        labelWidth="w-28"
        items={[
          { label: 'Confidence', value: `${Math.round(item.confidence * 100)}%` },
          { label: 'Kind', value: kindLabel(item.kind) },
          { label: 'Repository', value: shortRepo(item.repo), title: item.repo },
        ]}
      />
      <DetailSection title="Run notes behind it" hint={`${item.member_observation_ids.length} notes`}>
        <SourceList
          aria-label="Member run notes"
          emptyLabel={sources.isLoading ? 'Loading run notes…' : sources.error ? `Run notes could not be read: ${sources.error}` : 'No member notes recorded.'}
          items={notes.map((n) => ({
            id: n.id, title: n.title, kind: recordFileKind(n.kind), timestamp: n.timestamp, excerpt: n.excerpt ?? undefined,
            onOpen: n.href ? () => onOpen(n.href!) : undefined,
          }))}
        />
      </DetailSection>
    </>
  );
}

function NoteContent({ item, onOpen }: { item: Observation & { level: 'L0' }; onOpen: (href: string) => void }) {
  const session = useFetch<SessionRecord>(`/api/distillation/sessions/${encodeURIComponent(item.session_id)}`, 0);
  const siblings = (session.data?.notes ?? []).filter((n) => n.id !== item.id);
  return (
    <>
      <KeyValue
        layout="row"
        labelWidth="w-28"
        items={[
          { label: 'Session', value: item.session_id, mono: true },
          { label: 'Repository', value: shortRepo(item.repo), title: item.repo },
          { label: 'Written', value: relativeTime(item.created_at), title: item.created_at },
          { label: 'Kind', value: kindLabel(item.kind) },
        ]}
      />
      <DetailSection title="What happened">
        <T className="text-[14px] leading-6 text-text-primary" wrap>{item.body}</T>
      </DetailSection>
      <DetailSection
        title="From the same run"
        hint={session.data?.started_at ? `session started ${relativeTime(session.data.started_at)}` : undefined}
      >
        <SourceList
          aria-label="Other notes from this session"
          emptyLabel={session.isLoading ? 'Loading the session…' : session.error ? `The session could not be read: ${session.error}` : 'This run wrote no other notes.'}
          items={siblings.map((n) => ({
            id: n.id, title: n.title, kind: 'transcript' as const, timestamp: n.created_at, excerpt: n.body,
            onOpen: () => onOpen(knowledgeItemHref(n.id, 'L0')),
          }))}
        />
      </DetailSection>
    </>
  );
}

export function KnowledgeRecord({
  item, sourceCount, onOpenSources, onOpen,
}: {
  item: Item;
  /** From the sources read; null while unknown (never shown as 0). */
  sourceCount: number | null;
  onOpenSources: () => void;
  /** Navigate within Knowledge (a source, a member note), pushing history. */
  onOpen: (href: string) => void;
}) {
  const { can, ready } = useCapabilities();
  const canRecord = ready && can('ManageBots');
  const isProcedure = item.level === 'L2' && item.type === 'procedure';
  const [tab, setTab] = useState<RecordTab>('content');
  const procedure = useProcedure(isProcedure ? item.id : null);
  const crumbs = recordCrumbs(item);
  const status = recordStatus(item);
  const history = useMemo(() => recordHistory(item), [item]);
  const updated = item.level === 'L0' ? item.created_at : item.updated_at;
  const libraryId = item.level === 'L2' ? item.library_item_id : null;
  const activeTab: RecordTab = tab === 'runs' && !isProcedure ? 'content' : tab;

  return (
    <EditorShell
      title={item.title}
      kind={itemFileKind(item)}
      breadcrumbs={[{ label: crumbs[0] }, { label: crumbs[1] }]}
      statusPill={<StatusPill tone={status.tone} label={status.label} size="sm" />}
      subtitle={`${item.level === 'L0' ? 'Written' : 'Updated'} ${relativeTime(updated)}${item.level !== 'L2' && item.repo ? ` · ${shortRepo(item.repo)}` : ''}`}
      headActions={(
        <>
          <Button size="sm" variant="secondary" onClick={onOpenSources} data-testid="record-sources-button">
            Sources{sourceCount != null ? ` ${sourceCount}` : ''}
          </Button>
          {libraryId && (
            <Button size="sm" variant="secondary" onClick={() => onOpen(`/iq/library/${encodeURIComponent(libraryId)}`)}>
              Open in Library ↗
            </Button>
          )}
        </>
      )}
      tabs={[
        { id: 'content', label: 'Content' },
        { id: 'history', label: 'History' },
        ...(isProcedure ? [{ id: 'runs', label: 'Runs', count: procedure.runs.length || undefined }] : []),
      ]}
      activeTab={activeTab}
      onTabChange={(id) => setTab(id as RecordTab)}
      surface="plain"
      label="Knowledge record"
      data-testid="knowledge-record"
      footer={(
        <ExplainComposer
          subject={{ kind: crumbs[1].toLowerCase(), id: item.id, title: item.title }}
          referenceLabel={item.level === 'L2' ? 'This guide' : item.level === 'L1' ? 'This pattern' : 'This run note'}
          placeholder={item.level === 'L0' ? 'Ask what this run found…' : 'Explain when I should use this…'}
        />
      )}
    >
      <Stack gap="md" className="mx-auto w-full max-w-3xl px-6 py-4">
        {activeTab === 'content' && (
          <>
            {item.level === 'L2' && item.type === 'procedure' && <ProcedureContent item={item} data={procedure} onOpen={onOpen} />}
            {item.level === 'L2' && item.type !== 'procedure' && <GuideContent item={item} onOpen={onOpen} />}
            {item.level === 'L1' && <PatternContent item={item} onOpen={onOpen} />}
            {item.level === 'L0' && <NoteContent item={item} onOpen={onOpen} />}
            <TechnicalDetailsBlock item={item} />
          </>
        )}
        {activeTab === 'history' && (
          <WorkActivityList first title="History" events={history} emptyLabel="No recorded history." />
        )}
        {activeTab === 'runs' && isProcedure && (
          <ProcedureRunsTab artifactId={item.id} data={procedure} canRecord={canRecord} />
        )}
      </Stack>
    </EditorShell>
  );
}
