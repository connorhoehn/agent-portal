// Hook: contextual SubNav items for the /iq/canary page. Reactive — items
// reflect live store state (weight split, halted flag, decision count).
//
// Path items navigate to /iq/canary?focus=<id> — CanaryPage reads the query
// param to open the matching template/decision drawer. Action items
// (Halt, Manual weight) call into the store directly.

import type { SubNavItem } from '@connorhoehn/ui-components/shared';
import {
  openHaltConfirm,
  toggleManualSlider,
  useCanaryStore,
} from './canaryStore.js';

export function useCanaryNavItems(): SubNavItem[] {
  const experimentState = useCanaryStore((s) => s.experimentState);
  const weightA = useCanaryStore((s) => s.weightA);
  const weightB = useCanaryStore((s) => s.weightB);
  const halted = useCanaryStore((s) => s.halted);
  const decisionsCount = useCanaryStore((s) => s.recentDecisions.length);
  const rps = useCanaryStore((s) => s.rps);
  const manualOpen = useCanaryStore((s) => s.manualSliderOpen);

  // No live experiment → no run-state/controls noise. Showing "Halt canary"
  // during setup was a trap: every item below assumes traffic exists. The
  // wizard is the only sensible destination, plus past decisions for context.
  if (experimentState !== 'running') {
    return [
      {
        path: 'canary',
        label: 'New experiment',
        accent: 'success',
        group: 'Setup',
      },
      {
        path: 'canary?focus=decisions',
        label: 'Past decisions',
        count: decisionsCount,
        group: 'History',
      },
    ];
  }

  return [
    // ── Prompts ──────────────────────────────────────────────────────────────
    {
      path: 'canary?focus=subject-a',
      label: 'Subject A',
      group: 'Prompts',
    },
    {
      path: 'canary?focus=subject-b',
      label: 'Subject B',
      group: 'Prompts',
    },
    {
      path: 'canary?focus=judge',
      label: 'Judge',
      group: 'Prompts',
    },

    // ── Run state ────────────────────────────────────────────────────────────
    {
      path: 'canary?focus=status',
      label: halted ? 'Halted' : 'Active',
      accent: halted ? 'danger' : 'success',
      group: 'Run state',
    },
    {
      path: 'canary?focus=weight',
      label: 'Weight split',
      count: `${weightA}/${weightB}`,
      group: 'Run state',
    },
    {
      path: 'canary?focus=traffic',
      label: 'Traffic',
      count: `${rps.toFixed(1)}/min`,
      group: 'Run state',
    },

    // ── Controls ─────────────────────────────────────────────────────────────
    {
      path: 'action-halt',
      label: halted ? 'Already halted' : 'Halt canary',
      accent: 'danger',
      onClick: halted ? undefined : openHaltConfirm,
      group: 'Controls',
    },
    {
      path: 'action-manual',
      label: manualOpen ? 'Hide manual weight' : 'Manual weight…',
      onClick: toggleManualSlider,
      group: 'Controls',
    },

    // ── History ──────────────────────────────────────────────────────────────
    {
      path: 'canary?focus=decisions',
      label: 'Decisions',
      count: decisionsCount,
      group: 'History',
    },
  ];
}
