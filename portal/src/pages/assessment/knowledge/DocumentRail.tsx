// The documents rail — the concise stacked rail the Org tenant's second
// columns draw (docs/rail-parity-goal.md): an 11px "DOCUMENTS n" caption with
// its actions, a Views group, then one collapsible group per source whose
// pages nest beneath it on the rail pitch, the current row tinted, no icons,
// no card. `StackedRail` owns the look and the arrow-key navigation; this file
// owns what the rows mean: which view is current, a source's Pull / New page,
// its presence, the page menus, and what a drag and a drop do.

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import {
  Banner,
  DropdownMenu,
  MoreIcon,
  PlusIcon,
  PresenceAvatars,
  RepeatIcon,
  Stack,
  StackedRail,
  type DropdownMenuSection,
  type StackedRailGroup,
  type StackedRailRow,
} from '@connorhoehnslalom/ui-components/shared';
import { usePresence } from '@connorhoehnslalom/realtime-modules/client';
import { relativeTime } from '../../../lib/relativeTime';
import { useCapabilities } from '../../../lib/capabilities';
import { sendJson } from '../../../lib/writeJson';
import type { DraftDestination } from './NewDraftDialog';
import {
  channelForSection,
  compactAge,
  isFolderNode,
  nodePath,
  presenceAvatarUsers,
  pulledEventsForSection,
  railDropPosition,
  railReorderTarget,
  recentDocuments,
  sectionDocumentCount,
  sectionFolderId,
  sectionKeyOfFolder,
  type RailDragNode,
  type RailDropPosition,
} from './knowledgeFormat';
import type { AssessmentSSEEvent, KnowledgeNode, KnowledgeSection } from './types';

export type QuickView = 'recent' | 'shared';
export const ACTIVITY_ID = (sectionKey: string) => `${sectionKey}::activity`;
const VIEW_ALL = 'view:all';
const VIEW_RECENT = 'view:recent';
const VIEW_SHARED = 'view:shared';
/** The rail's testid; rows are `${RAIL}-row-<id>` — the ids the e2e and journey walks anchor on. */
const RAIL = 'document-rail-tree';
const rowTestId = (id: string) => `${RAIL}-row-${id}`;

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

/**
 * Who else has this source open — the rail's per-source presence. The viewer
 * joins only the section that holds the document they have open (`join`), so
 * the roster means "has this source open", not "has the rail on screen";
 * without any join the avatars never rendered (re-audit #7, 2026-09-29).
 */
function SectionPresence({ sectionKey, join }: { sectionKey: string; join: boolean }) {
  const { roster } = usePresence(channelForSection(sectionKey), { join });
  if (roster.length === 0) return null;
  return <PresenceAvatars size={20} maxVisible={3} users={presenceAvatarUsers(roster)} />;
}

// ─── The rail ─────────────────────────────────────────────────────────────

export interface DocumentRailProps {
  /** The caption ("DOCUMENTS 12") and its 28px actions: New page, ⋯, fold. */
  title: string;
  count: number;
  actions?: ReactNode;
  /** Loading / error in place of the groups; the caption stays. */
  status?: ReactNode;
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

/** The drop indicator, drawn from the `data-drop` the host sets on the target row or source heading. */
const DROP_INDICATOR = '[&_[data-drop=before]]:shadow-[inset_0_2px_0_0_var(--color-primary)] [&_[data-drop=after]]:shadow-[inset_0_-2px_0_0_var(--color-primary)] [&_[data-drop=into]]:ring-1 [&_[data-drop=into]]:ring-inset [&_[data-drop=into]]:ring-primary';

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
  // Every source open until the reader folds one; nested folders closed.
  const open = expanded ?? sections.map(section => sectionFolderId(section.key));
  const store = (next: string[]) => {
    setExpanded(next);
    try { localStorage.setItem('assessment.documentRail.expanded', JSON.stringify(next)); } catch { /* A device preference only. */ }
  };
  const toggle = (id: string, isOpen: boolean) => store(isOpen ? [...new Set([...open, id])] : open.filter(value => value !== id));
  const toggleMany = (ids: string[]) => store([...new Set([...open, ...ids])]);

