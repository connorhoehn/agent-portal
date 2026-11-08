// The one "there is nothing to show in this region" row for observability
// pages — was copy-pasted as a local `function EmptyState` in ~10 files
// (TrafficPage, CalibrationPage, GuardrailRulesPage, DriftPage,
// ModelComparePage, OnCallPage, InvocationSearchPage, harness/RunDetailPage,
// harness/CompareRunsPage, harness/HarnessHomePage), each hand-rolling the
// same "Unknown — this read failed" prose in raw `T`/`Inline`.
//
// Same distinction `UnavailableNotice` and `SmartEmptyState` already draw
// elsewhere in the app: a `degraded` read (the server answered but does not
// believe its own answer) is not the same fact as an honest empty, so it
// gets the danger-bordered notice instead of neutral placeholder prose.

import { InlinePlaceholder } from '@connorhoehn/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';

export function RowEmpty({ text, degraded }: { text: string; degraded?: string | null }) {
  if (degraded) {
    return (
      <UnavailableNotice error={degraded} what="this" className="my-1" />
    );
  }
  return (
    <InlinePlaceholder align="center" className="text-xs p-6">
      {text}
    </InlinePlaceholder>
  );
}
