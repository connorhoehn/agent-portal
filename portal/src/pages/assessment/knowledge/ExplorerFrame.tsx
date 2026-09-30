import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ExplorerLayout, ContextColumn, type ContextColumnState } from '@connorhoehnslalom/ui-components';
import { ChatIcon, Inline, Stack } from '@connorhoehnslalom/ui-components/shared';

// Comments, Versions and Reviews are editor tabs (DocumentShell); the column
// keeps what belongs beside the page rather than instead of it: the outline,
// the page's conversation (the composer dock posts into it) and its activity.
export type PanelId = 'outline' | 'chat' | 'activity';
const DocumentContext = createContext<{ open: (id: PanelId) => void; active: PanelId; host: HTMLElement | null } | null>(null);
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
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('assessment.documentRail.collapsed') === 'true'; }
    catch { return false; }
  });
  function toggleRail() {
    setCollapsed((value) => {
      try { localStorage.setItem('assessment.documentRail.collapsed', String(!value)); } catch { /* Session-only preference. */ }
      return !value;
    });
  }
  const [state, setState] = useState<ContextColumnState>('collapsed');
  const [active, setActive] = useState<PanelId>('outline');
  const [host, setHost] = useState<HTMLElement | null>(null);
  const open = useCallback((id: PanelId) => { setActive(id); setState('open'); }, []);
  const context = useMemo(() => ({ open, active, host: state === 'collapsed' ? null : host }), [open, active, host, state]);
  const dock = <Stack ref={setHost} gap="sm" className="min-h-0 flex-1 p-4" />;
  return (
    <DocumentContext.Provider value={aside ? context : null}>
      <Stack gap="none" className="h-full min-h-0 min-w-0 bg-surface" data-shell-flush data-testid="knowledge-workspace">
        <ExplorerLayout
          rail={rail({ foldRail: toggleRail })}
          railLabel="document library"
          // 220px — the Org rail's width (`xs`, ui-components 2.407.33).
          railWidth="xs"
          railCollapsed={collapsed}
          // Open, the fold is one of the caption's actions; folded, the strip's unfold control.
          {...(collapsed ? { onToggleRail: toggleRail } : {})}
          panePadding="none"
          {...(paneHeader ? { paneHeader } : {})}
          data-testid="knowledge-explorer"
        >
          <Inline gap="none" align="stretch" wrap={false} className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <Stack gap="none" className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</Stack>
            {aside ? <ContextColumn state={state} onStateChange={setState}
            label="Document context" activeId={active} onActivate={(id) => open(id as PanelId)}
            panels={[
              { id: 'outline', label: 'Outline', icon: '☷', content: dock },
              { id: 'chat', label: 'Chat', icon: <ChatIcon size={16} />, content: dock },
              { id: 'activity', label: 'Activity', icon: '◷', content: aside },
            ]} /> : null}
          </Inline>
        </ExplorerLayout>
      </Stack>
    </DocumentContext.Provider>
  );
}

export default ExplorerFrame;
