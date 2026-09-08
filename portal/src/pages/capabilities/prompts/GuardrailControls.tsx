import { Chip, Inline, InlineAlert, Select } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch.js';
import { blockingInterventions } from './promptFormat';
import type { GuardrailIntervention, GuardrailSnapshot } from './types';
import { T } from '../Text';

/** The tenant's configured guardrail, or none. A single-guardrail tenant is the
 *  only shape the API exposes today, so this is a two-option select. */
export function GuardrailSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const { data, isLoading } = useFetch<GuardrailSnapshot>('/api/capabilities/guardrail', 0);
  const options = [
    { value: '', label: 'None — skip guardrail' },
    ...(data ? [{ value: data.id, label: `${data.name} (v${data.version})` }] : []),
  ];

  return (
    <Select
      options={options}
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={isLoading}
      aria-label="Guardrail"
    />
  );
}

/** Shown only when the guardrail actually intervened — an assessment that
 *  passed everything is not news. */
export function GuardrailBanner({ interventions }: { interventions: GuardrailIntervention[] }) {
  const blocked = blockingInterventions(interventions);
  if (blocked.length === 0) return null;

  return (
    <InlineAlert tone="warning">
      <Inline gap="sm">
        <T className="font-bold">Guardrail triggered</T>
        {blocked.map((b, i) => (
          <Chip key={i} tone="warning" size="xs" solid>{b.type ?? b.action}</Chip>
        ))}
      </Inline>
    </InlineAlert>
  );
}