  const sectionOf = useMemo(() => {
    const byNode = new Map<string, KnowledgeSection>();
    for (const section of sections) {
      byNode.set(sectionFolderId(section.key), section);
      byNode.set(ACTIVITY_ID(section.key), section);
      for (const node of section.nodes) byNode.set(node.id, section);
    }
    return (id: string) => byNode.get(id);
  }, [sections]);

  // The drag model: every page with its rail parent (a root page's parent is
  // its source's folder id, which moveParentForRail maps back to null).
  const dragNodes: RailDragNode[] = useMemo(() => sections.flatMap(section => {
    const folderId = sectionFolderId(section.key);
    return [
      { id: folderId, parentId: null, isDir: true },
      ...section.nodes.map(node => ({ id: node.id, parentId: node.parent_id ?? folderId, isDir: node.is_dir })),
    ];
  }), [sections]);
  const dragNode = (id: string) => dragNodes.find(node => node.id === id);

  const movable = (section: KnowledgeSection | undefined) => !!section && !!props.onReorder && (section.kind === 'local' || props.sourceConfigured);
  const canDragNode = (node: RailDragNode) => {
    const section = sectionOf(node.id);
    if (!movable(section) || sectionKeyOfFolder(node.id) || node.id.endsWith('::activity') || props.moveStatus[node.id] === 'pending') return false;
    // A synced source's root pages are the source's own; they stay put.
    return section!.kind !== 'synced' || node.parentId !== sectionFolderId(section!.key);
  };
  const canDropNode = (dragged: RailDragNode, target: RailDragNode, position: RailDropPosition) => {
    const section = sectionOf(target.id);
    if (!section || section !== sectionOf(dragged.id) || target.id.endsWith('::activity')) return false;
    const root = sectionFolderId(section.key);
    if (target.id === root) return position === 'into' && section.kind === 'local';
    return section.kind === 'synced'
      ? position === 'into' || target.parentId !== root
      : position !== 'into' || !!target.isDir;
  };

