import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ContextColumn, SplitPane, WorkspaceRail, type ContextColumnState } from '@connorhoehn/ui-components';
import { ChatIcon, Inline, Stack, useRailFold } from '@connorhoehn/ui-components/shared';

// Comments, Versions and Reviews are editor tabs (DocumentShell); the column
// keeps what belongs beside the page rather than instead of it: the outline,
// the page's conversation (the composer dock posts into it) and its activity.
export type PanelId = 'outline' | 'chat' | 'activity';
const DocumentContext = createContext<{ open: (id: PanelId) => void; collapse(): void; active: PanelId; host: HTMLElement | null } | null>(null);
export const useDocumentContext = () => useContext(DocumentContext);

/** The examples' dock pattern keeps document state in its owner while the library owns the column. */
export function DocumentContextPanel({ id, children }: { id: PanelId; children: ReactNode }) {
  const context = useDocumentContext();
  return context?.active === id && context.host ? createPortal(children, context.host) : null;
}

export interface ExplorerFrameProps {
  /**
   * The rail. It draws its own caption (the concise stacked rail's
   * "DOCUMENTS n" row, docs/rail-parity-goal.md), so the fold control is
   * handed to it to sit with the caption's other actions.
   */
  rail: (controls: { foldRail: () => void }) => ReactNode;
  /**
   * The row over the pane — the trail (shell groups + this explorer's crumbs)
   * as a `ScopeHeader variant="crumbs"`, the way the Org explorers print it
   * (2026-09-29: the shell's own breadcrumb row and its 24px content ring are
   * off for this page via `data-shell-flush`, so the rail sits flush against
   * the shell rail at full height, like /iq/library).
   */
  paneHeader?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}

export function ExplorerFrame({ rail, children, aside, paneHeader }: ExplorerFrameProps) {
  // Remembered per depth band (the library rail model, `useRailFold`): a fold
  // set on a shallow page never folds this rail three levels down.
  const { folded: collapsed, toggle: toggleRail } = useRailFold({ storageKey: 'assessment.documentRail.collapsed' });
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState(1000);
  const [railWidth, setRailWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('assessment.documentRail.width'));
      // 220 is the app's concise rail width (/iq/library is the reference the rail judge compares against).
      return Number.isFinite(stored) && stored >= 220 && stored <= 480 ? stored : 220;
    } catch { return 220; }
  });
  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const measure = () => setFrameWidth(Math.max(1, element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const visibleWidth = collapsed ? 36 : Math.min(railWidth, Math.max(180, frameWidth - 360));
  const resizeRail = (ratio: number) => {
    if (collapsed) return;
    const next = Math.min(480, Math.max(220, Math.round(ratio * frameWidth)));
    setRailWidth(next);
    try { localStorage.setItem('assessment.documentRail.width', String(next)); } catch { /* Device preference only. */ }
  };
  const [state, setState] = useState<ContextColumnState>('collapsed');
  const [active, setActive] = useState<PanelId>('outline');
  const [host, setHost] = useState<HTMLElement | null>(null);
  const open = useCallback((id: PanelId) => { setActive(id); setState('open'); }, []);
  const collapse = useCallback(() => setState('collapsed'), []);
  const context = useMemo(() => ({ open, collapse, active, host: state === 'collapsed' ? null : host }), [open, collapse, active, host, state]);
  const dock = <Stack ref={setHost} gap="sm" className="min-h-0 flex-1 p-4" />;
  return (
    <DocumentContext.Provider value={aside ? context : null}>
      <Stack ref={frameRef} gap="none" className="h-full min-h-0 min-w-0 bg-surface" data-shell-flush data-testid="knowledge-workspace" data-rail-collapsed={collapsed}>
        <SplitPane
          primary={<WorkspaceRail label="Document library" className="w-full border-r-0" collapsed={collapsed}
            {...(collapsed ? { onToggle: toggleRail, toggleLabel: 'Show document library' } : {})}
            data-testid="knowledge-explorer-rail">{rail({ foldRail: toggleRail })}</WorkspaceRail>}
          ratio={visibleWidth / frameWidth}
          onRatioChange={resizeRail}
          minPrimaryPx={collapsed ? 36 : Math.min(220, frameWidth * 0.4)}
          minSecondaryPx={Math.min(360, frameWidth * 0.6)}
          dividerLabel="Resize document sidebar"
          onDividerActivate={toggleRail}
          className="flex-1"
          data-testid="knowledge-explorer"
          secondary={<Inline gap="none" align="stretch" wrap={false} className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
          {/* The context strip is a rail beside the content column, so the composer's
              boundary (the pane column) excludes it instead of hiding a 48px gap. */}
          <Stack gap="none" className="h-full min-h-0 min-w-0 flex-1" data-testid="knowledge-explorer-pane-column">
          {paneHeader && <Stack gap="none" className="shrink-0 bg-surface" data-testid="knowledge-explorer-pane-header">{paneHeader}</Stack>}
            <Stack gap="none" className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="knowledge-explorer-pane">{children}</Stack>
          </Stack>
            {aside ? <ContextColumn state={state} onStateChange={setState}
            label="Document context" activeId={active} onActivate={(id) => open(id as PanelId)}
            panels={[
              { id: 'outline', label: 'Outline', icon: '☷', content: dock },
              { id: 'chat', label: 'Chat', icon: <ChatIcon size={16} />, content: dock },
              { id: 'activity', label: 'Activity', icon: '◷', content: aside },
            ]} /> : null}
          </Inline>}
        />
      </Stack>
    </DocumentContext.Provider>
  );
}

export default ExplorerFrame;
