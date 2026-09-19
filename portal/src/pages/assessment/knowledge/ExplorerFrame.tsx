import { useState, type ReactNode } from 'react';
import { ExplorerLayout, ContextColumn, type ContextColumnState } from '@connorhoehnslalom/ui-components';

export interface ExplorerFrameProps {
  rail: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  title?: string;
}

/** Library-owned layout: both navigation and context can yield space to the document. */
export function ExplorerFrame({ rail, children, aside, title = 'Documents' }: ExplorerFrameProps) {
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
  const [context, setContext] = useState<ContextColumnState>('collapsed');
  return (
    <ExplorerLayout
      rail={rail}
      railTitle={title}
      railLabel="document library"
      railWidth="sm"
      railCollapsed={collapsed}
      onToggleRail={toggleRail}
      panePadding="md"
      aside={aside ? <ContextColumn state={context} onStateChange={setContext}
        label="Document activity" activeId="activity" onActivate={() => setContext('open')}
        panels={[{ id: 'activity', label: 'Activity', icon: '◷', content: aside }]} /> : undefined}
      data-testid="knowledge-explorer"
    >
      {children}
    </ExplorerLayout>
  );
}

export default ExplorerFrame;
