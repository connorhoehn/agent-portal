// The document frame shared with realtime-examples' /documents editor: the
// library EditorShell (title row, head actions, Editor / Comments / Versions /
// History tabs, surface). Assessment adds Reviews as a fifth tab. Every state
// of the pane — connecting, the live canvas and the reader fallback — renders
// through this one frame, so the chrome never changes shape under the reader.
import type { ReactNode } from 'react';
import { EditorShell, type DocumentSaveState, type EditorShellProps, type EditorShellTab } from '@connorhoehn/ui-components/doc-editor';
import type { BreadcrumbItem } from '@connorhoehn/ui-components/shared';
import { Stack } from '@connorhoehn/ui-components/shared';

export const DOCUMENT_TABS = ['editor', 'comments', 'versions', 'history', 'reviews', 'recordings'] as const;
export type DocumentTab = (typeof DOCUMENT_TABS)[number];
const TAB_LABEL: Record<DocumentTab, string> = { editor: 'Editor', comments: 'Comments', versions: 'Versions', history: 'History', reviews: 'Reviews', recordings: 'Recordings' };

export interface DocumentShellProps {
  title: string;
  /** Where the page lives — "Documents / SDLC Assessment Program", each segment clickable. */
  path: BreadcrumbItem[];
  tab: DocumentTab;
  onTab: (tab: DocumentTab) => void;
  commentCount: number;
  statusPill?: ReactNode;
  saveState?: DocumentSaveState;
  /** The shared DocumentHeader as `variant="actions"`. */
  headActions: ReactNode;
  editor: ReactNode;
  comments: ReactNode;
  history: ReactNode;
  /** Absent while the collaborative workspace is unavailable: the tab is shown disabled. */
  versions?: ReactNode;
  reviews?: ReactNode;
  /** Participant recordings from this exact source, independent of canvas availability. */
  recordings?: ReactNode;
  /** The composer dock — EditorShell's last row, on the Editor tab only (the Comments tab has its own reply field). */
  composer?: ReactNode;
  /** An agent's pending edits (a `ProposedEditStrip`) — EditorShell's `proposal` row, between the page and the dock, on the Editor tab only. */
  proposal?: ReactNode;
  /** Who else is on the page (canvas awareness), in the byline — with jump-to and follow. */
  participants?: EditorShellProps['participants'];
  onParticipantClick?: (id: string) => void;
  onFollowParticipant?: (id: string) => void;
  followingParticipantId?: string | null;
}

export function DocumentShell({ title, path, tab, onTab, commentCount, statusPill, saveState, headActions, editor, comments, history, versions, reviews, recordings, composer, proposal, participants, onParticipantClick, onFollowParticipant, followingParticipantId }: DocumentShellProps) {
  const panels: Record<DocumentTab, ReactNode | undefined> = { editor, comments, versions, history, reviews, recordings };
  const tabs: EditorShellTab[] = DOCUMENT_TABS.map(id => ({
    id, label: TAB_LABEL[id],
    ...(id === 'comments' ? { count: commentCount } : {}),
    ...(panels[id] === undefined ? { disabled: true } : {}),
  }));
  const active: DocumentTab = panels[tab] === undefined ? 'editor' : tab;
  return <EditorShell title={title} kind="page" path={path} label="Document editor" headerInset="page"
    {...(statusPill ? { statusPill } : {})} {...(saveState ? { saveState } : {})}
    headActions={headActions} tabs={tabs} activeTab={active}
    {...(participants?.length ? { participants } : {})}
    {...(onParticipantClick ? { onParticipantClick } : {})}
    {...(onFollowParticipant ? { onFollowParticipant, followingParticipantId: followingParticipantId ?? null } : {})}
    {...(composer && active === 'editor' ? { footer: composer } : {})}
    {...(proposal && active === 'editor' ? { proposal } : {})}
    onTabChange={id => onTab((DOCUMENT_TABS as readonly string[]).includes(id) ? id as DocumentTab : 'editor')}
    surface={active === 'editor' ? 'workspace' : 'plain'} className="min-h-0 flex-1" data-testid="document-shell">
    {active === 'editor'
      ? <Stack gap="none" className="h-full min-h-0" data-testid="document-surface">{editor}</Stack>
      : <Stack gap="md" className={`mx-auto h-full min-h-0 w-full max-w-3xl p-4${active === 'recordings' ? ' overflow-y-auto' : ''}`} data-testid={`document-tab-${active}`}>{panels[active]}</Stack>}
  </EditorShell>;
}
