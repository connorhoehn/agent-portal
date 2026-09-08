// The reusable three-pane document explorer behind Workspace, Enterprise,
// Rules and Prompts (docs/assessment-tenant.md "The two layouts worth keeping
// -> Workspace page"). Ported from agentic-assessment-accelerator's
// knowledge/DocumentsExplorer.tsx: a 300px section rail (KnowledgeTree +, for
// synced sections, a Views block's Activity row) -> a main pane (breadcrumb +
// DocView) -> an xl-only realtime activity bar for synced pages.
//
// `mode` picks which GET /api/assessment/knowledge/tree sections render —
// see knowledgeFormat.sectionsForMode. State (fetching, the Views toggle)
// lives here; every derivation it calls is pure and lives in
// ./knowledgeFormat so it can be tested without React. Document-scoped state
// (editing, presence, chat, reactions) lives in ./DocPane, which owns its own
// realtime channel.
//
// Realtime wiring (docs/assessment-tenant.md's Workspace realtime plan):
// one GET /api/assessment/events SSE connection for the whole page
// (./useAssessmentEvents), a hand-rolled reconnect gate around the gateway
// connection (see the note above the disconnected early-return below — the
// library's ReconnectingShim/RealtimeCapabilityProvider are off the table),
// a presence headcount per section, and a Pull control on synced sections
// that stays pending until its knowledge.pulled event arrives over SSE.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ActivityFeed,
  Breadcrumbs,
  Button,
  Chip,
  ConnectionPill,
  EmptyState,
  ErrorState,
  Inline,
  InlinePlaceholder,
  LoadingState,
  RailSection,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useGateway, usePresence } from '@connorhoehnslalom/realtime-modules/client';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { DocPane, FolderPane } from './DocPane';
import { ActivityBar } from './ActivityBar';
import { ExplorerFrame } from './ExplorerFrame';
import { KeyboardTreeView } from './KeyboardTreeView';
import { useAssessmentEvents } from './useAssessmentEvents';
import {
  MODE_LABEL,
  RELATED_LINKS,
  activityForSection,
  channelForSection,
  findNode,
  firstViewableLeaf,
  flatNodes,
  gatewayOfflineHint,
  isFolderNode,
  isGatewayReady,
  isPageNode,
  liveConnectionState,
  nodePath,
  parseActivityRuns,
  pulledEventsForSection,
  sectionForNode,
  sectionsForMode,
  toActivityFeedItems,
} from './knowledgeFormat';
import type {
  AssessmentSSEEvent,
  KnowledgeMode,
  KnowledgeNode,
  KnowledgeSection,
  KnowledgeTreeResponse,
} from './types';

async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ─── Which single thing the main pane shows ─────────────────────────────────
// Mirrors the source's MainView: exactly one of a selected doc or the
// section's Activity list is ever on screen at once, and the rail (tree +
// Views block) is what drives which one. The "All comments" row from the
// source is gone — comments now live per-document, on DocPane's own chat
// drawer, which has a real backing (the channel's chat store) instead of an
// always-empty list.

type MainView = { kind: 'node' } | { kind: 'activity'; sectionKey: string };

const ACTIVITY_ID = (sectionKey: string) => `${sectionKey}::activity`;

interface UiTreeNode {
  id: string;
  title: string;
  parentId: string | null;
  isDir?: boolean;
  badge?: ReactNode;
}

function sectionTreeNodes(section: KnowledgeSection, activityCount: number, view: MainView): UiTreeNode[] {
  const base: UiTreeNode[] = section.nodes.map((n) => ({
    id: n.id, title: n.title, parentId: n.parent_id, isDir: n.is_dir,
  }));
  if (section.kind !== 'synced') return base;
  const activityActive = view.kind === 'activity' && view.sectionKey === section.key;
  return [
    ...base,
    {
      id: ACTIVITY_ID(section.key), title: 'Activity', parentId: null,
      badge: <Chip size="xs" mono tone={activityActive ? 'info' : 'neutral'}>{activityCount}</Chip>,
    },
  ];
}

function selectedTreeIdFor(section: KnowledgeSection, selectedNodeId: string | null, view: MainView): string | null {
  if (view.kind === 'activity' && view.sectionKey === section.key) return ACTIVITY_ID(section.key);
  if (view.kind === 'node' && selectedNodeId && section.nodes.some((n) => n.id === selectedNodeId)) return selectedNodeId;
  return null;
}

// ─── Section rail extras: presence headcount + Pull control ────────────────
// RailSection's `title` is a plain string (no slot for a badge or button
// next to it — see the report), so these render as the first row of the
// section's own children instead of inline with the title text.

function SectionPresenceBadge({ sectionKey }: { sectionKey: string }) {
  const { roster } = usePresence(channelForSection(sectionKey));
  if (roster.length === 0) return null;
  return <Chip size="xs" tone="neutral">{roster.length} viewing</Chip>;
}

