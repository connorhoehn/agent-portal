import type { ReactNode } from 'react';
import { Stack } from '@connorhoehn/ui-components/shared';

/** Full-bleed standalone frame: no rail, no workspace header, no footer. Used by the workspace chooser
 *  and by WorkspaceGate's refusal, both of which sit outside the app Layout. */
export function BareFrame({ children }: { children: ReactNode }) {
  return (
    <Stack gap="none" className="min-h-screen bg-[var(--color-bg)] px-6 py-10">
      <Stack gap="none" className="mx-auto w-full max-w-5xl">{children}</Stack>
    </Stack>
  );
}
