import { AssetRelationships } from './AssetRelationships';
// The Knowledge record pane (spec §1; the guide record mockup,
// docs/distillation-guide-record-spec.md): one guide / pattern / run note on
// the library's EditorShell — a record headline (titleSize lg: the page's
// title, no kind mark or crumb above it; the module crumbs sit at the top of
// the pane), status + updated line, Content | History (+ Runs for a
// procedure) with Sources N and Open in Agent library ↗ (only when linked) at the
// right of the tab row, and the docked explain-only composer.
//
// Each tier renders its content ONCE:
//   guide      When this helps · Use it in your work · the markdown · Based on
//              · Technical details
//   procedure  When this helps · Use it in your work · the latest run's
//              warning (the ONLY run outcome on Content) · The approach
//              (neutral numbers — markers live on Runs) · Based on ·
//              Technical details (with the rest of its markdown inside)
//   pattern    the claim, confidence, the run notes behind it
//   run note   session / repo / time / kind, the body, the rest of that run
//
// The plain-language copy (when this helps, the approach, the warning, based
// on) is server data (`when_this_helps`, the `guide` projection); only the
// "Use it in your work" chrome is written here. A record that predates it
// falls back to its summary.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRightIcon, Disclosure, KeyValue, ProcedureSteps, SourceList, WorkActivityList,
} from '@connorhoehnslalom/ui-components';
import { EditorShell } from '@connorhoehnslalom/ui-components/doc-editor';
import type { RichChatComposerHandle } from '@connorhoehnslalom/ui-components/social/rich-composer';
import {
  Banner, Button, DetailSection, Inline, MarkdownView, Stack, StatusPill, T,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { ExplainComposer, RecordExplainComposer } from './ExplainComposer';
import {
  DEFAULT_GUIDE_CONTEXT, EXPLAIN_GUIDE_INSTRUCTION, GUIDE_CONTEXT_OPTIONS, PLAN_PREFILL, approachHint, approachSteps,
  basedOnRows, guidePrompt, kindLabel, recordCrumbs, recordHistory, recordStatus, shortRepo, technicalDetails,
  withoutStepsSection, type GuideContext,
} from './knowledgeModel';
import { ProcedureRunsTab, useProcedure, type ProcedureData } from './ProcedureRuns';
import { knowledgeItemHref, type RecordTab } from './distillationRoutes';
import { useItemSources } from './SourcesPanel';
import { recordFileKind, sourceRows } from './sourcesModel';
import type { Artifact, Item, Observation, SessionRecord } from './types';

type GuideItem = Artifact & { level: 'L2' };

function TechnicalDetailsBlock({ item, extra }: { item: Item; extra?: ReactNode }) {
  return (
    <Disclosure summary="Technical details" variant="plain" density="compact" data-testid="record-technical-details">
      <Stack gap="md">
        {extra}
        <KeyValue layout="grid" items={technicalDetails(item).map((r) => ({ label: r.label, value: r.value, mono: r.mono, title: r.value }))} />
      </Stack>
    </Disclosure>
  );
}

/** "When this helps": the stored plain paragraph(s), one per line; a record
 *  without one leads with its summary instead. */
function WhenThisHelps({ item }: { item: GuideItem }) {
  const paragraphs = (item.when_this_helps ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (paragraphs.length === 0) {
    return item.summary ? <T className="text-[14px] leading-6 text-text-secondary" wrap>{item.summary}</T> : null;
  }
  return (
    <DetailSection first title="When this helps">
      <Stack gap="none" data-testid="record-when-this-helps">
        {paragraphs.map((p) => <T key={p} className="text-[15px] leading-[21px] text-text-primary" wrap>{p}</T>)}
      </Stack>
    </DetailSection>
  );
}

function UseItInYourWork({ onDraftPlan, onExplain }: { onDraftPlan: () => void; onExplain: () => void }) {
  return (
    <DetailSection title="Use it in your work">
      <Stack gap="sm">
        <T className="text-[15px] leading-[21px] text-text-primary" wrap>
          Tell the agent which project you’re working on. It can explain the approach or help draft a plan using this guide.
        </T>
        <Inline gap="sm" align="center">
          <Button variant="primary" onClick={onDraftPlan} data-testid="record-draft-plan">Draft a plan for my project</Button>
          <Button variant="secondary" onClick={onExplain} data-testid="record-explain-guide">Explain this guide</Button>
        </Inline>
        <T className="text-[13px] text-text-tertiary" wrap>
          Adds this guide to the conversation. You review the plan before doing the work.
        </T>
      </Stack>
    </DetailSection>
  );
}

function RunWarning({ item, onViewRun }: { item: GuideItem; onViewRun: (runId: string) => void }) {
  const warning = item.guide?.run_warning;
  if (!warning) return null;
  return (
    <Banner
      variant="warning"
      layout="callout"
      icon
      title={warning.title}
      action={(
        <Button
          variant="link"
          size="sm"
          className="inline-flex items-center gap-1"
          onClick={() => onViewRun(warning.run_id)}
          data-testid="record-view-run"
        >
          View run <ArrowRightIcon size={14} />
        </Button>
      )}
      className="my-3"
      data-testid="record-run-warning"
    >
      {warning.body}
    </Banner>
  );
}

function BasedOn({ item, onOpen }: { item: GuideItem; onOpen: (href: string) => void }) {
  const rows = basedOnRows(item.guide);
  if (rows.length === 0) return null;
  return (
    <DetailSection title="Based on">
      <SourceList
        layout="row"
        aria-label="Based on"
        items={rows.map((r) => ({ id: r.id, title: r.title, kind: r.fileKind, meta: r.meta, onOpen: () => onOpen(r.href) }))}
        data-testid="record-based-on"
      />
    </DetailSection>
  );
}

/** The approach: neutral numbered steps from the server's projection (the
 *  lineage's steps when the middleware predates it). No run markers. */
function Approach({ item, data }: { item: GuideItem; data: ProcedureData }) {
  // The warning callout above already separates it; no second rule.
  const afterCallout = !!item.guide?.run_warning;
  const steps = item.guide
    ? approachSteps(item.guide)
    : data.steps.map((s) => ({ id: s.id, title: s.title }));
  return (
    <DetailSection first={afterCallout} title="The approach" hint={steps.length > 0 ? approachHint(steps.length) : undefined}>
      <ProcedureSteps
        aria-label="The approach"
        numbered
        size="sm"
        steps={steps}
        emptyLabel={!item.guide && data.loading ? 'Loading steps…' : 'No ordered steps on this procedure.'}
      />
    </DetailSection>
  );
}

interface GuideActions {
  onDraftPlan: () => void;
  onExplain: () => void;
  onViewRun: (runId: string) => void;
  onOpen: (href: string) => void;
}

function GuideContent({ item, actions }: { item: GuideItem; actions: GuideActions }) {
  return (
    <>
      <WhenThisHelps item={item} />
      <UseItInYourWork onDraftPlan={actions.onDraftPlan} onExplain={actions.onExplain} />
      <MarkdownView markdown={item.body_markdown} scale="md" data-testid="record-body" />
      <BasedOn item={item} onOpen={actions.onOpen} />
      <TechnicalDetailsBlock item={item} />
    </>
  );
}

function ProcedureContent({ item, data, actions }: { item: GuideItem; data: ProcedureData; actions: GuideActions }) {
  // What the steps section leaves of the markdown ("## Why", notes) is kept,
  // folded into Technical details rather than dropped.
  const rest = withoutStepsSection(item.body_markdown);
  return (
    <>
      <WhenThisHelps item={item} />
      <UseItInYourWork onDraftPlan={actions.onDraftPlan} onExplain={actions.onExplain} />
      <RunWarning item={item} onViewRun={actions.onViewRun} />
      <Approach item={item} data={data} />
      <BasedOn item={item} onOpen={actions.onOpen} />
      <TechnicalDetailsBlock
        item={item}
        extra={rest ? <MarkdownView markdown={rest} scale="md" data-testid="record-body" /> : undefined}
      />
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
  item, sourceCount, onOpenSources, onOpen, tab, runId, onTabChange, onViewRun, version = null,
}: {
  item: Item;
  /** The store's digest — moves when a run, a publish or a note lands. */
  version?: string | null;
  /** From the sources read; null while unknown (never shown as 0). */
  sourceCount: number | null;
  onOpenSources: () => void;
  /** Navigate within Knowledge (a source, a member note), pushing history. */
  onOpen: (href: string) => void;
  /** The record tab from the URL (`?tab=`). */
  tab: RecordTab;
  /** The run the URL names on the Runs tab (`?run=`). */
  runId: string | null;
  onTabChange: (tab: RecordTab) => void;
  /** "View run →" on the warning: the Runs tab with that run. */
  onViewRun: (runId: string) => void;
}) {
  const { can, ready } = useCapabilities();
  const canRecord = ready && can('ManageBots');
  const isProcedure = item.level === 'L2' && item.type === 'procedure';
  const procedure = useProcedure(isProcedure ? item.id : null, version);
  const crumbs = recordCrumbs(item);
  const status = recordStatus(item);
  const history = useMemo(() => recordHistory(item), [item]);
  const updated = item.level === 'L0' ? item.created_at : item.updated_at;
  const libraryId = item.level === 'L2' ? item.library_item_id : null;
  const activeTab: RecordTab = tab === 'runs' && !isProcedure ? 'content' : tab;

  // ── The guide's composer: what it attaches, and the two buttons that use it
  const composerRef = useRef<RichChatComposerHandle>(null);
  const [guideContext, setGuideContext] = useState<GuideContext>(DEFAULT_GUIDE_CONTEXT);
  const guide = item.level === 'L2' ? item.guide : undefined;
  const guideSubject = useMemo(
    () => ({ id: item.id, title: item.title, when_this_helps: item.level === 'L2' ? item.when_this_helps ?? null : null }),
    [item],
  );
  const actions: GuideActions = {
    // Prefill and wait: the reader names their project, reviews, then asks.
    onDraftPlan: useCallback(() => {
      setGuideContext('guide');
      const editor = composerRef.current?.editor;
      if (editor && !editor.isDestroyed) {
        // JSON content keeps the prefill's trailing space (HTML parsing trims it).
        editor.chain()
          .setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: PLAN_PREFILL }] }] })
          .focus('end')
          .run();
      } else {
        composerRef.current?.focus();
      }
    }, []),
    // Straight to Ask; always with at least the guide attached.
    onExplain: () => {
      const context = guideContext === 'none' ? DEFAULT_GUIDE_CONTEXT : guideContext;
      const prompt = guidePrompt(EXPLAIN_GUIDE_INSTRUCTION, guideSubject, guide, context);
      onOpen(`/iq/invoke?${new URLSearchParams({ prompt }).toString()}`);
    },
    onViewRun,
    onOpen,
  };

  return (
    <EditorShell
      title={item.title}
      titleSize="lg"
      statusPill={<StatusPill tone={status.tone} label={status.label} size="sm" />}
      subtitle={`${item.level === 'L0' ? 'Written' : 'Updated'} ${relativeTime(updated)}${item.level !== 'L2' && item.repo ? ` · ${shortRepo(item.repo)}` : ''}`}
      tabsTrailing={(
        <Inline gap="sm" align="center" wrap={false}>
          <Button size="sm" variant="secondary" onClick={onOpenSources} data-testid="record-sources-button">
            Sources{sourceCount != null ? ` ${sourceCount}` : ''}
          </Button>
          {libraryId && (
            <Button size="sm" variant="secondary" onClick={() => onOpen(`/iq/library/${encodeURIComponent(libraryId)}`)}>
              Open in Agent library ↗
            </Button>
          )}
        </Inline>
      )}
      tabs={[
        { id: 'content', label: 'Content' },
        { id: 'history', label: 'History' },
        ...(isProcedure ? [{ id: 'runs', label: 'Runs', count: procedure.runs.length || undefined }] : []),
      ]}
      activeTab={activeTab}
      onTabChange={(id) => onTabChange(id as RecordTab)}
      surface="plain"
      label="Knowledge record"
      data-testid="knowledge-record"
      footer={item.level === 'L2' ? (
        <ExplainComposer
          ref={composerRef}
          subject={item}
          contextOptions={GUIDE_CONTEXT_OPTIONS}
          context={guideContext}
          onContextChange={setGuideContext}
          placeholder="Describe your project or ask about this guide…"
          buildPrompt={(typed, context) => guidePrompt(typed, guideSubject, guide, context)}
        />
      ) : (
        <RecordExplainComposer
          subject={{ kind: crumbs[1].toLowerCase(), id: item.id, title: item.title }}
          referenceLabel={item.level === 'L1' ? 'This pattern' : 'This run note'}
          placeholder={item.level === 'L0' ? 'Ask what this run found…' : 'Explain when I should use this…'}
        />
      )}
    >
      {/* A guide's sections space themselves (DetailSection rules); the
          other tiers stack loose blocks and need the gap. */}
      <Stack gap={item.level === 'L2' && activeTab === 'content' ? 'none' : 'md'} className="w-full px-5 py-4">
        {activeTab === 'content' && (
          <>
            {item.level === 'L2' && item.type === 'procedure' && <ProcedureContent item={item} data={procedure} actions={actions} />}
            {item.level === 'L2' && item.type !== 'procedure' && <GuideContent item={item} actions={actions} />}
            {item.level === 'L1' && <PatternContent item={item} onOpen={onOpen} />}
            {item.level === 'L0' && <NoteContent item={item} onOpen={onOpen} />}
            {item.level !== 'L2' && <TechnicalDetailsBlock item={item} />}
            {item.level === 'L2' && <AssetRelationships kind="knowledge" id={item.id} />}
          </>
        )}
        {activeTab === 'history' && (
          <WorkActivityList first title="History" events={history} emptyLabel="No recorded history." />
        )}
        {activeTab === 'runs' && isProcedure && (
          <ProcedureRunsTab artifactId={item.id} data={procedure} canRecord={canRecord} runId={runId} />
        )}
      </Stack>
    </EditorShell>
  );
}