  const dragging = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; position: RailDropPosition } | null>(null);
  const dropAt = (targetId: string, position: RailDropPosition) => {
    const dragged = dragging.current ? dragNode(dragging.current) : undefined;
    const target = dragNode(targetId);
    if (!dragged || !target || props.moveStatus[targetId] === 'pending' || !canDragNode(dragged) || !canDropNode(dragged, target, position)) return null;
    return railReorderTarget(dragNodes, dragged.id, targetId, position);
  };
  /** Drag handlers for a page row, or (`headingOnly`) a source heading, which only takes `into`. */
  const dragProps = (id: string, headingOnly = false) => {
    if (!props.onReorder) return {};
    const node = dragNode(id);
    const draggable = !headingOnly && !!node && canDragNode(node);
    const over = (event: DragEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const position = headingOnly ? 'into' : railDropPosition(event.clientY - rect.top, rect.height);
      if (!dropAt(id, position)) { if (drop?.id === id) setDrop(null); return; }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (drop?.id !== id || drop.position !== position) setDrop({ id, position });
    };
    return {
      ...(draggable ? {
        draggable: true,
        onDragStart: (event: DragEvent<HTMLElement>) => { event.dataTransfer.setData('text/plain', id); event.dataTransfer.effectAllowed = 'move'; dragging.current = id; },
        onDragEnd: () => { dragging.current = null; setDrop(null); },
      } : {}),
      onDragOver: over,
      onDragEnter: over,
      onDragLeave: () => { if (drop?.id === id) setDrop(null); },
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        const target = drop?.id === id ? dropAt(id, drop.position) : null;
        const dragged = dragging.current;
        dragging.current = null;
        setDrop(null);
        if (target && dragged) props.onReorder!(dragged, target.parentId, target.position);
      },
      data: { 'data-drop': drop?.id === id ? drop.position : undefined, 'data-draggable': draggable || undefined },
    };
  };

  const selected = props.activitySectionKey ? ACTIVITY_ID(props.activitySectionKey) : props.libraryOpen ? null : props.selectedId;
  // The open page is always in view: its source and ancestor pages open when
  // it is selected (a deep link, a pick from Recent), as TreeView revealed it.
  useEffect(() => {
    const section = selected ? sectionOf(selected) : undefined;
    if (!section || !selected) return;
    const ancestors = nodePath(section.nodes, selected).slice(0, -1).map(node => node.id);
    const needed = [sectionFolderId(section.key), ...ancestors].filter(id => !open.includes(id));
    if (needed.length) toggleMany(needed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, sectionOf]);

  const pageMenu = (node: KnowledgeNode, section: KnowledgeSection): DropdownMenuSection[] => {
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
  const menuFor = (node: KnowledgeNode, section: KnowledgeSection) => <DropdownMenu trigger={<MoreIcon size={14} />}
    triggerLabel={`Actions for ${node.title}`} triggerTestId={`${rowTestId(node.id)}-menu-trigger`} triggerClassName="h-6 w-7 border-transparent"
    align="end" sections={pageMenu(node, section)} data-testid={`${rowTestId(node.id)}-menu-panel`} />;

  const pageRow = (node: KnowledgeNode, section: KnowledgeSection, byParent: Map<string | null, KnowledgeNode[]>): StackedRailRow => {
    const children = (byParent.get(node.id) ?? []).map(child => pageRow(child, section, byParent));
    const isOpen = open.includes(node.id);
    return {
      id: node.id, label: node.title,
      ...(!isFolderNode(node) && node.updated_at ? { meta: compactAge(node.updated_at) } : {}),
      onSelect: () => { props.onOpenDocument(node.id); if (children.length && !isOpen) toggle(node.id, true); },
      ...(children.length ? { children, open: isOpen, onToggle: (next: boolean) => toggle(node.id, next) } : {}),
      // The host owns both edges of a move's window; the library cannot know when the server answered.
      ...(props.moveStatus[node.id] === 'pending' ? { pending: true } : {}),
      menu: menuFor(node, section),
      ...dragProps(node.id),
    };
  };

  const sourceGroup = (section: KnowledgeSection): StackedRailGroup => {
    const folderId = sectionFolderId(section.key);
    const synced = section.kind === 'synced';
    const pulling = !!pulls.pulls[section.key]?.pulling;
    const byParent = new Map<string | null, KnowledgeNode[]>();
    for (const node of section.nodes) byParent.set(node.parent_id, [...(byParent.get(node.parent_id) ?? []), node]);
    const pulled = section.last_pulled_at ? `pulled ${relativeTime(section.last_pulled_at)}` : 'never pulled';
    return {
      id: section.key, title: section.title, count: sectionDocumentCount(section),
      open: open.includes(folderId), onToggle: (next: boolean) => toggle(folderId, next),
      // The ids the walks anchor on stay those of the old folder row.
      testId: rowTestId(folderId),
      trailing: <SectionPresence sectionKey={section.key} join={!!selected && section.nodes.some(n => n.id === selected)} />,
      actions: [
        ...(mayPull && synced ? [{ label: pulling ? `Pulling ${section.title}…` : `Pull ${section.title} from ${section.provider ?? 'its source'} — ${pulled}`, icon: <RepeatIcon size={14} />, disabled: pulling,
          onClick: () => void pulls.pull(section.key), 'data-testid': `section-pull-${section.key}` }] : []),
        ...(props.onCreate && section.kind === 'local' ? [{ label: 'New page', icon: <PlusIcon size={14} />,
          onClick: () => props.onCreate!({ sectionKey: section.key }), 'data-testid': `section-new-page-${section.key}` }] : []),
      ],
      ...(pulling ? { pending: true } : {}),
      rows: [
        ...(byParent.get(null) ?? []).map(node => pageRow(node, section, byParent)),
        ...(synced ? [{ id: ACTIVITY_ID(section.key), label: 'Activity', meta: props.activityCount(section), onSelect: () => props.onOpenActivity(section.key) }] : []),
      ],
      ...dragProps(folderId, true),
    };
  };

  const activeView = props.quickView === 'recent' ? VIEW_RECENT : props.quickView === 'shared' ? VIEW_SHARED : props.libraryOpen ? VIEW_ALL : null;
  const onView = (id: string) => {
    if (id === VIEW_ALL) { props.onQuickView(null); props.onOpenLibrary(); return; }
    const next: QuickView = id === VIEW_RECENT ? 'recent' : 'shared';
    props.onQuickView(props.quickView === next ? null : next);
  };
  const views: StackedRailGroup = {
    id: 'views', title: 'Views', collapsible: false, testId: 'document-rail-views',
    rows: [{ id: VIEW_ALL, label: 'All documents', meta: props.count }, { id: VIEW_RECENT, label: 'Recent' }, { id: VIEW_SHARED, label: 'Shared with me' }]
      .map(view => ({ ...view, current: activeView === view.id, onSelect: () => onView(view.id) })),
  };
  const recent = useMemo(() => recentDocuments(sections), [sections]);
  const quickGroup = (view: QuickView): StackedRailGroup => view === 'shared'
    // Its empty line is `document-rail-shared-empty` (the group testid + `-empty`).
    ? { id: 'shared', title: 'Shared with me', collapsible: false, testId: 'document-rail-shared', rows: [],
        emptyLabel: 'Assessment documents are shared by role and by source space, not person to person — nothing is shared with you alone.' }
    : { id: 'recent', title: 'Recent', collapsible: false, testId: 'document-rail-recent', emptyLabel: 'Nothing has changed yet.',
        rows: recent.map(node => {
          const section = sectionOf(node.id);
          return { id: node.id, label: node.title, ...(node.updated_at ? { meta: compactAge(node.updated_at) } : {}), onSelect: () => props.onOpenDocument(node.id),
            ...(section ? { menu: menuFor(node, section) } : {}) };
        }) };

  const groups: StackedRailGroup[] = props.status ? [] : [
    views,
    ...(props.quickView ? [quickGroup(props.quickView)] : sections.map(sourceGroup)),
  ];

  // Keyboard and pointer extras the rows had under TreeView: Shift+F10 (or the
  // context-menu key) opens a page's ⋯, and a double-click renames a local page.
  const rowIdOf = (target: EventTarget) => {
    const key = (target as Element).closest?.('[data-rail-key^="r:"]')?.getAttribute('data-rail-key');
    return key ? key.slice(2) : null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu')) return;
    const id = rowIdOf(event.target);
    const trigger = id ? event.currentTarget.querySelector<HTMLButtonElement>(`[data-testid="${CSS.escape(`${rowTestId(id)}-menu`)}"] button[aria-haspopup="menu"]`) : null;
    if (!trigger) return;
    event.preventDefault();
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  };
  const onDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (!props.onRename || (event.target as Element).closest('[data-testid$="-caret"], [data-testid$="-menu"]')) return;
    const id = rowIdOf(event.target);
    const section = id ? sectionOf(id) : undefined;
    const node = section?.kind === 'local' ? section.nodes.find(candidate => candidate.id === id) : undefined;
    if (!node) return;
    window.getSelection?.()?.removeAllRanges();
    props.onRename({ id: node.id, title: node.title });
  };

  const failures = sections.flatMap((section): Array<{ key: string; variant: 'error' | 'warning'; text: string }> => {
    const pull = pulls.pulls[section.key];
    if (pull?.error) return [{ key: section.key, variant: 'error' as const, text: `${section.title}: ${pull.error}` }];
    if (pull?.silent) return [{ key: section.key, variant: 'warning' as const, text: `${section.title}: the pull was accepted, but no result came back — the tree may not have changed.` }];
    return [];
  });

  return <Stack gap="none" className="min-w-0 pb-3" onKeyDown={onKeyDown} onDoubleClick={onDoubleClick}>
    <StackedRail title={props.title} count={props.count} actions={props.actions} aria-label="Documents" currentStyle="tint"
      selectedId={selected} groups={groups} className={DROP_INDICATOR} data-testid={RAIL} />
    {props.status}
    {failures.map(failure => <Stack key={failure.key} gap="none" className="px-2.5 pt-2">
      <Banner variant={failure.variant} onDismiss={() => pulls.dismiss(failure.key)} data-testid={`section-pull-notice-${failure.key}`}>{failure.text}</Banner>
    </Stack>)}
  </Stack>;
}

export default DocumentRail;
