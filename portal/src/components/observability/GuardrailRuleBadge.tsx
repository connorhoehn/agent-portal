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

import { Chip } from '@connorhoehn/ui-components/shared';
import { severityTone } from '../../lib/statusTone';

interface Props {
  ruleName: string;
  action: string;
  severity?: string | null;
  size?: 'xs' | 'sm';
}

function actionLabel(action: string): string {
  if (action === 'BLOCKED') return 'blocked';
  if (action === 'ANONYMIZED') return 'redacted';
  return action.toLowerCase();
}

export function GuardrailRuleBadge({ ruleName, action, severity, size = 'xs' }: Props) {
  return (
    <Chip tone={severityTone(severity)} size={size}>
      {ruleName} · {actionLabel(action)}
    </Chip>
  );
}

export default GuardrailRuleBadge;
