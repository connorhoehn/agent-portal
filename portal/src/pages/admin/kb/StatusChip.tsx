// The KB lifecycle badge, shared by the registry list and the detail header.
//
// This was a hand-rolled <StatusDot color="..."> + <Chip> pair, so the dot
// was a literal hex that never moved with the theme while the chip beside it
// did. Chip's own `dot` swatch takes its colour from the tone, which makes the
// two halves agree by construction.

import { Chip } from '@connorhoehnslalom/ui-components/shared';
import { statusStyle } from './kbFormat';
import type { KbStatus } from './types';

export function StatusChip({ status }: { status: KbStatus }) {
  return (
    <Chip tone={statusStyle(status).tone} size="xs" dot="static">
      {status}
    </Chip>
  );
}
