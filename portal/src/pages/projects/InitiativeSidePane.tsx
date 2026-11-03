// The initiative's right pane — the shell's fourth column (the library
// `SidePane`) — with tabs (the user, 2026-10-07): Discussion (the
// conversation thread), Agent (run progress), Details (initiative facts)
// and, while one is open, the record a link
// on the page asked for: a run's Log, a Decision, a Person. "Opening up logs
// or anything else in detail should go far right": detail opens here first,
// and its page only on "Open page".
//
// The pane is the library pane model (ui-components 2.438): `SidePane` in the
// shell's right column, its tabs and URL contract from `usePaneState`
// (`?pane=details`, `?pane=log&paneRecord=run:<job>`), Discussion the resting
// tab (no params), Details remembered per device. A detail
// beside the page explores a selection, which the shell's rail rule counts as
// the deep band. The Discussion stays mounted on every tab (its thread
// subscribed) and is hidden off its own tab. The composer and call tiles
// stay central in the main content column.
//
// Every read is the route the corresponding page reads, under its own gate:
// the job (`GET /api/work/jobs/:id`, session floor, as /iq/work/:jobId), the
// work-document associations (`GET /api/graph/work-items/:id/documents`, the
// work item brief's read), the person (`GET /api/graph/people/:id`, the
// contributor card's read). Nothing here widens what a reader may see.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  SidePane, usePaneState, useSidePane, useSidePaneHost, type PaneStateControl, type PaneTabSpec, type PersonDetail, type PersonEvidenceDocument,
} from '@connorhoehnslalom/ui-components';
import {
  Button, Chip, DetailSection, EmptyState, Inline, InlineAlert, KeyValue, LoadingState, MetaLine, Stack, StatusPill, T,
} from '@connorhoehnslalom/ui-components/shared';
import { ConversationViewsSlot } from '../../components/chat/useChatPins';
import { ConversationPaneBody, useConversationPane } from '../../components/shell/ConversationPane';
import { DirectoryPersonCard as PersonDetailCard } from '../../components/people/DirectoryPersonCard';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { usd } from '../../lib/format';
import { absoluteTime, durationLabel, relativeTime } from '../../lib/relativeTime';
import { runStateChip } from '../../lib/statusTone';
import { DECISION_TONE } from '../project-detail/projectFormat';
import type { OverviewModel } from '../project-detail/overviewModel';
import type { ProjectDecision } from '../project-detail/types';
import { RecordLink } from '../decisions/RecordLink';
import { InitiativeFacts, type InitiativeFactsInput } from './InitiativeDetailsCard';
import { jobIsLive, logLines, type LogJob } from './initiativePaneModel';
import { WorkItemBriefPane } from '../runbooks/WorkItemBriefPreview';
import { isDetailsShortcut } from './detailsShortcut';

/** The initiative pane's tabs: three resting tabs, and a record tab per kind a link on the page opens. */
export const INITIATIVE_PANE_TABS: readonly PaneTabSpec[] = [
  { id: 'discussion', label: 'Discussion' },
  { id: 'agent', label: 'Agent' },
  { id: 'details', label: 'Details', remember: true },
  { id: 'log', label: 'Log', recordKinds: ['run'] },
  { id: 'brief', label: 'Brief preview', recordKinds: ['work-item'] },
  { id: 'decision', label: 'Decision', recordKinds: ['decision'] },
  { id: 'person', label: 'Person', recordKinds: ['person'] },
];
export type InitiativePaneTab = 'discussion' | 'agent' | 'details' | 'log' | 'decision' | 'person' | 'brief';
const RECORD_KIND: Partial<Record<InitiativePaneTab, string>> = { brief: 'work-item', log: 'run', decision: 'decision', person: 'person' };
const TAB_LABEL = Object.fromEntries(INITIATIVE_PANE_TABS.map((t) => [t.id, t.label])) as Record<InitiativePaneTab, string>;
/**
 * A record tab shows a record, so its title names the record's kind and the
 * initiative drops to the second line. The three resting tabs are the
 * initiative's own: the initiative is the title and the selected tab is the
 * section — "Initiative details" over a Details tab said it twice (the user,
 * 2026-11-02).
 */
