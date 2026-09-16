// One number with a clear provenance.
//
// The server-computed figure (the same one the Initiatives list shows) wins;
// the client-side sum of visible runs is the fallback, and it is only reported
// when the runs were actually visible. When neither holds, the stat says the
// spend is unknown rather than printing $0.00 — which is the one thing it must
// never do. "$0.00 agent spend" on an initiative that has spent money is a
// budget statement that is simply false.

import { StatCard } from '@connorhoehnslalom/ui-components/shared';
import { usd } from '../../lib/format';

export interface AgentSpendInputs {
  serverSpendUsd: number | null;
  serverPending: boolean;
  clientSpendUsd: number;
  clientBlind: boolean;
  clientPending: boolean;
}

/** Pure: the figure, its caption and the provenance tooltip. */
export function resolveAgentSpend(
  { serverSpendUsd, serverPending, clientSpendUsd, clientBlind, clientPending }: AgentSpendInputs,
): { value: string; label: string; title: string; unknown: boolean } {
  if (serverSpendUsd != null) {
    return {
      value: usd(serverSpendUsd),
      label: 'agent spend',
      title: 'Every agent run attributed to this initiative, totalled by the server — the same figure the Initiatives list shows.',
      unknown: false,
    };
  }
  if (serverPending || clientPending) {
    return { value: '…', label: 'agent spend', title: 'Loading agent spend.', unknown: false };
  }
  if (clientBlind) {
    return {
      value: '—',
      label: 'agent spend unknown',
      title: 'Agent spend is unknown to this role: the bot roster needs computer access, and the server has no rollup for this initiative. Unknown, not zero.',
      unknown: true,
    };
  }
  return {
    value: usd(clientSpendUsd),
    label: 'agent spend',
    title: 'Totalled from the agent runs visible to this session — the server reported no rollup for this initiative.',
    unknown: false,
  };
}

/**
 * The same resolved spend, shaped for a StatStrip cluster instead of a card.
 *
 * The provenance still travels with it: `resolveAgentSpend` is what knows the
 * difference between "$0.00 spent" and "unknown, not zero", and that
 * distinction must survive the move to a denser control — it is the whole
 * reason the tooltip exists.
 */
export function agentSpendStripItem(inputs: AgentSpendInputs): {
  label: string; value: string; hint?: string;
} {
  const { value, label, title } = resolveAgentSpend(inputs);
  return { label, value, ...(title ? { hint: title } : {}) };
}

export function AgentSpendStat(inputs: AgentSpendInputs) {
  const { value, label, title } = resolveAgentSpend(inputs);
  // StatCard now carries the tooltip itself. It used to ride on a <span> inside
  // `label`, which meant the provenance — including the load-bearing "unknown,
  // not zero" — only appeared while hovering four words of uppercase caption,
  // and not over the $0.00 that prompts the question.
  return <StatCard label={label} value={value} title={title} />;
}
