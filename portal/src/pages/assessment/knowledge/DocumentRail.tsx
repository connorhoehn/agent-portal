// The documents rail, composed the way realtime-examples' Documents explorer
// composes its own (frontend/src/components/doc-editor/explorer/DocumentExplorer.tsx):
// a plain All documents / Recent / Shared with me shelf, then ONE rail-scale
// tree whose root rows are folders. Here each source section is that folder,
// so the accelerator's behaviour rides the same rows: the folder's ⋯ holds
// New page and Pull, its trailing slot the presence and the Pull control, and
// drag keeps the per-section rules the source adapter enforces.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIcon,
  Banner,
  FileKindMark,
  FolderIcon,
  IconButton,
  InlinePlaceholder,
  PresenceAvatars,
  RepeatIcon,
  Stack,
  type DropdownMenuSection,
  type TreeDropPosition,
  type TreeNode,
} from '@connorhoehnslalom/ui-components/shared';
import { RailSectionHeader } from '@connorhoehnslalom/ui-components/social';
import { ConversationShelf } from '@connorhoehnslalom/ui-components';
import { usePresence } from '@connorhoehnslalom/realtime-modules/client';
import { relativeTime } from '../../../lib/relativeTime';
import { useCapabilities } from '../../../lib/capabilities';
import { sendJson } from '../../../lib/writeJson';
import { KeyboardTreeView } from './KeyboardTreeView';
import type { DraftDestination } from './NewDraftDialog';
import {
  channelForSection,
  compactAge,
  isFolderNode,
  presenceAvatarUsers,
  pulledEventsForSection,
  recentDocuments,
  sectionDocumentCount,
  sectionFolderId,
  sectionKeyOfFolder,
} from './knowledgeFormat';
import type { AssessmentSSEEvent, KnowledgeNode, KnowledgeSection } from './types';

export type QuickView = 'recent' | 'shared';
export const ACTIVITY_ID = (sectionKey: string) => `${sectionKey}::activity`;
const VIEW_ALL = 'view:all';
const VIEW_RECENT = 'view:recent';
const VIEW_SHARED = 'view:shared';

// ─── Pull ───────────────────────────────────────────────────────────────────

/**
 * How long to keep saying "Pulling…" before admitting we have not heard back.
 *
 * The route answers 202 and the real work lands later as a `knowledge.pulled`
 * event, so the only thing that ends the spinner is an event arriving. If one
 * never does — the gateway is down, the event was dropped, or the server's own
 * deferred touch returned without publishing — the folder would stay busy
 * forever, a claim that work is in progress that nobody can support. After the
 * deadline it stops claiming that and says what is actually known: the pull
 * was accepted, the result never came back.
 */
const PULL_DEADLINE_MS = 30_000;

interface PullState { requestedAt: string | null; pulling: boolean; error: string | null; silent: boolean }
const IDLE: PullState = { requestedAt: null, pulling: false, error: null, silent: false };

/** Every synced section's Pull, keyed by section: the folder row and its ⋯ share one state. */
export function useSectionPulls(sseEvents: AssessmentSSEEvent[], onTreeChanged: () => void) {
  const [pulls, setPulls] = useState<Record<string, PullState>>({});
  const set = (key: string, next: Partial<PullState>) => setPulls(value => ({ ...value, [key]: { ...(value[key] ?? IDLE), ...next } }));

  // A pull ends when its `knowledge.pulled` event lands.
  useEffect(() => {
    const landed = Object.entries(pulls).filter(([key, pull]) => pull.pulling && pull.requestedAt
      && pulledEventsForSection(sseEvents, key).some(event => event.ts >= pull.requestedAt!));
    if (landed.length === 0) return;
    setPulls(value => ({ ...value, ...Object.fromEntries(landed.map(([key, pull]) => [key, { ...pull, pulling: false }])) }));
    onTreeChanged();
  }, [sseEvents, pulls, onTreeChanged]);

  // The deadline. Refetch once on the way out: the pull may well have landed
  // and only its event gone missing, in which case the tree is the evidence.
  const timers = useRef<Record<string, number>>({});
  useEffect(() => () => { Object.values(timers.current).forEach(id => window.clearTimeout(id)); }, []);

  async function pull(key: string) {
    set(key, { requestedAt: new Date().toISOString(), pulling: true, error: null, silent: false });
    window.clearTimeout(timers.current[key]);
    timers.current[key] = window.setTimeout(() => {
      setPulls(value => value[key]?.pulling ? { ...value, [key]: { ...value[key]!, pulling: false, silent: true } } : value);
      onTreeChanged();
    }, PULL_DEADLINE_MS);
    try {
      await sendJson('/api/assessment/knowledge/pull', 'POST', { section: key });
    } catch (err) {
      window.clearTimeout(timers.current[key]);
      set(key, { pulling: false, error: err instanceof Error ? err.message : 'Failed to pull.' });
    }
  }
  const dismiss = (key: string) => set(key, { error: null, silent: false });
  return { pulls, pull, dismiss };
}

