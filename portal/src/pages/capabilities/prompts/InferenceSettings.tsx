import { Card, FormField, FormRow, Input, SectionLabel, Select, Stack } from '@connorhoehn/ui-components/shared';
import { DEFAULT_TEMPERATURE, MAX_TOKEN_OPTIONS } from './promptFormat';
import { RangeSliderFrame } from '../../RangeSliderFrame';

/**
 * Temperature / max tokens / model ID.
 *
 * EditPanel and CreatePanel carried this block twice, character for character
 * including the `.toFixed(2)` readout and the `flex: 2` on the model field —
 * so a change to one silently diverged from the other. One component now.
 *
 * `temperature` is a string rather than a number because "" means "inherit the
 * baseline", which is a different claim from 0.
 */
export interface InferenceSettingsValue {
  temperature: string;
  maxTokens: string;
  modelId: string;
}

export function InferenceSettings({
  title,
  value,
  onChange,
  disabled,
  temperatureFallback = DEFAULT_TEMPERATURE,
}: {
  title: string;
  value: InferenceSettingsValue;
  onChange: (patch: Partial<InferenceSettingsValue>) => void;
  disabled?: boolean;
  /** Shown (and used as the slider position) while temperature is unset. */
  temperatureFallback?: number;
}) {
  const shownTemperature = value.temperature !== '' ? parseFloat(value.temperature) : temperatureFallback;

  return (
    <Card padding="sm" className="bg-surface-panel">
      <Stack gap="sm">
        <SectionLabel>{title}</SectionLabel>
        <FormRow stackBelow="md">
          <FormField label="Temperature">
            {() => (
              <RangeSliderFrame
                label=""
                ariaLabel="Temperature"
                min={0}
                max={1}
                step={0.01}
                value={shownTemperature}
                onChange={v => onChange({ temperature: String(v) })}
                valueLabel={shownTemperature.toFixed(2)}
                disabled={disabled}
                className="w-full [&>input]:w-full [&>input]:accent-[var(--color-optimize)] [&>span]:min-w-8 [&>span]:text-xs [&>span]:font-semibold"
              />
            )}
          </FormField>

          <FormField label="Max tokens">
            {({ labelId: _labelId, ...field }) => (
              <Select
                {...field}
                options={MAX_TOKEN_OPTIONS}
                value={value.maxTokens}
                onChange={e => onChange({ maxTokens: e.target.value })}
                disabled={disabled}
              />
            )}
          </FormField>

          <FormField label="Model ID" className="flex-[2]">
            {({ labelId: _labelId, ...field }) => (
              <Input
                {...field}
                mono
                value={value.modelId}
                onChange={e => onChange({ modelId: e.target.value })}
                placeholder="amazon.nova-pro-v1:0"
                disabled={disabled}
              />
            )}
          </FormField>
        </FormRow>
      </Stack>
    </Card>
  );
}
