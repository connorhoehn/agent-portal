import type { ReactNode } from 'react';
import { Inline, Stack, T } from '@connorhoehn/ui-components/shared';

interface SettingRowProps {
  title: string;
  description?: string;
  control: ReactNode;
  /** One line under the control: the outcome of the last change made there ("Saved."). */
  status?: ReactNode;
}

/**
 * One settings row: the title and description, then the control on the right.
 * The text keeps a 16rem basis and the row wraps, so where the two cannot sit
 * side by side (a phone-width card) the control drops under the text at the
 * row's full width instead of squeezing the description to a word per line.
 */
export function SettingRow({ title, description, control, status }: SettingRowProps) {
  return (
    <Inline gap="lg" justify="between" wrap className="gap-y-2 py-2.5" data-setting-row="">
      {/* Stack, not Inline: title and description are stacked block children.
          The <div> they came from had no display:flex, so a flex ROW would put
          them side by side. */}
      <Stack gap="none" className="min-w-0 flex-1 basis-[16rem]">
        <T size="sm" weight="medium" tone="primary">
          {title}
        </T>
        {description && (
          <T size="xs" tone="secondary" className="mt-0.5">
            {description}
          </T>
        )}
      </Stack>
      <Stack gap="xs" align="end" className="min-w-0 max-w-full shrink-0">
        <Inline gap="none">{control}</Inline>
        {status}
      </Stack>
    </Inline>
  );
}
