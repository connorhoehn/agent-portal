import type { ReactNode } from 'react';
import { Inline, Stack } from '@connorhoehnslalom/ui-components/shared';

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
        <Inline as="span" gap="none" className="text-[14px] font-medium text-text-primary">
          {title}
        </Inline>
        {description && (
          <Inline as="span" gap="none" className="text-[12px] text-text-secondary mt-0.5">
            {description}
          </Inline>
        )}
      </Stack>
      <Inline gap="none" className="shrink-0">{control}</Inline>
    </Inline>
  );
}