const RECORD_TITLE: Partial<Record<InitiativePaneTab, string>> = { log: 'Run log', decision: 'Decision', person: 'Person' };

export interface InitiativePaneControl {
  pane: PaneStateControl;
  tab: InitiativePaneTab;
  /** The record a record tab shows (a job, a decision, a person). */
  recordId: string | null;
  /** Open a tab in the pane (revealing it), naming its record. */
  open(tab: InitiativePaneTab, id?: string): void;
  isOpen: boolean;
  close(): void;
}

/** The initiative's pane state: the library contract with this page's tabs, restored per device once the pane is on screen. */
export function useInitiativePane(projectId: string | null): InitiativePaneControl {
  const [params, setParams] = useSearchParams();
  const sidePane = useSidePane();
  const host = useSidePaneHost();
  const pane = usePaneState({
    tabs: INITIATIVE_PANE_TABS, defaultTab: 'discussion', params, setParams,
    rememberKey: 'initiative.pane.tab', restore: { when: sidePane.visible, subject: projectId }, onOpen: sidePane.reveal,
  });
  useEffect(() => {
    if (!projectId) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isDetailsShortcut(event)) return;
      event.preventDefault();
      pane.open('details');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [projectId, pane.open]);
  return {
    pane,
    tab: pane.tab as InitiativePaneTab,
    recordId: pane.record?.id ?? null,
    isOpen: host.shown && !host.folded,
    close: host.collapse,
    open: (tab, id) => {
      const kind = RECORD_KIND[tab];
      pane.open(tab, kind && id ? { kind, id } : null);
    },
  };
}

export interface InitiativeSidePaneProps {
  control: InitiativePaneControl;
  /** The page's conversation thread: the Discussion tab. */
  discussion: ReactNode;
  /** Persistent run output, with input owned by the content column. */
  agent: ReactNode;
  /** The initiative's name: the pane's title on its own tabs, its second line under a record's. */
  subtitle: string;
  workItemLabel?: string;
  facts: InitiativeFactsInput;
  overview: OverviewModel;
  decisions: ProjectDecision[] | null;
  /** Every work item on the initiative (epics included): whose document links make up Docs. */
  workItemIds: string[] | null;
  /** The full workspace: Search scoped to the initiative. */
  workspaceHref: string;
  onOpenWorkItem: (id: string) => void;
  onOpenDecisions: () => void;
}

