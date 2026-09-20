// Shared document explorer for Workspace, Enterprise, Rules and Prompts.
// The library owns pane layout and rich editing. The gateway owns canvas
// content; the BFF retains source-bound comments, reactions and sync actions.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ActivityFeed,
  Breadcrumbs,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Inline,
  InlinePlaceholder,
  SearchInput,
  LoadingState,
  RailSection,
  Stack,
  T,
  Toolbar,
  VisuallyHidden,
  IconButton,
} from '@connorhoehnslalom/ui-components/shared';
import { RailSectionHeader } from '@connorhoehnslalom/ui-components/social';
import { ConversationShelf } from '@connorhoehnslalom/ui-components';
import { usePresence } from '@connorhoehnslalom/realtime-modules/client';
import { relativeTime } from '../../../lib/relativeTime';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { sendJson } from '../../../lib/writeJson';
import { DocPane, FolderPane } from './DocPane';
import { ActivityBar } from './ActivityBar';
import { DocumentLibrary } from './DocumentLibrary';
import { DocumentNavigationProvider, useDocumentNavigation } from './DocumentNavigation';
import { ExplorerFrame } from './ExplorerFrame';
import { KeyboardTreeView } from './KeyboardTreeView';
import { RenameNodeDialog, RowActionsMenu } from './RenameNodeDialog';
import { NewDraftDialog, type DraftDestination } from './NewDraftDialog';
import { useAssessmentEvents } from './useAssessmentEvents';
import {
  MODE_LABEL,
  RELATED_LINKS,
  activityForSection,
  channelForSection,
  findNode,
  firstViewableLeaf,
  flatNodes,
  isFolderNode,
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

function sectionTreeNodes(
  section: KnowledgeSection, activityCount: number, view: MainView,
  moveStatus: Record<string, 'pending' | 'moved'> = {},
): UiTreeNode[] {
  const base: UiTreeNode[] = section.nodes.map((n) => ({
    id: n.id, title: n.title, parentId: n.parent_id, isDir: n.is_dir,
    // TreeView draws `pending` translucent + aria-busy and flashes `moved`
    // when it lands. The library is explicit that it cannot know when a server
    // answered, so the host owns both edges of that window.
    ...(moveStatus[n.id] ? { status: moveStatus[n.id] } : {}),
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

/**
 * How long to keep saying "Pulling…" before admitting we have not heard back.
 *
 * The route answers 202 and the real work lands later as a `knowledge.pulled`
 * event, so the only thing that ends the spinner is an event arriving. If one
 * never does — the gateway is down, the event was dropped, or the server's own
 * deferred touch returned without publishing (the Aurora path bails on
 * `if (!updated) return`) — the button stayed disabled and said "Pulling…"
 * forever, which is a claim that work is in progress that nobody can support.
 * After the deadline it stops claiming that and says what is actually known:
 * the pull was accepted, the result never came back.
 */
const PULL_DEADLINE_MS = 30_000;

function SectionPullControl({ sectionKey, sseEvents, onTreeChanged, section }: {
  sectionKey: string; sseEvents: AssessmentSSEEvent[]; onTreeChanged: () => void;
  section: KnowledgeSection;
}) {
  const { can, ready } = useCapabilities();
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [silent, setSilent] = useState(false);
  const requestedAtRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pulling || !requestedAtRef.current) return;
    const landed = pulledEventsForSection(sseEvents, sectionKey).some((e) => e.ts >= requestedAtRef.current!);
    if (landed) {
      setPulling(false);
      onTreeChanged();
    }
  }, [sseEvents, pulling, sectionKey, onTreeChanged]);

  // The deadline. Refetch once on the way out: the pull may well have landed
  // and only its event gone missing, in which case the tree is the evidence.
  useEffect(() => {
    if (!pulling) return;
    const id = window.setTimeout(() => {
      setPulling(false);
      setSilent(true);
      onTreeChanged();
    }, PULL_DEADLINE_MS);
    return () => window.clearTimeout(id);
  }, [pulling, onTreeChanged]);

  if (!ready || !can('ManageKnowledge')) return null;

  const handlePull = async () => {
    setError(null);
    setSilent(false);
    requestedAtRef.current = new Date().toISOString();
    setPulling(true);
    try {
      await sendJson('/api/assessment/knowledge/pull', 'POST', { section: sectionKey });
    } catch (err) {
      setPulling(false);
      setError(err instanceof Error ? err.message : 'Failed to pull.');
    }
  };

  return (
    <Inline gap="xs" align="center" wrap>
      {/* What this section actually is, which the rail never said: which remote
          owns it and when it last moved. `last_pulled_at` is derived from the
          newest node, so it cannot claim a sync that touched nothing. */}
      <T className="text-[11px] text-text-tertiary">
        {section.last_pulled_at ? `pulled ${relativeTime(section.last_pulled_at)}` : 'never pulled'}
      </T>
      <Button variant="ghost" size="sm" disabled={pulling} onClick={() => void handlePull()}>
        {pulling ? 'Pulling…' : 'Pull'}
      </Button>
      {error && <T role="alert" className="text-[11px] text-danger">{error}</T>}
      {silent && !error && (
        <T role="status" className="text-[11px] text-warning">
          accepted, but no result came back — the tree may not have changed
        </T>
      )}
    </Inline>
  );
}

// ─── The explorer ─────────────────────────────────────────────────────────

export interface KnowledgeExplorerProps {
  mode: KnowledgeMode;
}

export function KnowledgeExplorer(props: KnowledgeExplorerProps) {
  return <DocumentNavigationProvider><KnowledgeExplorerContent {...props} /></DocumentNavigationProvider>;
}
function KnowledgeExplorerContent({ mode }: KnowledgeExplorerProps) {
  const navigation = useDocumentNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<MainView>({ kind: 'node' });
  const [query, setQuery] = useState('');
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [treeExpansion, setTreeExpansion] = useState<Record<string, string[]>>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem('assessment.documentTree.expansion') ?? '{}');
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter(([, ids]) => Array.isArray(ids) && ids.every(id => typeof id === 'string'))) : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem('assessment.documentTree.expansion', JSON.stringify(treeExpansion)); } catch { /* Session preference only. */ }
  }, [treeExpansion]);
  const sse = useAssessmentEvents();

  const treeFetch = useFetch<KnowledgeTreeResponse>('/api/assessment/knowledge/tree');
  const { can: canDo } = useCapabilities();

  // Preserve the accelerator's sibling/child placement. The shared tree
  // resolves drop positions; local and configured source trees use their
  // own authoritative move endpoint. Synthetic activity rows are never moved.
  const [moveStatus, setMoveStatus] = useState<Record<string, 'pending' | 'moved'>>({});
  const [moveError, setMoveError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [creating, setCreating] = useState<DraftDestination | null>(null);

  // Rename goes through the row's trailing menu because `TreeViewProps` has no
  // `onRename` — see RenameNodeDialog.tsx. The dialog surfaces the refusal
  // itself, so this only has to refetch on success.
  async function handleRename(id: string, title: string) {
    await sendJson('/api/assessment/knowledge/doc/rename', 'POST', { id, title });
    await treeFetch.refresh();
  }

  async function handleReorder(id: string, targetParentId: string | null, position: number) {
    setMoveError(null);
    setMoveStatus((m) => ({ ...m, [id]: 'pending' }));
    try {
      const sourceMove = id.startsWith('page:');
      if (sourceMove && !targetParentId) throw new Error('Source pages must remain beneath a source parent page.');
      const result = await sendJson<{ tree_refresh_failed?: boolean }>(sourceMove ? '/api/assessment/knowledge/source/move' : '/api/assessment/knowledge/doc/move', 'POST', { id, parentId: targetParentId, position });
      await treeFetch.refresh();
      if (result.tree_refresh_failed) setMoveError('The source move succeeded, but the refreshed tree is unavailable. Refresh the library before making another move.');
      setMoveStatus((m) => ({ ...m, [id]: 'moved' }));
      // Long enough to read as a landing, short enough not to linger as state.
      window.setTimeout(() => {
        setMoveStatus((m) => { const next = { ...m }; delete next[id]; return next; });
      }, 1200);
    } catch (err) {
      // The refusals are the interesting half and each names a reason —
      // "mirrors confluence", "publish it instead", "is not a folder". Show
      // the server's sentence rather than "move failed", and drop the pending
      // paint so the row stops looking like it is still going somewhere.
      setMoveStatus((m) => { const next = { ...m }; delete next[id]; return next; });
      setMoveError(err instanceof Error ? err.message : 'the move could not be saved');
    }
  }
  // Activity does: GET /runs is a real, contracted endpoint. Only fetched in
  // Workspace mode, the only mode with a synced section to show it for.
  const runsFetch = useFetch<unknown>(mode === 'workspace' ? '/api/assessment/runs?limit=20' : null);
  const activityRuns = useMemo(() => parseActivityRuns(runsFetch.data), [runsFetch.data]);

  const sections = useMemo(() => sectionsForMode(treeFetch.data?.sections ?? [], mode), [treeFetch.data, mode]);
  const nodes = useMemo(() => flatNodes(sections), [sections]);
  const sectionNodes = useMemo(() => new Map(sections.map(section => [section.key, sectionTreeNodes(
    section, activityForSection(section, activityRuns).length + pulledEventsForSection(sse.events, section.key).length, view, moveStatus,
  )])), [sections, activityRuns, sse.events, view, moveStatus]);
  const libraryOpen = searchParams.get('view') === 'library';
  const selectedId = searchParams.get('doc');
  const selectedNode = findNode(nodes, selectedId);
  const draftSectionKey = mode === 'workspace' ? 'workspace_drafts' : sections.find(section => section.kind === 'local')?.key;
  const mayCreate = mode !== 'prompts' && canDo('ManageKnowledge') && !!draftSectionKey;
  const createDraft = (destination: DraftDestination) => navigation?.navigate(() => setCreating(destination));

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

  const handleSelectNode = (id: string) => navigation?.navigate(() => {
    setView({ kind: 'node' });
    const next = new URLSearchParams(searchParams);
    next.set('doc', id);
    next.delete('view');
    setSearchParams(next);
  });

  const openLibrary = () => navigation?.navigate(() => {
    const next = new URLSearchParams(searchParams); next.set('view', 'library');
    setSearchParams(next); setView({ kind: 'node' });
  });

  const handleTreeSelect = (section: KnowledgeSection, id: string) => {
    if (id === ACTIVITY_ID(section.key)) {
      navigation?.navigate(() => {
      const next = new URLSearchParams(searchParams);
      next.delete('view');
      setSearchParams(next);
      setView({ kind: 'activity', sectionKey: section.key });
      });
      return;
    }
    handleSelectNode(id);
  };

  const modeLabel = MODE_LABEL[mode];
  const ancestors = view.kind === 'node' ? nodePath(nodes, selectedId) : [];
  const crumbs: { label: string; onClick?: () => void }[] = [
    ...(view.kind === 'activity' ? [{ label: 'Activity' }] : ancestors.map((n, index) => ({ label: n.title, ...(index < ancestors.length - 1 ? { onClick: () => handleSelectNode(n.id) } : {}) }))),
  ];

  const matches = nodes.filter((node) => node.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  const rail = (
    <>
      <RailSection title="Views">
        <ConversationShelf items={[{ id: 'library', label: 'All documents', count: nodes.filter((node) => !node.is_dir).length }]}
          activeId={libraryOpen ? 'library' : null} onSelect={openLibrary} />
      </RailSection>
      <Stack gap="sm" className="px-3">
        {query.trim() && <Stack gap="xs">
          <T className="text-xs text-text-secondary">{matches.length} results</T>
          {matches.map((node) => <Button key={node.id} variant="ghost" size="sm" className="justify-start border-0" onClick={() => { handleSelectNode(node.id); setQuery(''); }}>{node.title}</Button>)}
        </Stack>}
      </Stack>
      <RenameNodeDialog
        node={renaming}
        onClose={() => setRenaming(null)}
        onSubmit={handleRename}
      />
      {/* Why a move was refused, in the server's own words. Each refusal names
          something the reader can act on — which remote owns that subtree, or
          that publish is the way a doc leaves local — so a generic "move
          failed" would throw away the whole value of the check. Dismisses on
          the next drag. */}
      {moveError && (
        <ErrorState
          title="That move was not allowed"
          body={moveError}
          action={<Button size="sm" variant="ghost" onClick={() => setMoveError(null)}>Dismiss</Button>}
        />
      )}
      {treeFetch.isLoading && <LoadingState label="Loading…" />}
      {treeFetch.error && <ErrorState title="Couldn't load the document library" body={treeFetch.error} />}
      {!treeFetch.isLoading && !treeFetch.error && sections.length === 0 && (
        <RailSection title={modeLabel}>
          <InlinePlaceholder>Nothing here yet.</InlinePlaceholder>
        </RailSection>
      )}
      {!query.trim() && !treeFetch.isLoading && !treeFetch.error && sections.map((section) => {
        return (
          <Stack key={section.key} gap="xs" className="border-b border-border px-3 py-2">
            <RailSectionHeader label={`${section.title} · ${section.nodes.filter(node => !isFolderNode(node)).length}`}
              collapsed={!!collapsedSections[section.key]} presentational={false}
              onToggleCollapse={collapsed => setCollapsedSections(value => ({ ...value, [section.key]: collapsed }))}
              controls={`knowledge-section-${section.key}`} />
            {!collapsedSections[section.key] && <Stack gap="xs" id={`knowledge-section-${section.key}`}>
              <Inline gap="xs" align="center">
                <Chip size="xs" tone="neutral">{section.provider ?? (section.kind === 'local' ? 'Local documents' : 'Synced source')}</Chip>
              </Inline>
              <Inline justify="between" align="center">
                <SectionPresenceBadge sectionKey={section.key} />
                {section.kind === 'synced' && treeFetch.data?.sourceConfigured === true && (
                  <SectionPullControl section={section} sectionKey={section.key} sseEvents={sse.events} onTreeChanged={treeFetch.refresh} />
                )}
              </Inline>
              {section.nodes.length === 0 ? (
                <InlinePlaceholder>Nothing here yet.</InlinePlaceholder>
              ) : (
                <KeyboardTreeView
                  data-testid={`section-tree-${section.key}`}
                  nodes={sectionNodes.get(section.key) ?? []}
                  selectedId={selectedTreeIdFor(section, selectedId, view)}
                  expanded={treeExpansion[section.key] ?? []}
                  onToggle={(id, expanded) => setTreeExpansion(value => ({ ...value, [section.key]: expanded
                    ? [...new Set([...(value[section.key] ?? []), id])]
                    : (value[section.key] ?? []).filter(open => open !== id) }))}
                  onSelect={(id: string) => handleTreeSelect(section, id)}
                  onReorder={canDo('ManageKnowledge') && mode !== 'prompts' && (section.kind === 'local' || treeFetch.data?.sourceConfigured === true) ? handleReorder : undefined}
                  canDragNode={n => !n.id.endsWith('::activity') && (section.kind !== 'synced' || n.parentId !== null)}
                  canDropNode={(_dragged, target, position) => !target.id.endsWith('::activity') && (section.kind === 'synced'
                    ? position === 'into' || target.parentId !== null
                    : position !== 'into' || !!target.isDir)}
                  renderTrailing={(n: UiTreeNode) => {
                    const target = section.nodes.find(node => node.id === n.id);
                    if (!target || !mayCreate) return null;
                    return <Inline gap="none" wrap={false}>
                      {section.kind === 'local' && <RowActionsMenu title={n.title} onRename={() => setRenaming({ id: n.id, title: n.title })} />}
                      {(section.kind === 'synced' ? treeFetch.data?.sourceConfigured === true : target.is_dir) && <IconButton className="doc-tree-rename" variant="ghost" size="sm" icon="+"
                        aria-label={`Add child draft to ${n.title}`} title="Add child draft" tabIndex={-1}
                        onClick={event => { event.stopPropagation(); createDraft(section.kind === 'synced'
                          ? { sectionKey: 'workspace_drafts', sourceParentId: n.id, parentTitle: n.title }
                          : { sectionKey: section.key, parentId: n.id, parentTitle: n.title }); }} />}
                    </Inline>;
                  }}
                  {...(section.kind === 'local' && canDo('ManageKnowledge')
                    ? {
                        // Double-click the row. Same gate as the pencil beside
                        // it, so a viewer who cannot rename gets neither.
                        onRenameNode: (nodeId: string) => {
                          const target = section.nodes.find((n) => n.id === nodeId);
                          if (target) setRenaming({ id: target.id, title: target.title });
                        },
                      }
                    : {})}
                />
              )}
            </Stack>}
          </Stack>
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
  const isPage = !!selectedNode && !isFolderNode(selectedNode) && selectedNode.viewable !== false;
  const selectedSectionKey = selectedNode ? sectionForNode(sections, selectedNode.id)?.key ?? null : null;

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
      title={modeLabel}
      railHeader={<SearchInput aria-label="Find a document" placeholder="Find a document…" value={query} onChange={setQuery} onClear={() => setQuery('')} />}
      railActions={<Inline gap="none" wrap={false}>
        {mayCreate && <IconButton aria-label="New page" title="New page" variant="ghost" size="sm" icon="+" onClick={() => createDraft({ sectionKey: draftSectionKey! })} />}
        <IconButton aria-label="Refresh library" title="Refresh library" variant="ghost" size="sm" icon="↻" disabled={treeFetch.isLoading} onClick={() => void treeFetch.refresh()} />
      </Inline>}
      aside={!libraryOpen && view.kind === 'node' && isPage && selectedNode
        ? <ActivityBar node={selectedNode} sectionKey={selectedSectionKey} sseEvents={sse.events} />
        : undefined}
    >
      {/* Document pages use their own visible heading; other views still name the workspace. */}
      {(libraryOpen || view.kind !== 'node' || !isPage) && <VisuallyHidden as="h1">{modeLabel}</VisuallyHidden>}
      <NewDraftDialog destination={creating} onClose={() => setCreating(null)} onCreated={id => { treeFetch.refresh(); handleSelectNode(id); }} />
      {(!isPage || libraryOpen || crumbs.length > 1) && <Toolbar aria-label="Document navigation" wrap className="px-6 py-3">
        {(!isPage || libraryOpen) && <Button variant="ghost" size="sm" className="border-0" onClick={openLibrary}>Documents</Button>}
        {!libraryOpen && <Breadcrumbs items={isPage ? crumbs.slice(0, -1) : crumbs} />}
      </Toolbar>}

      {libraryOpen && (treeFetch.isLoading ? <LoadingState label="Loading document library…" />
        : treeFetch.error ? <ErrorState title="Couldn't load the document library" body={treeFetch.error} />
        : <Stack className="p-6"><DocumentLibrary sections={sections} onSelect={handleSelectNode} /></Stack>)}

      {!libraryOpen && view.kind === 'activity' && activityPane}

      {!libraryOpen && view.kind === 'node' && (
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
          <DocPane node={selectedNode} mode={mode} onBack={openLibrary} sourceConfigured={treeFetch.data?.sourceConfigured === true} sseEvents={sse.events} sseConnected={sse.connected} sseGapped={sse.gapped} onTreeChanged={treeFetch.refresh} />
        )
      )}
    </ExplorerFrame>
  );
}

export default KnowledgeExplorer;
