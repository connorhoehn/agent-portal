// Hook: contextual SubNav items for the /iq/canary page. Reactive — items
// reflect live store state (weight split, halted flag, decision count).
//
// Path items navigate to /iq/canary?focus=<id> — CanaryPage reads the query
// param to open the matching template/decision drawer. Action items
// (Halt, Manual weight) call into the store directly.

import type { SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import {
  openHaltConfirm,
  toggleManualSlider,
  useCanaryStore,
} from './canaryStore.js';

export function useCanaryNavItems(): SubNavItem[] {
  const weightA = useCanaryStore((s) => s.weightA);
  const weightB = useCanaryStore((s) => s.weightB);
  const halted = useCanaryStore((s) => s.halted);
  const controllerState = useCanaryStore((s) => s.controllerState);
  const decisionsCount = useCanaryStore((s) => s.recentDecisions.length);
  const lastDecision = useCanaryStore((s) => s.recentDecisions[0]);
  const rps = useCanaryStore((s) => s.rps);
  const manualOpen = useCanaryStore((s) => s.manualSliderOpen);

  return [
    // ── Prompts ──────────────────────────────────────────────────────────────
    {
      path: 'canary?focus=subject-a',
      label: 'Subject A',
      hint: 'Terse explainer',
      group: 'Prompts',
    },
    {
      path: 'canary?focus=subject-b',
      label: 'Subject B',
      hint: 'Structured explainer',
      group: 'Prompts',
    },
    {
      path: 'canary?focus=judge',
      label: 'Judge',
      hint: 'Rubric scorer',
      group: 'Prompts',
    },

    // ── Run state ────────────────────────────────────────────────────────────
    {
      path: 'canary?focus=status',
      label: halted ? 'Halted' : 'Active',
      hint: `Controller: ${controllerState}`,
      accent: halted ? 'danger' : 'success',
      group: 'Run state',
    },
    {
      path: 'canary?focus=weight',
      label: 'Weight split',
      count: `${weightA}/${weightB}`,
      hint: 'A% / B%',
      group: 'Run state',
    },
    {
      path: 'canary?focus=traffic',
      label: 'Traffic',
      count: `${rps.toFixed(1)}/min`,
      hint: 'Rolling 30s estimate',
      group: 'Run state',
    },

    // ── Controls ─────────────────────────────────────────────────────────────
    {
      path: 'action-halt',
      label: halted ? 'Already halted' : 'Halt canary',
      hint: halted ? 'Resume via manual weight' : 'Pin 100% to A',
      accent: 'danger',
      onClick: halted ? undefined : openHaltConfirm,
      group: 'Controls',
    },
    {
      path: 'action-manual',
      label: manualOpen ? 'Hide manual weight' : 'Manual weight…',
      hint: 'Operator override (10 min)',
      onClick: toggleManualSlider,
      group: 'Controls',
    },

    // ── History ──────────────────────────────────────────────────────────────
    {
      path: 'canary?focus=decisions',
      label: 'Decisions',
      count: decisionsCount,
      hint: lastDecision
        ? `Last: ${lastDecision.action}`
        : 'No decisions yet',
      group: 'History',
    },
  ];
}
