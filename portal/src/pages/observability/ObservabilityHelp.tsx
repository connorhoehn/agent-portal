// Help overlay — a click-to-open modal explaining each observability tab.
// Triggered by a small "?" button next to the "Observability" rail title so
// it doesn't eat vertical space in the left rail. Each entry: WHEN to open
// it + WHAT to look at. Short form — this is a refresher, not docs.

import { useState } from 'react';
import {
  Card,
  IconButton,
  Inline,
  Modal,
  SectionLabel,
  Stack, T,
} from '@connorhoehnslalom/ui-components/shared';
import { KeyValue } from '../../components/KeyValue';

interface HelpEntry {
  group: 'Health' | 'Runs' | 'Cost';
  path: string;
  label: string;
  when: string;
  look: string;
}

const ENTRIES: HelpEntry[] = [
  { group: 'Health', path: 'oncall', label: 'On-Call',
    when: 'A drift alarm fired at 3am, or you start the day and want one screen of system health.',
    look: 'Active alarms strip, the unified timeline (drift + cost + errors + deploys), HITL SLA.' },
  { group: 'Health', path: 'summary', label: 'Summary',
    when: 'You want a 24h headline number for an exec or your own scan.',
    look: 'Total invocations, error rate, token usage, latency p50.' },
  { group: 'Cost', path: 'cost', label: 'Cost',
    when: 'Weekly cost review or "why is the Bedrock bill spiking" investigation.',
    look: 'Stacked bars per agent over time with deploy markers; top-N expensive invocations; A2A overhead.' },
  { group: 'Cost', path: 'traffic', label: 'Traffic',
    when: 'Capacity question — "can we hold 3× traffic" or "who is hitting us most".',
    look: 'RPS-over-time area chart, hour-of-week heatmap, top users by cost.' },
  { group: 'Cost', path: 'agents', label: 'Agent Metrics',
    when: 'Quick per-agent operational stats from CloudWatch native metrics.',
    look: 'Bedrock invocations + tokens by model.' },

  { group: 'Runs', path: 'invocations', label: 'Recent',
    when: 'Eyeball check — what just ran. No filters.',
    look: 'The most recent 50 calls with prompt/response snippet + status chips.' },
  { group: 'Runs', path: 'invocations/search', label: 'Search',
    when: 'A user reported a bad answer — you need to find that specific call.',
    look: 'Filter by agent, prompt substring, score range, time window, prompt-version.' },
  { group: 'Runs', path: 'capability-events', label: 'Capability Events',
    when: 'A code-interpreter or browser invocation misbehaved.',
    look: 'Per-event detail: which sandbox URL, which exec, screenshots.' },
  { group: 'Runs', path: 'sessions', label: 'Sessions',
    when: 'Replay a multi-turn conversation thread.',
    look: 'Per-session URLs visited, extracted text, judge scores in order.' },
  { group: 'Runs', path: 'memory', label: 'Memory',
    when: 'Agent seems to "forget" or retrieve stale context.',
    look: 'Per-agent retrieve/write counts, p99 latency, cold-session warnings.' },

  { group: 'Health', path: 'drift', label: 'Drift',
    when: 'You want to know if outputs are getting worse over time.',
    look: 'P95 cosine distance to centroid, schema conformance, judge P05 (worst tail).' },
  { group: 'Health', path: 'quality', label: 'Quality',
    when: 'You want the headline "are responses any good" view + label them.',
    look: 'Judge score time series, histogram, recent invocations with feedback buttons.' },
  { group: 'Health', path: 'guardrail-rules', label: 'Guardrail Rules',
    when: 'You see "BLOCKED" interventions and need to know which rule fired.',
    look: 'Top firing rules with severity, click → per-rule interventions + matched text.' },

  { group: 'Runs', path: 'harness', label: 'Harness',
    when: 'Before merging a prompt change — run the curated test set and check for regressions.',
    look: 'Recent runs, pass-rate sparkline, run detail (regressions vs baseline + cost delta).' },
  { group: 'Runs', path: 'calibration', label: 'Calibration',
    when: '"Can I trust the judge?" — periodically re-run judge against human-graded cases.',
    look: 'MAE trend, judge-vs-human scatter, worst-disagreement cases.' },
  { group: 'Runs', path: 'model-compare', label: 'Model Compare',
    when: 'Nova v2 dropped — should we move? Or you ran the same test set on a different model.',
    look: 'Side-by-side run picker, per-case score deltas, cost + latency deltas.' },

  { group: 'Health', path: 'authz', label: 'Authz Log',
    when: 'A "who can do X" question, or a Cedar policy audit trail.',
    look: 'Live ALLOW/DENY decisions stream with role + action + resource.' },
  { group: 'Health', path: 'approvals', label: 'Approval Queue',
    when: "You're the human in the loop for high-stakes actions.",
    look: 'Pending approvals with txId, agent, payload, approve/reject + note.' },
];

const GROUP_ORDER: HelpEntry['group'][] = ['Health', 'Runs', 'Cost'];
const GROUP_BLURB: Record<HelpEntry['group'], string> = {
  Health: 'Is it working? Alarms, errors, output quality, drift, and who approved what.',
  Runs: 'What happened? Every invocation, session, and evaluation replay.',
  Cost: 'What did it cost? Spend, traffic shape, and per-agent burn.',
};

/**
 * Small "?" button — placed in the rail header. Clicking opens the modal.
 * Renders nothing visible to the rail beyond a 22px circular button.
 */
export function ObservabilityHelpButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <IconButton
        onClick={() => setOpen(true)}
        aria-label="What are these tabs?"
        title="What are these tabs?"
        variant="ghost"
        size="sm"
      >
        ?
      </IconButton>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Observability guide"
        maxWidth={960}
      >
        <T size="xs" as="div" className="text-text-tertiary mb-3">
          Eighteen observability surfaces, grouped by what you're trying to do.
        </T>
        <Stack gap="md" className="overflow-y-auto">
          {GROUP_ORDER.map((g) => {
            const entries = ENTRIES.filter((e) => e.group === g);
            return (
              <Stack key={g} gap="sm" as="section">
                <Inline gap="sm" align="baseline">
                  <SectionLabel>{g}</SectionLabel>
                  <T size="xs" className="text-text-tertiary italic">{GROUP_BLURB[g]}</T>
                </Inline>
                <Inline gap="sm" wrap align="start">
                  {entries.map((e) => (
                    <Card key={e.path} padding="sm" className="flex-1 min-w-[280px] bg-bg">
                      <T weight="semibold" size="sm" as="div" className="text-text-primary mb-1">{e.label}</T>
                      <Stack gap="xs">
                        <KeyValue layout="row" labelWidth="w-auto" label="When" value={e.when} />
                        <KeyValue layout="row" labelWidth="w-auto" label="Look at" value={e.look} />
                      </Stack>
                    </Card>
                  ))}
                </Inline>
              </Stack>
            );
          })}
        </Stack>
      </Modal>
    </>
  );
}

/**
 * Legacy default export — keeps the old import shape working for anything
 * that still imports `ObservabilityHelp`. Renders the button only.
 */
export function ObservabilityHelp() {
  return <ObservabilityHelpButton />;
}
