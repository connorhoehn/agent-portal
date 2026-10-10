import type { ReactElement } from 'react';
import { Banner, Button, Inline } from '@connorhoehnslalom/ui-components/shared';

/** "Someone saved after you opened it" with a reload action; both deck pages. */
export function DeckConflictBanner({ noun, onReload, testId }: { noun: string; onReload: () => void; testId: string }): ReactElement {
  return (
    <Banner variant="warning" layout="stacked" title={`A newer version of this ${noun} exists`} data-testid={testId}>
      <Inline gap="sm" align="center">
        Someone saved after you opened it.
        <Button size="sm" variant="secondary" onClick={onReload}>Reload latest</Button>
      </Inline>
    </Banner>
  );
}