type SectionPulls = ReturnType<typeof useSectionPulls>;

/** The Pull control on a synced source's folder row. */
function SectionPullControl({ section, pulls }: { section: KnowledgeSection; pulls: SectionPulls }) {
  const pulling = !!pulls.pulls[section.key]?.pulling;
  return <IconButton variant="ghost" size="sm" icon={<RepeatIcon size={14} />} tabIndex={-1} disabled={pulling}
    aria-label={pulling ? `Pulling ${section.title}…` : `Pull ${section.title} from ${section.provider ?? 'its source'}`}
    title={pulling ? 'Pulling…' : `Pull — ${section.last_pulled_at ? `pulled ${relativeTime(section.last_pulled_at)}` : 'never pulled'}`}
    data-testid={`section-pull-${section.key}`}
    onClick={event => { event.stopPropagation(); void pulls.pull(section.key); }} />;
}

/**
 * Who else has this source open — the rail's per-folder presence. The viewer
 * joins only the section that holds the document they have open (`join`), so
 * the roster means "has this source open", not "has the rail on screen";
 * without any join the avatars never rendered (re-audit #7, 2026-09-29).
 */
function SectionPresence({ sectionKey, join }: { sectionKey: string; join: boolean }) {
  const { roster } = usePresence(channelForSection(sectionKey), { join });
  if (roster.length === 0) return null;
  return <PresenceAvatars size={20} maxVisible={3} users={presenceAvatarUsers(roster)} />;
}

// ─── The tree ─────────────────────────────────────────────────────────────

function leafIcon(node: KnowledgeNode) {
  return isFolderNode(node) ? <FolderIcon size={16} /> : <FileKindMark kind="page" size="sm" variant="glyph" />;
}

export interface DocumentRailProps {
  sections: KnowledgeSection[];
  /** The page open in the pane, or the section whose Activity is. */
  selectedId: string | null;
  activitySectionKey: string | null;
  libraryOpen: boolean;
  quickView: QuickView | null;
  onQuickView: (view: QuickView | null) => void;
  onOpenLibrary: () => void;
  onOpenDocument: (id: string) => void;
  onOpenActivity: (sectionKey: string) => void;
  activityCount: (section: KnowledgeSection) => number;
  moveStatus: Record<string, 'pending' | 'moved'>;
  sourceConfigured: boolean;
  /** Absent: this viewer may not create here. */
  onCreate?: (destination: DraftDestination) => void;
  onRename?: (node: { id: string; title: string }) => void;
  /** Absent: nothing in this rail moves (a reader, the Prompts library). */
  onReorder?: (id: string, targetParentId: string | null, position: number) => void;
  pulls: SectionPulls;
}

