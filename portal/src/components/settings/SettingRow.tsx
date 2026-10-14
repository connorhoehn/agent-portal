import type { ReactNode } from 'react';
import { Inline, Stack, T } from '@connorhoehnslalom/ui-components/shared';

interface SettingRowProps {
  title: string;
  description?: string;
  control: ReactNode;
}

export function SettingRow({ title, description, control }: SettingRowProps) {
  return (
    <Inline gap="lg" justify="between" wrap={false} className="py-2.5"
    >
      {/* Stack, not Inline: title and description are stacked block children.
          The <div> they came from had no display:flex, so a flex ROW would put
          them side by side. */}
      <Stack gap="none" className="flex-1 min-w-0">
        <T size="sm" weight="medium" tone="primary">
          {title}
        </T>
        {description && (
          <T size="xs" tone="secondary" className="mt-0.5">
            {description}
          </T>
        )}
      </Stack>
      <Inline gap="none" className="shrink-0">{control}</Inline>
    </Inline>
  );
}
