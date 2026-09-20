import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ExplorerLayout, ContextColumn, ViewportFillRegion, type ContextColumnState } from '@connorhoehnslalom/ui-components';
import { Stack } from '@connorhoehnslalom/ui-components/shared';

type PanelId = 'outline' | 'comments' | 'activity';
const DocumentContext = createContext<{ open: (id: PanelId) => void; active: PanelId; host: HTMLElement | null } | null>(null);
export const useDocumentContext = () => useContext(DocumentContext);

/** The examples' dock pattern keeps document state in its owner while the library owns the column. */
export function DocumentContextPanel({ id, children }: { id: PanelId; children: ReactNode }) {
  const context = useDocumentContext();
  return context?.active === id && context.host ? createPortal(children, context.host) : null;
}

export interface ExplorerFrameProps {
  rail: ReactNode;
  railHeader?: ReactNode;
  railActions?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  title?: string;
}

export function ExplorerFrame({ rail, railHeader, railActions, children, aside, title = 'Documents' }: ExplorerFrameProps) {
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
  const [state, setState] = useState<ContextColumnState>('open');
  const [active, setActive] = useState<PanelId>('outline');
  const [host, setHost] = useState<HTMLElement | null>(null);
  const open = useCallback((id: PanelId) => { setActive(id); setState('open'); }, []);
  const context = useMemo(() => ({ open, active, host: state === 'collapsed' ? null : host }), [open, active, host, state]);
  const dock = <Stack ref={setHost} gap="sm" className="min-h-0 flex-1 p-4" />;
  return (
    <DocumentContext.Provider value={aside ? context : null}>
      <ViewportFillRegion bottomGap={16} data-testid="knowledge-workspace">
        <ExplorerLayout
          rail={rail}
          railTitle={title}
          railHeader={railHeader}
          railActions={railActions}
          railLabel="document library"
          railWidth="md"
          railCollapsed={collapsed}
          onToggleRail={toggleRail}
          panePadding="none"
          aside={aside ? <ContextColumn state={state} onStateChange={setState}
            label="Document context" activeId={active} onActivate={(id) => open(id as PanelId)}
            panels={[
              { id: 'outline', label: 'Outline', icon: '☷', content: dock },
              { id: 'comments', label: 'Comments', icon: '☰', content: dock },
              { id: 'activity', label: 'Activity', icon: '◷', content: aside },
            ]} /> : undefined}
          data-testid="knowledge-explorer"
        >
          {children}
        </ExplorerLayout>
      </ViewportFillRegion>
    </DocumentContext.Provider>
  );
}

export default ExplorerFrame;
