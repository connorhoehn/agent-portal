// Guardrail rule-level breakdown.
//
// Today invocation_traces.guardrail_action is BLOCKED/ANONYMIZED/NONE —
// opaque. This page surfaces *which* rule fired (PII.email vs.
// topic.violence vs. content.hate) over a window, plus a drill-down to the
// individual interventions for any chosen rule.
//
// Data sources (all under /api/observability/guardrails-detail):
//   GET /by-rule?windowHours=             — top rules + severity counts
//   GET /interventions?ruleName=&limit=   — drill-down for one rule

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Button,
  Card,
  CardHeader,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
  Inline,
  PageSection,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { GuardrailRuleBadge } from '../../components/observability/GuardrailRuleBadge';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';
import { T } from './Text';

// ── Types (mirrored from middleware/src/routes/guardrails-detail.ts) ───────

interface ByRuleEntry {
  ruleName: string;
  ruleCategory: string | null;
  count: number;
  severityCounts: { LOW: number; MEDIUM: number; HIGH: number };
}

interface ByRuleResponse {
  byRule: ByRuleEntry[];
  windowHours: number;
}

interface GuardrailIntervention {
  interventionId: string;
  invocationId: string | null;
  agentId: string;
  ruleName: string;
  ruleCategory: string | null;
  severity: string | null;
  action: string;
  matchedText: string | null;
  ts: string;
}