function SectionPullControl({ sectionKey, sseEvents, onTreeChanged }: {
  sectionKey: string; sseEvents: AssessmentSSEEvent[]; onTreeChanged: () => void;
}) {
  const { can, ready } = useCapabilities();
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestedAtRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pulling || !requestedAtRef.current) return;
    const landed = pulledEventsForSection(sseEvents, sectionKey).some((e) => e.ts >= requestedAtRef.current!);
    if (landed) {
      setPulling(false);
      onTreeChanged();
    }
  }, [sseEvents, pulling, sectionKey, onTreeChanged]);

  if (!ready || !can('ManageKnowledge')) return null;

  const handlePull = async () => {
    setError(null);
    requestedAtRef.current = new Date().toISOString();
    setPulling(true);
    try {
      await postJson('/api/assessment/knowledge/pull', { section: sectionKey });
    } catch (err) {
      setPulling(false);
      setError(err instanceof Error ? err.message : 'Failed to pull.');
    }
  };

  return (
    <Inline gap="xs" align="center">
      <Button variant="ghost" size="sm" disabled={pulling} onClick={() => void handlePull()}>
        {pulling ? 'Pulling…' : 'Pull'}
      </Button>
      {error && <Chip size="xs" tone="danger">{error}</Chip>}
    </Inline>
  );
}

// ─── The explorer ─────────────────────────────────────────────────────────

export interface KnowledgeExplorerProps {
  mode: KnowledgeMode;
}