export function DocumentRail(props: DocumentRailProps) {
  const { sections, pulls } = props;
  const { can, ready } = useCapabilities();
  const mayPull = ready && can('ManageKnowledge') && props.sourceConfigured;

  const [expanded, setExpanded] = useState<string[] | null>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem('assessment.documentRail.expanded') ?? 'null');
      return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : null;
    } catch { return null; }
  });
  // Every source open until the reader folds one.
  const open = expanded ?? sections.map(section => sectionFolderId(section.key));
  const toggle = (id: string, isOpen: boolean) => {
    const next = isOpen ? [...new Set([...open, id])] : open.filter(value => value !== id);
    setExpanded(next);
    try { localStorage.setItem('assessment.documentRail.expanded', JSON.stringify(next)); } catch { /* A device preference only. */ }
  };

  const sectionOf = useMemo(() => {
    const byNode = new Map<string, KnowledgeSection>();
    for (const section of sections) {
      byNode.set(sectionFolderId(section.key), section);
      byNode.set(ACTIVITY_ID(section.key), section);
      for (const node of section.nodes) byNode.set(node.id, section);
    }
    return (id: string) => byNode.get(id);
  }, [sections]);

  const nodes: TreeNode[] = useMemo(() => sections.flatMap(section => {
    const folderId = sectionFolderId(section.key);
    const synced = section.kind === 'synced';
    const rows: TreeNode[] = [{
      id: folderId, title: section.title, parentId: null, isDir: true, icon: <FolderIcon size={16} />,
      meta: String(sectionDocumentCount(section)),
      ...(synced ? { hoverMeta: section.last_pulled_at ? `pulled ${compactAge(section.last_pulled_at)}` : 'never pulled' } : {}),
      // TreeView draws `pending` translucent and aria-busy — a source mid-pull.
      ...(pulls.pulls[section.key]?.pulling ? { status: 'pending' as const } : {}),
    }];
    for (const node of section.nodes) rows.push({
      id: node.id, title: node.title, parentId: node.parent_id ?? folderId, isDir: node.is_dir, icon: leafIcon(node),
      ...(!isFolderNode(node) && node.updated_at ? { meta: compactAge(node.updated_at) } : {}),
      // The host owns both edges of a move's window; the library cannot know when the server answered.
      ...(props.moveStatus[node.id] ? { status: props.moveStatus[node.id] } : {}),
    });
    if (synced) rows.push({ id: ACTIVITY_ID(section.key), title: 'Activity', parentId: folderId, icon: <ActivityIcon size={16} />, meta: String(props.activityCount(section)) });
    return rows;
  }), [sections, pulls.pulls, props.moveStatus, props.activityCount]);

  const movable = (section: KnowledgeSection | undefined) => !!section && !!props.onReorder && (section.kind === 'local' || props.sourceConfigured);
  const canDragNode = (node: TreeNode) => {
    const section = sectionOf(node.id);
    if (!movable(section) || sectionKeyOfFolder(node.id) || node.id.endsWith('::activity')) return false;
    // A synced source's root pages are the source's own; they stay put.
    return section!.kind !== 'synced' || node.parentId !== sectionFolderId(section!.key);
  };
  const canDropNode = (dragged: TreeNode, target: TreeNode, position: TreeDropPosition) => {
    const section = sectionOf(target.id);
    if (!section || section !== sectionOf(dragged.id) || target.id.endsWith('::activity')) return false;
    const root = sectionFolderId(section.key);
    if (target.id === root) return position === 'into' && section.kind === 'local';
    return section.kind === 'synced'
      ? position === 'into' || target.parentId !== root
      : position !== 'into' || !!target.isDir;
  };

  const rowMenu = (row: TreeNode): DropdownMenuSection[] | null => {
    const section = sectionOf(row.id);
    if (!section || row.id.endsWith('::activity')) return null;
    if (sectionKeyOfFolder(row.id)) {
      const items = [
        ...(props.onCreate && section.kind === 'local' ? [{ label: 'New page', description: `A blank draft in ${section.title}`, onSelect: () => props.onCreate!({ sectionKey: section.key }) }] : []),
        ...(mayPull && section.kind === 'synced' ? [{ label: 'Pull now', description: section.last_pulled_at ? `Pulled ${relativeTime(section.last_pulled_at)}` : 'Never pulled', onSelect: () => void pulls.pull(section.key) }] : []),
      ];
      return items.length ? [{ items }] : null;
    }
    const node = section.nodes.find(candidate => candidate.id === row.id);
    if (!node) return null;
    const childDraft = props.onCreate && (section.kind === 'synced' ? props.sourceConfigured : node.is_dir);
    return [
      { items: [{ label: 'Open', onSelect: () => props.onOpenDocument(node.id) }] },
      { items: [
        ...(section.kind === 'local' && props.onRename ? [{ label: 'Rename…', onSelect: () => props.onRename!({ id: node.id, title: node.title }) }] : []),
        ...(childDraft ? [{ label: 'Add child draft…', onSelect: () => props.onCreate!(section.kind === 'synced'
          ? { sectionKey: 'workspace_drafts', sourceParentId: node.id, parentTitle: node.title }
          : { sectionKey: section.key, parentId: node.id, parentTitle: node.title }) }] : []),
      ] },
    ].filter(group => group.items.length > 0);
  };

  const select = (id: string) => {
    if (sectionKeyOfFolder(id)) return; // A source folder opens and closes; it has no page of its own.
    const activity = sections.find(section => id === ACTIVITY_ID(section.key));
    if (activity) props.onOpenActivity(activity.key);
    else props.onOpenDocument(id);
  };
  const selected = props.activitySectionKey ? ACTIVITY_ID(props.activitySectionKey) : props.libraryOpen ? null : props.selectedId;

  const views = [{ id: VIEW_ALL, label: 'All documents' }, { id: VIEW_RECENT, label: 'Recent' }, { id: VIEW_SHARED, label: 'Shared with me' }];
  const activeView = props.quickView === 'recent' ? VIEW_RECENT : props.quickView === 'shared' ? VIEW_SHARED : props.libraryOpen ? VIEW_ALL : null;
  const onView = (id: string) => {
    if (id === VIEW_ALL) { props.onQuickView(null); props.onOpenLibrary(); return; }
    const next: QuickView = id === VIEW_RECENT ? 'recent' : 'shared';
    props.onQuickView(props.quickView === next ? null : next);
  };
  const recent = useMemo(() => recentDocuments(sections).map((node): TreeNode => ({
    id: node.id, title: node.title, parentId: null, icon: leafIcon(node), ...(node.updated_at ? { meta: compactAge(node.updated_at) } : {}),
  })), [sections]);

  const failures = sections.flatMap((section): Array<{ key: string; variant: 'error' | 'warning'; text: string }> => {
    const pull = pulls.pulls[section.key];
    if (pull?.error) return [{ key: section.key, variant: 'error' as const, text: `${section.title}: ${pull.error}` }];
    if (pull?.silent) return [{ key: section.key, variant: 'warning' as const, text: `${section.title}: the pull was accepted, but no result came back — the tree may not have changed.` }];
    return [];
  });

  return <>
    {failures.map(failure => <Stack key={failure.key} gap="none" className="px-3.5 pt-3">
      <Banner variant={failure.variant} onDismiss={() => pulls.dismiss(failure.key)} data-testid={`section-pull-notice-${failure.key}`}>{failure.text}</Banner>
    </Stack>)}
    <Stack gap="none" className="px-3.5 pb-2">
      <ConversationShelf compact plain size="rail" items={views} activeId={activeView} onSelect={onView} data-testid="document-rail-views" />
    </Stack>
    {props.quickView ? <Stack gap="xs" className="px-2 pb-3">
      <RailSectionHeader label={props.quickView === 'recent' ? 'Recent' : 'Shared with me'} presentational={false} />
      {props.quickView === 'shared'
        ? <InlinePlaceholder data-testid="document-rail-shared-empty">Assessment documents are shared by role and by source space, not person to person — nothing is shared with you alone.</InlinePlaceholder>
        : recent.length === 0
          ? <InlinePlaceholder>Nothing has changed yet.</InlinePlaceholder>
          : <KeyboardTreeView size="rail" data-testid="document-rail-recent" nodes={recent} selectedId={selected} onSelect={props.onOpenDocument} rowMenu={rowMenu} />}
    </Stack> : <Stack gap="xs" className="px-2 pb-3">
      <RailSectionHeader label="Sources" presentational={false} />
      {sections.length === 0 ? <InlinePlaceholder>Nothing here yet.</InlinePlaceholder> : <KeyboardTreeView size="rail" data-testid="document-rail-tree"
        nodes={nodes} selectedId={selected} expanded={open} onToggle={toggle} onSelect={select} rowMenu={rowMenu}
        rowMenuLabel={row => sectionKeyOfFolder(row.id) ? `Actions for the ${row.title} source` : `Actions for ${row.title}`}
        {...(props.onReorder ? { onReorder: props.onReorder, canDragNode, canDropNode } : {})}
        renderTrailing={row => {
          const key = sectionKeyOfFolder(row.id);
          const section = key ? sectionOf(row.id) : undefined;
          if (!section) return null;
          return <>
            <SectionPresence sectionKey={section.key} join={!!selected && section.nodes.some(n => n.id === selected)} />
            {mayPull && section.kind === 'synced' && <SectionPullControl section={section} pulls={pulls} />}
          </>;
        }}
        {...(props.onRename ? { onRenameNode: (id: string) => {
          const section = sectionOf(id);
          const node = section?.kind === 'local' ? section.nodes.find(candidate => candidate.id === id) : undefined;
          if (node) props.onRename!({ id: node.id, title: node.title });
        } } : {})} />}
    </Stack>}
  </>;
}

export default DocumentRail;