export function InitiativeSidePane(props: InitiativeSidePaneProps) {
  const { control, discussion, subtitle } = props;
  const { tab, recordId: id } = control;
  const conversationPane = useConversationPane({ onReveal: () => control.open('discussion') });
  const { huddle, inHuddle } = conversationPane;
  // The conversation's views (Chat / Pinned / Files / Calls) sit at the right end
  // of this one tab row as an icon switcher (useChatPins ConversationViewsSlot),
  // shown while Discussion is the tab — never a second tab bar under this one.
  const [viewsSlot, setViewsSlot] = useState<HTMLElement | null>(null);
  return (
    <SidePane title={tab === 'discussion' && inHuddle ? 'Huddle dialogue' : tab === 'brief' ? TAB_LABEL.brief : RECORD_TITLE[tab] ?? subtitle}
      subtitle={tab === 'brief' ? props.workItemLabel ?? subtitle : tab === 'discussion' && inHuddle ? huddle?.title : RECORD_TITLE[tab] ? subtitle : undefined}
      closeLabel={tab === 'brief' ? 'Close brief preview' : 'Close initiative pane'} explores={control.pane.away}
      paneId={tab === 'brief' ? 'work-item-brief' : 'initiative-dialogue'} widthPx={tab === 'brief' ? { min: 960, max: 1280 } : { min: 480, max: 960 }}
      presentation={tab === 'brief' ? 'document' : undefined}
      tabs={tab === 'brief' ? undefined : control.pane.tabs.filter(t => t.id !== 'brief').map(t => t.id === 'discussion' && inHuddle ? { ...t, label: 'Huddle' } : t)} value={tab} onValueChange={control.pane.select}
      trailing={<Inline gap="xs" align="center" wrap={false}>
        <Inline ref={setViewsSlot} gap="none" align="center" wrap={false} hidden={tab !== 'discussion'} className="shrink-0" data-testid="initiative-pane-views" />
      </Inline>}
      data-testid="initiative-pane">
      {/* The thread stays subscribed while another detail tab is selected. */}
      <Stack gap="none" className="min-h-0 flex-1" hidden={tab !== 'discussion'} data-testid="initiative-pane-discussion">
        <ConversationViewsSlot.Provider value={viewsSlot}>
          <ConversationPaneBody pane={conversationPane} pageLabel="Initiative discussion">
            <ConversationViewsSlot.Provider value={inHuddle ? null : viewsSlot}>{discussion}</ConversationViewsSlot.Provider>
          </ConversationPaneBody>
        </ConversationViewsSlot.Provider>
      </Stack>
      <Stack gap="none" className="min-h-0 flex-1" hidden={tab !== 'agent'} data-testid="initiative-pane-agent">{props.agent}</Stack>
      {tab !== 'discussion' && tab !== 'agent' && (
        // One inset (16px, the pane header's): every tab's body.
        <Stack gap="sm" className={tab === 'brief' ? 'min-h-0 flex-1 px-4 py-3 @container' : 'min-h-0 flex-1 overflow-y-auto px-4 py-3 @container'} data-testid={`initiative-pane-${tab}`}>
          {tab === 'details' && <InitiativeDetailsSummary {...props} />}
          {tab === 'brief' && id && <WorkItemBriefPane key={id} workItemId={id} />}
          {tab === 'log' && id && <LogTab jobId={id} />}
          {tab === 'decision' && id && <DecisionTab id={id} decisions={props.decisions} onOpenWorkItem={props.onOpenWorkItem} onOpenDecisions={props.onOpenDecisions} />}
          {tab === 'person' && id && <PersonTab personId={id} onClose={() => control.open('discussion')}
            onFocusPerson={(other) => control.open('person', other)} onAsk={() => control.open('discussion')} />}
        </Stack>
      )}
    </SidePane>
  );
}

// ─── Details ────────────────────────────────────────────────────────────────

// Compact (the user, 2026-11-02: "no waste or unnecessary stuff"): the
// summary, the facts the header does not already show, and ONE work action
// whose title is the link. Docs and Activity are the page's own tabs, so the
// pane no longer repeats them as buttons.
export function InitiativeDetailsSummary({ facts, overview, onOpenWorkItem }: Pick<InitiativeSidePaneProps, 'facts' | 'overview' | 'onOpenWorkItem'>) {
  const navigate = useNavigate();
  const ready = overview.state === 'ready' ? overview : null;
  const next = ready?.upNext[0] ?? null;
  const risks = ready?.attention ?? [];
  const action = risks[0] ?? next;
  const openItem = (href: string) => {
    const item = new URLSearchParams(href.split('?')[1] ?? '').get('item');
    if (item) onOpenWorkItem(item); else navigate(href);
  };
  return (
    <Stack gap="md">
      {facts.project.summary && <T size="sm" tone="secondary" wrap as="p" className="line-clamp-3" title={facts.project.summary} data-testid="initiative-details-summary">{facts.project.summary}</T>}
      <InitiativeFacts input={facts} />
      {action && <DetailSection as="h2" variant="heading" title={risks.length ? 'Needs attention' : 'Next work item'} className="border-t border-border pt-3" data-testid="initiative-details-action">
        <Stack gap="xs">
          <Button variant="link" size="sm" onClick={() => openItem(action.href)} aria-label={`Open work item ${action.key ?? action.title}`}
            className="h-auto justify-start whitespace-normal px-0 text-left">
            <T size="sm" weight="medium" tone="inherit" wrap>{action.title}</T>
          </Button>
          <MetaLine size="sm" tone="secondary" items={[
            action.key ? <Chip key="key" size="xs" tone="neutral" mono>{action.key}</Chip> : null,
            action.assigneeName ?? 'Unassigned',
            action.points || null,
          ]} />
          {'reason' in action && action.reason && <T size="xs" tone="secondary" wrap>{action.reason}</T>}
        </Stack>
      </DetailSection>}
      {!ready && <T size="sm" tone="secondary">{overview.state === 'loading' ? 'Loading work…' : 'Work could not be read.'}</T>}
      {ready && !action && <T size="sm" tone="secondary">No work is waiting for attention.</T>}
    </Stack>
  );
}