interface InterventionsResponse {
  interventions: GuardrailIntervention[];
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const WINDOW_OPTIONS: Array<{ label: string; hours: number }> = [
  { label: '1h',  hours: 1 },
  { label: '6h',  hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d',  hours: 168 },
];

function categoryTone(cat: string | null): Tone {
  if (cat === 'PII') return 'warning';
  if (cat === 'PROMPT_ATTACK') return 'danger';
  if (cat === 'CONTENT') return 'warning';
  if (cat === 'TOPIC') return 'neutral';
  return 'neutral';
}

function GuardrailRulesPage() {
  const [windowIdx, setWindowIdx] = useState(2); // 24h
  const win = WINDOW_OPTIONS[windowIdx];

  const { data } = useFetch<ByRuleResponse>(
    `/api/observability/guardrails-detail/by-rule?windowHours=${win.hours}`,
    30_000,
  );
  const rules = useMemo<ByRuleEntry[]>(() => data?.byRule ?? [], [data]);
  const totalFires = useMemo(
    () => rules.reduce((acc, r) => acc + r.count, 0),
    [rules],
  );

  const [selectedRule, setSelectedRule] = useState<string | null>(null);
  const interventionsUrl = selectedRule
    ? `/api/observability/guardrails-detail/interventions?ruleName=${encodeURIComponent(selectedRule)}&limit=50`
    : '';
  const { data: intData } = useFetch<InterventionsResponse>(interventionsUrl, 30_000);
  const interventions = useMemo<GuardrailIntervention[]>(
    () => intData?.interventions ?? [],
    [intData],
  );

  return (
    <PageSection
      title="Guardrail Rules"
      description={`${totalFires} intervention${totalFires === 1 ? '' : 's'} across ${rules.length} rule${rules.length === 1 ? '' : 's'} · last ${win.label}`}
      actions={<WindowPicker value={windowIdx} onChange={(i) => { setWindowIdx(i); setSelectedRule(null); }} />}
    >
      <Card padding="md">
        {rules.length === 0 ? (
          <SmartEmptyState
            title="No interventions yet"
            detail="Rules surface here as soon as Bedrock Guardrails fires a block or anonymize action."
            actions={[
              {
                label: 'Seed synthetic guardrail interventions',
                detail: 'Inserts a representative spread of PII / topic / content interventions.',
                code: 'python3 infra/scripts/seed_memory_guardrail_events.py',
              },
            ]}
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Rule</TableTh>
                <TableTh>Category</TableTh>
                <TableTh>Total</TableTh>
                <TableTh>LOW</TableTh>
                <TableTh>MEDIUM</TableTh>
                <TableTh>HIGH</TableTh>
                <TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {rules.map((r) => {
                const focused = r.ruleName === selectedRule;
                return (
                  <TableRow
                    key={r.ruleName}
                    onClick={() => setSelectedRule(focused ? null : r.ruleName)}
                    className={focused ? 'bg-surface-hover cursor-pointer' : 'cursor-pointer'}
                  >
                    <TableTd className="text-[12px] font-medium font-mono">{r.ruleName}</TableTd>
                    <TableTd>
                      {r.ruleCategory ? (
                        <Chip tone={categoryTone(r.ruleCategory)} size="xs">
                          {r.ruleCategory}
                        </Chip>
                      ) : (
                        <T className="text-[11px] text-text-tertiary">—</T>
                      )}
                    </TableTd>
                    <TableTd className="text-[12px] text-text-secondary">{r.count}</TableTd>
                    <SeverityCell n={r.severityCounts.LOW} tone="neutral" />
                    <SeverityCell n={r.severityCounts.MEDIUM} tone="warning" />
                    <SeverityCell n={r.severityCounts.HIGH} tone="danger" />
                    <TableTd className="text-right">
                      <T className="text-[11px] text-text-tertiary">{focused ? '▾' : '▸'}</T>
                    </TableTd>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {selectedRule && (
        <Card padding="md">
          <CardHeader
            title={`Interventions for ${selectedRule}`}
            subtitle={`${interventions.length} row${interventions.length === 1 ? '' : 's'} · newest first`}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSelectedRule(null)}
              >
                Clear
              </Button>
            }
          />
          {interventions.length === 0 ? (
            <EmptyState text="No interventions captured for this rule yet." />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>When</TableTh>
                  <TableTh>Agent</TableTh>
                  <TableTh>Rule</TableTh>
                  <TableTh>Matched text</TableTh>
                  <TableTh></TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {interventions.map((i) => (
                  <TableRow key={i.interventionId}>
                    <TableTd className="text-[11px] text-text-tertiary whitespace-nowrap">
                      {new Date(i.ts).toLocaleString()}
                    </TableTd>
                    <TableTd className="text-[12px] font-medium whitespace-nowrap">{i.agentId}</TableTd>
                    <TableTd>
                      <GuardrailRuleBadge
                        ruleName={i.ruleName}
                        action={i.action}
                        severity={i.severity}
                      />
                    </TableTd>
                    <TableTd className="text-[12px] max-w-[380px] truncate" title={i.matchedText ?? ''}>
                      {i.matchedText ? (
                        <T className="font-mono text-[11.5px]">{i.matchedText}</T>
                      ) : (
                        <T className="text-[11px] text-text-tertiary">(no excerpt)</T>
                      )}
                    </TableTd>
                    <TableTd className="text-right whitespace-nowrap">
                      {i.invocationId ? (
                        <Link
                          to={`/admin/observability/invocations/${i.invocationId}`}
                          className="px-2 py-0.5 text-[14px] text-primary no-underline"
                          title="Open invocation detail"
                        >
                          →
                        </Link>
                      ) : null}
                    </TableTd>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      )}
    </PageSection>
  );
}

function SeverityCell({ n, tone }: { n: number; tone: Tone }) {
  return (
    <TableTd>
      {n > 0 ? (
        <Chip tone={tone} size="xs">{n}</Chip>
      ) : (
        <T className="text-[11px] text-text-tertiary">0</T>
      )}
    </TableTd>
  );
}

function WindowPicker({ value, onChange }: { value: number; onChange: (i: number) => void }) {
  return (
    <Inline gap="xs">
      {WINDOW_OPTIONS.map((w, i) => (
        <Button
          key={w.label}
          variant={i === value ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => onChange(i)}
        >
          {w.label}
        </Button>
      ))}
    </Inline>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <T as="div" className="p-6 text-center text-[12px] text-text-tertiary">
      {text}
    </T>
  );
}

export default GuardrailRulesPage;