export function KnowledgeExplorer({ mode }: KnowledgeExplorerProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<MainView>({ kind: 'node' });
  const gateway = useGateway();
  const sse = useAssessmentEvents();

  const treeFetch = useFetch<KnowledgeTreeResponse>('/api/assessment/knowledge/tree');
  // Activity does: GET /runs is a real, contracted endpoint. Only fetched in
  // Workspace mode, the only mode with a synced section to show it for.
  const runsFetch = useFetch<unknown>(mode === 'workspace' ? '/api/assessment/runs?limit=20' : null);
  const activityRuns = parseActivityRuns(runsFetch.data);

  const sections = sectionsForMode(treeFetch.data?.sections ?? [], mode);
  const nodes = flatNodes(sections);
  const selectedId = searchParams.get('doc');
  const selectedNode = findNode(nodes, selectedId);

  // Default to the first viewable leaf once the tree loads, if the URL
  // didn't already name a document — landing on a folder or a hidden binary
  // would open a pane with nothing to show.
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedDefaultRef.current) return;
    if (!treeFetch.data) return;
    appliedDefaultRef.current = true;
    if (searchParams.get('doc')) return;
    const leaf = firstViewableLeaf(nodes);
    if (!leaf) return;
    const next = new URLSearchParams(searchParams);
    next.set('doc', leaf.id);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeFetch.data]);

  const handleSelectNode = (id: string) => {
    setView({ kind: 'node' });
    const next = new URLSearchParams(searchParams);
    next.set('doc', id);
    setSearchParams(next);
  };

  const handleTreeSelect = (section: KnowledgeSection, id: string) => {
    if (id === ACTIVITY_ID(section.key)) { setView({ kind: 'activity', sectionKey: section.key }); return; }
    handleSelectNode(id);
  };

  const modeLabel = MODE_LABEL[mode];
  const ancestors = view.kind === 'node' ? nodePath(nodes, selectedId) : [];
  const crumbs: { label: string; href?: string }[] = [
    { label: 'Home', href: '/assessment/teams' },
    { label: modeLabel },
    ...(view.kind === 'activity' ? [{ label: 'Activity' }] : ancestors.map((n) => ({ label: n.title }))),
  ];

  const rail = (
    <>
      {treeFetch.isLoading && <LoadingState label="Loading…" />}
      {treeFetch.error && <ErrorState title="Couldn't load the document library" body={treeFetch.error} />}
      {!treeFetch.isLoading && !treeFetch.error && sections.length === 0 && (
        <RailSection title={modeLabel}>
          <InlinePlaceholder>Nothing here yet.</InlinePlaceholder>
        </RailSection>
      )}
      {!treeFetch.isLoading && !treeFetch.error && sections.map((section) => {
        const activityCount = activityForSection(section, activityRuns).length + pulledEventsForSection(sse.events, section.key).length;
        return (
          <RailSection
            key={section.key}
            title={`${section.title} · ${section.nodes.length}${section.kind === 'synced' ? ' · Synced' : ''}`}
          >
            <Stack gap="xs">
              <Inline justify="between" align="center">
                <SectionPresenceBadge sectionKey={section.key} />
                {section.kind === 'synced' && (
                  <SectionPullControl sectionKey={section.key} sseEvents={sse.events} onTreeChanged={treeFetch.refresh} />
                )}
              </Inline>
              {section.nodes.length === 0 ? (
                <InlinePlaceholder>Nothing here yet.</InlinePlaceholder>
              ) : (
                <KeyboardTreeView
                  data-testid={`section-tree-${section.key}`}
                  nodes={sectionTreeNodes(section, activityCount, view)}
                  selectedId={selectedTreeIdFor(section, selectedId, view)}
                  onSelect={(id: string) => handleTreeSelect(section, id)}
                />
              )}
            </Stack>
          </RailSection>
        );
      })}
      {mode === 'enterprise' && !treeFetch.isLoading && !treeFetch.error && (
        <RailSection title="Related">
          <Stack gap="xs">
            {RELATED_LINKS.map((link) => (
              <Link key={link.href} to={link.href} className="text-sm text-text-secondary no-underline hover:text-primary hover:underline">
                {link.label}
              </Link>
            ))}
          </Stack>
        </RailSection>
      )}
    </>
  );

  const activitySection = view.kind === 'activity' ? sections.find((s) => s.key === view.sectionKey) : undefined;
  const isPage = isPageNode(selectedNode);
  const selectedSectionKey = selectedNode ? sectionForNode(sections, selectedNode.id)?.key ?? null : null;
  const gatewayHint = gatewayOfflineHint(isGatewayReady(gateway.connectionState, gateway.clientId));

  // Hand-rolled in place of ReconnectingShim/RealtimeCapabilityProvider —
  // see the top-of-file note: both live in the Tiptap-tainted integrations
  // subpath, which cannot be imported at all without breaking `vite build`.
  //
  // NOT gated on gateway.connectionState any more. Doc sync, comments and
  // presence all run over GET /api/assessment/events now (see DocPane) —
  // "the gateway is disconnected" is a normal, expected state (the /ws
  // stub, or a real gateway that's briefly down), not a reason to hide the
  // whole explorer behind a blocking retry screen. Only reactions and live
  // CRDT co-editing still need the gateway; those degrade individually
  // (empty reactions bar, last-write-wins Save) rather than blocking
  // everything else that works fine without it. The pill + "Gateway
  // offline" hint above already say so honestly.

  const activityPane = view.kind === 'activity' && (() => {
    const runItems = activitySection ? toActivityFeedItems(activityForSection(activitySection, activityRuns)) : [];
    const pulledItems = activitySection
      ? pulledEventsForSection(sse.events, activitySection.key).map((e) => ({
        id: `pull-${e.ts}`, actor: 'Confluence sync', action: 'pulled',
        subject: `${e.files_pulled} of ${e.pages} pages`, timeLabel: e.ts, kind: 'status',
      }))
      : [];
    const items = [...pulledItems, ...runItems];
    return items.length > 0
      ? <ActivityFeed items={items} rotateMs={0} />
      : <InlinePlaceholder size="sm">No recent activity for this section.</InlinePlaceholder>;
  })();

  return (
    <ExplorerFrame
      rail={rail}
      aside={view.kind === 'node' && isPage && selectedNode
        ? <ActivityBar node={selectedNode} sectionKey={selectedSectionKey} sseEvents={sse.events} />
        : undefined}
    >
      <Inline justify="between" align="center" className="mb-4">
        <Breadcrumbs items={crumbs} />
        <Inline gap="xs" align="center">
          {/* Driven by the SSE stream (the substrate that actually carries
              doc-saved/comment/presence updates), not gateway.connectionState
              — middleware's /ws stub accepts every socket and would report
              'connected' forever with nothing behind it. See
              docs/assessment-journeys/stretch/realtime.md. */}
          <ConnectionPill state={liveConnectionState(sse.connected)} labels={{ connected: 'Live', connecting: 'Connecting…' }} />
          {gatewayHint && <Chip size="xs" tone="warning">{gatewayHint}</Chip>}
        </Inline>
      </Inline>

      {view.kind === 'activity' && activityPane}

      {view.kind === 'node' && (
        !selectedNode ? (
          <EmptyState title="Select a document from the library to view it." />
        ) : isFolderNode(selectedNode) ? (
          <FolderPane
            node={selectedNode}
            children={nodes.filter((n) => n.parent_id === selectedNode.id)}
            onSelectChild={handleSelectNode}
          />
        ) : selectedNode.viewable === false ? (
          <EmptyState title={selectedNode.title} body="This file isn't viewable here." description={selectedNode.id} />
        ) : (
          <DocPane node={selectedNode} mode={mode} sseEvents={sse.events} sseConnected={sse.connected} onTreeChanged={treeFetch.refresh} />
        )
      )}
    </ExplorerFrame>
  );
}

export default KnowledgeExplorer;
