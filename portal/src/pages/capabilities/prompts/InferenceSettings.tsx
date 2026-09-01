import { Card, FormField, FormRow, Input, Select, Stack } from '@connorhoehnslalom/ui-components/shared';
import { SectionLabel } from '../_shared/SectionLabel';
import { DEFAULT_TEMPERATURE, MAX_TOKEN_OPTIONS } from './promptFormat';

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
            {({ labelId: _labelId, ...field }) => (
              <Stack gap="xs">
                <span className="text-right text-[11px] font-semibold tabular-nums text-text-secondary">
                  {shownTemperature.toFixed(2)}
                </span>
                {/* A raw range input: the library's Slider is exported from the
                    root entry only, and pulling the root entry into this lazy
                    chunk drags the whole video/yjs graph with it. Reported to
                    the coordinator — swap to <Slider> once it is on /shared. */}
                <input
                  {...field}
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={shownTemperature}
                  onChange={e => onChange({ temperature: e.target.value })}
                  disabled={disabled}
                  className="w-full accent-[var(--color-optimize)]"
                />
              </Stack>
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