// ─── Log ────────────────────────────────────────────────────────────────────

interface JobRead extends LogJob {
  id: string; title: string; botName: string | null; startedAt: string | null; finishedAt: string | null;
  result: (LogJob['result'] & { costUsd?: number; durationMs?: number }) | null;
}

function LogTab({ jobId }: { jobId: string }) {
  const navigate = useNavigate();
  const [live, setLive] = useState(true);
  const { data: job, error, isLoading } = useFetch<JobRead>(`/api/work/jobs/${encodeURIComponent(jobId)}`, live ? 5_000 : 30_000);
  useEffect(() => { if (job) setLive(jobIsLive(job.status)); }, [job]);
  const lines = useMemo(() => (job ? logLines(job) : []), [job]);
  const openPage = <Button variant="secondary" size="sm" onClick={() => navigate(`/iq/work/${encodeURIComponent(jobId)}`)} data-testid="initiative-log-open-page">Open page</Button>;
  if (error && !job) {
    return <Stack gap="sm"><InlineAlert tone="error">{`This run's log could not be read: ${error}`}</InlineAlert><Inline>{openPage}</Inline></Stack>;
  }
  if (!job) return <LoadingState label={isLoading ? 'Loading the run…' : 'Waiting for the run…'} />;
  const chip = runStateChip(job.status);
  return (
    <Stack gap="sm" data-testid="initiative-log">
      <Inline gap="sm" justify="between" align="start" wrap={false}>
        <Stack gap="none" className="min-w-0">
          <T size="sm" weight="semibold" wrap>{job.title}</T>
          <MetaLine size="sm" tone="secondary" items={[
            job.startedAt ? relativeTime(job.startedAt) : null,
            job.result?.durationMs != null ? durationLabel(job.result.durationMs) : null,
            job.result?.costUsd != null ? usd(job.result.costUsd) : null,
          ]} />
        </Stack>
        {openPage}
      </Inline>
      <Inline gap="sm" align="center">
        <StatusPill variant="text" tone={chip.tone === 'success' || chip.tone === 'warning' || chip.tone === 'danger' || chip.tone === 'info' ? chip.tone : 'neutral'} label={chip.label} />
        {jobIsLive(job.status) && <T size="xs" tone="tertiary">Refreshing every 5 seconds</T>}
      </Inline>
      {lines.length
        ? <Stack gap="none" aria-label="Run log" data-testid="initiative-log-lines">
            {lines.map((line) => <Inline key={line.id} gap="sm" align="start" wrap={false} className="border-b border-border py-2" data-testid="initiative-log-line">
              <T size="xs" tone={line.kind === 'error' ? 'primary' : 'tertiary'} className="w-20 shrink-0 truncate" title={line.label}>{line.label}</T>
              <T size="sm" wrap className="min-w-0 flex-1 whitespace-pre-wrap break-words">{line.text}</T>
            </Inline>)}
          </Stack>
        : <EmptyState title={job.status === 'queued' ? 'Waiting for a worker' : 'No activity recorded'}
            body="The full page keeps the run's activity, outputs and changes." />}
    </Stack>
  );
}

