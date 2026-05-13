// GuardrailRuleBadge — a chip rendering "<rule_name> · <action>" with a tone
// derived from severity. Used on InvocationDetailPage's guardrail trace card
// and on GuardrailRulesPage.
//
// Tone palette:
//   HIGH   → danger
//   MEDIUM → warning
//   LOW    → neutral
//   null   → neutral
//
// Action label:
//   BLOCKED    → "blocked"
//   ANONYMIZED → "redacted"
//   other      → action as-given

import { Chip } from '@connorhoehnslalom/ui-components/shared';

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

interface Props {
  ruleName: string;
  action: string;
  severity?: string | null;
  size?: 'xs' | 'sm';
}

function toneFor(severity: string | null | undefined): Tone {
  if (severity === 'HIGH') return 'danger';
  if (severity === 'MEDIUM') return 'warning';
  return 'neutral';
}

function actionLabel(action: string): string {
  if (action === 'BLOCKED') return 'blocked';
  if (action === 'ANONYMIZED') return 'redacted';
  return action.toLowerCase();
}

export function GuardrailRuleBadge({ ruleName, action, severity, size = 'xs' }: Props) {
  return (
    <Chip tone={toneFor(severity)} size={size}>
      {ruleName} · {actionLabel(action)}
    </Chip>
  );
}

export default GuardrailRuleBadge;
