import type { ReactNode } from 'react';
import { Button, IconButton, Inline, RepeatIcon, SearchIcon, Tooltip } from '@connorhoehn/ui-components/shared';
import { FileViewToggle, type FileView } from './FileCards';

/** Shared file chrome only; readers, filters and navigation remain with each host. */
export function FileRefreshAction({ onRefresh, refreshing = false, label = 'Refresh files' }: {
  onRefresh(): void;
  refreshing?: boolean;
  label?: string;
}) {
  return <Tooltip content={refreshing ? 'Refreshing…' : label} placement="bottom">
    <IconButton size="md" variant="ghost" aria-label={label} aria-busy={refreshing} disabled={refreshing}
      className="text-xs text-text-secondary" icon={<RepeatIcon size={16} className={refreshing ? 'animate-spin' : undefined} />}
      onClick={onRefresh} />
  </Tooltip>;
}

export function FileToolbar({ children, view, onViewChange, onRefresh, refreshing, onOpenWorkspace, label = 'File controls', testId }: {
  children: ReactNode;
  view: FileView;
  onViewChange(view: FileView): void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onOpenWorkspace?: () => void;
  label?: string;
  testId?: string;
}) {
  // Each field keeps its editing keys; the native radio control owns view arrows.
  // The host's controls keep 12rem (a search box's working width): on a narrow
  // pane the view switch and refresh wrap under them instead of squeezing them.
  return <Inline gap="sm" align="center" justify="between" wrap role="group" aria-label={label} data-testid={testId}
    className="min-w-0 rounded-lg border border-border bg-surface-panel px-2 py-1.5">
    <Inline gap="sm" align="center" wrap className="min-w-48 flex-1">{children}</Inline>
    <Inline gap="xs" align="center" wrap={false} className="shrink-0">
      <FileViewToggle value={view} onChange={onViewChange} />
      {onRefresh && <FileRefreshAction onRefresh={onRefresh} refreshing={refreshing} />}
      {onOpenWorkspace && <Tooltip content="Search across this initiative" placement="bottom">
        <Button size="sm" variant="ghost" onClick={onOpenWorkspace}
          className="text-xs text-text-secondary"><SearchIcon size={16} />Search initiative</Button>
      </Tooltip>}
    </Inline>
  </Inline>;
}