// ─── Decision ───────────────────────────────────────────────────────────────

function DecisionTab({ id, decisions, onOpenWorkItem, onOpenDecisions }: {
  id: string; decisions: ProjectDecision[] | null; onOpenWorkItem: (id: string) => void; onOpenDecisions: () => void;
}) {
  if (!decisions) return <LoadingState label="Loading decisions…" />;
  const decision = decisions.find((d) => d.id === id);
  if (!decision) return <EmptyState title="Decision unavailable" body="It is not among this initiative's decisions." />;
  return (
    <Stack gap="sm" data-testid="initiative-decision">
      <Inline gap="sm" align="start" wrap={false}>
        <Chip tone={DECISION_TONE[decision.status] ?? 'warning'} size="xs" uppercase>{decision.status}</Chip>
        <T size="sm" weight="semibold" wrap className="min-w-0 flex-1">{decision.topic}</T>
      </Inline>
      {decision.summary && <T size="sm" tone="secondary" wrap as="p">{decision.summary}</T>}
      <KeyValue labelWidth="w-24" items={[
        { label: 'Needs', value: decision.requiredRole ?? 'Any steward', muted: !decision.requiredRole },
        { label: 'Escalated', value: decision.escalatedAt ? absoluteTime(decision.escalatedAt) : 'Not escalated', muted: !decision.escalatedAt },
        { label: 'Work item', value: decision.workItemId && decision.workItemTitle
          ? <Button variant="link" size="sm" onClick={() => onOpenWorkItem(decision.workItemId!)}><T size="sm" tone="inherit">{decision.workItemTitle}</T></Button>
          : 'None linked', muted: !decision.workItemId },
      ]} />
      <Inline gap="sm"><RecordLink to={`/iq/decisions/${encodeURIComponent(decision.id)}`}>Open the decision record</RecordLink>
        <Button variant="secondary" size="sm" onClick={onOpenDecisions}>Open Decisions</Button></Inline>
    </Stack>
  );
}

// ─── Person ─────────────────────────────────────────────────────────────────

/** A person's own page: the org graph focused on them, their card open. */
function personPageHref(id: string): string {
  return `/iq/search?${new URLSearchParams({ tab: 'connections', type: 'person', selection: `person:${id}`, detail: id })}`;
}

function PersonTab({ personId, onClose, onFocusPerson, onAsk }: {
  personId: string; onClose: () => void; onFocusPerson: (id: string) => void; onAsk: () => void;
}) {
  const navigate = useNavigate();
  const { session } = useSession();
  // Influence is leadership analytics (ViewLeaderboard tier), as on the contributor card.
  const showInfluence = session?.role === 'org-leader' || session?.role === 'hr-admin' || session?.role === 'admin';
  const id = encodeURIComponent(personId);
  const { data: person, isLoading, error } = useFetch<PersonDetail>(`/api/graph/people/${id}`);
  const { data: evidence } = useFetch<{ documents: PersonEvidenceDocument[] }>(`/api/graph/people/${id}/evidence`);
  return (
    <Stack gap="none" className="min-h-0 flex-1" data-testid="initiative-person">
      <Inline justify="end" className="shrink-0">
        <Button size="sm" variant="ghost" onClick={() => navigate(personPageHref(personId))}>Open page</Button>
      </Inline>
      <PersonDetailCard className="static min-h-0 w-full flex-1 rounded-none border-0 shadow-none" person={person} evidence={evidence?.documents ?? []}
        loading={isLoading} error={error ?? null} showInfluence={showInfluence} onClose={onClose}
        // A collaborator opens in the same tab; Ask goes to the Discussion, the page's one composer.
        onFocusPerson={onFocusPerson} onAsk={onAsk} askLabel={() => 'Discuss'} />
    </Stack>
  );
}
