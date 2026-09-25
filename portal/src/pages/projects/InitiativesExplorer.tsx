// The Initiatives frame (F1–F2, F11): the explorer column on the left, one
// pane on the right with its own header band and a docked composer under it.
// Both /iq/projects and /iq/projects/:id mount this — the list route with the
// initiative list in the rail, the detail route with the initiative list on
// Overview and its Work list on the Work tab. The frame knows nothing about
// either; each route hands it rail slots (`ExplorerRailSlots`), a pane header,
// the pane body and a composer.
//
// It owns two things only: the viewport fill (the page is `data-shell-flush`,
// so the shell drops its padding ring and crumb row) and the rail's « fold,
// which is a device preference remembered across both routes.

import { useCallback, useState, type ReactNode } from 'react';
import {
  ExplorerLayout,
  ViewportFillRegion,
  type WorkspaceRailBack,
} from '@connorhoehnslalom/ui-components';
import { Stack } from '@connorhoehnslalom/ui-components/shared';

/**
 * Everything the explorer column shows. A route builds one of these — the
 * initiative list (`useInitiativeListRail`) or its own (the Work list) — and
 * spreads it into the frame.
 */
export interface ExplorerRailSlots {
  /** "Initiatives", "Work". */
  railTitle: string;
  /** The plain count after the title. Omit when it is unknown or capped. */
  railCount?: number;
  /** "‹ Initiatives" above the title (the Work list). */
  railBack?: WorkspaceRailBack | null;
  /** Controls in the title row — the ⋯ menu, an initiative switcher. */
  railActions?: ReactNode;
  /** Under the title: tabs, the scope toggle, search. */
  railHeader?: ReactNode;
  /** The scrolling body. */
  rail: ReactNode;
  /** The fixed footer: "14 initiatives", "Personal view". */
  railFooter?: ReactNode;
  /** Offer the « fold. The Work list does not (it has a back link instead). */
  collapsible?: boolean;
  /** What the rail holds, for the fold controls' names. */
  railLabel?: string;
}

export interface InitiativesExplorerProps extends ExplorerRailSlots {
  /** The band over the pane: `ScopeHeader` (title, pill, tabs). */
  paneHeader?: ReactNode;
  /** The pane body. It scrolls; the header and composer do not. */
  children: ReactNode;
  /** Docked under the pane — normally `<InitiativeComposer>`. */
  composer?: ReactNode;
  'data-testid'?: string;
}

const RAIL_FOLD_KEY = 'initiatives.rail-collapsed';

function readFolded(): boolean {
  try { return localStorage.getItem(RAIL_FOLD_KEY) === '1'; } catch { return false; }
}

export function InitiativesExplorer({
  railTitle, railCount, railBack, railActions, railHeader, rail, railFooter,
  collapsible = false, railLabel = 'initiatives',
  paneHeader, children, composer, 'data-testid': testId,
}: InitiativesExplorerProps) {
  const [folded, setFolded] = useState(readFolded);
  const toggle = useCallback(() => {
    setFolded((was) => {
      const next = !was;
      try { localStorage.setItem(RAIL_FOLD_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }, []);

  return (
    <ViewportFillRegion bottomGap={0} data-testid={testId ?? 'initiatives-explorer'}>
      <Stack gap="none" className="h-full min-h-0 bg-surface" data-shell-flush>
        <ExplorerLayout
          className="min-h-0 flex-1"
          railWidth="lg"
          railHeading="prominent"
          railCountStyle="plain"
          railTitle={railTitle}
          {...(railCount != null ? { railCount } : {})}
          railBack={railBack ?? null}
          railActions={railActions}
          railHeader={railHeader}
          railFooter={railFooter}
          railLabel={railLabel}
          {...(collapsible ? { railCollapsed: folded, onToggleRail: toggle } : {})}
          rail={rail}
          panePadding="none"
          asidePlacement="beside"
          paneHeader={paneHeader}
          paneFooter={composer}
        >
          {children}
        </ExplorerLayout>
      </Stack>
    </ViewportFillRegion>
  );
}
