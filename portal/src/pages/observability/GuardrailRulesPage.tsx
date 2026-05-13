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
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import {
  Card,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { GuardrailRuleBadge } from '../../components/observability/GuardrailRuleBadge';

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
    <div style={pageStyle}>
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Guardrail rules{' '}
            <span style={hint}>
              {totalFires} intervention{totalFires === 1 ? '' : 's'} across {rules.length} rule{rules.length === 1 ? '' : 's'} · last {win.label}
            </span>
          </h2>
          <WindowPicker value={windowIdx} onChange={(i) => { setWindowIdx(i); setSelectedRule(null); }} />
        </div>
        {rules.length === 0 ? (
          <EmptyState text="No guardrail interventions in this window. Rules surface here as soon as Bedrock Guardrails fires." />
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
                    style={focused
                      ? { background: 'var(--color-surface-hover)', cursor: 'pointer' }
                      : { cursor: 'pointer' }}
                  >
                    <TableTd style={ruleCell}>{r.ruleName}</TableTd>
                    <TableTd>
                      {r.ruleCategory ? (
                        <Chip tone={categoryTone(r.ruleCategory)} size="xs">
                          {r.ruleCategory}
                        </Chip>
                      ) : (
                        <span style={mutedSmall}>—</span>
                      )}
                    </TableTd>
                    <TableTd style={numCell}>{r.count}</TableTd>
                    <SeverityCell n={r.severityCounts.LOW} tone="neutral" />
                    <SeverityCell n={r.severityCounts.MEDIUM} tone="warning" />
                    <SeverityCell n={r.severityCounts.HIGH} tone="danger" />
                    <TableTd style={{ textAlign: 'right' }}>
                      <span style={mutedSmall}>{focused ? '▾' : '▸'}</span>
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
          <div style={headerRow}>
            <h2 style={h2}>
              Interventions for <span style={mono}>{selectedRule}</span>{' '}
              <span style={hint}>
                {interventions.length} row{interventions.length === 1 ? '' : 's'} · newest first
              </span>
            </h2>
            <button
              type="button"
              onClick={() => setSelectedRule(null)}
              style={btnSecondary}
            >
              Clear
            </button>
          </div>
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
                    <TableTd style={tsCell}>
                      {new Date(i.ts).toLocaleString()}
                    </TableTd>
                    <TableTd style={agentCell}>{i.agentId}</TableTd>
                    <TableTd>
                      <GuardrailRuleBadge
                        ruleName={i.ruleName}
                        action={i.action}
                        severity={i.severity}
                      />
                    </TableTd>
                    <TableTd style={matchedCell} title={i.matchedText ?? ''}>
                      {i.matchedText ? (
                        <span style={mono}>{i.matchedText}</span>
                      ) : (
                        <span style={mutedSmall}>(no excerpt)</span>
                      )}
                    </TableTd>
                    <TableTd style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {i.invocationId ? (
                        <Link
                          to={`/observability/invocations/${i.invocationId}`}
                          style={btnLink}
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
    </div>
  );
}

function SeverityCell({ n, tone }: { n: number; tone: Tone }) {
  return (
    <TableTd>
      {n > 0 ? (
        <Chip tone={tone} size="xs">{n}</Chip>
      ) : (
        <span style={mutedSmall}>0</span>
      )}
    </TableTd>
  );
}

function WindowPicker({ value, onChange }: { value: number; onChange: (i: number) => void }) {
  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      {WINDOW_OPTIONS.map((w, i) => (
        <button
          key={w.label}
          onClick={() => onChange(i)}
          style={{
            fontSize: 11,
            padding: '4px 10px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            background: i === value ? 'var(--color-primary)' : 'var(--color-surface)',
            color: i === value ? 'white' : 'var(--color-text-secondary)',
            cursor: 'pointer',
            fontWeight: i === value ? 500 : 400,
          }}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
      {text}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = { padding: 24, display: 'flex', flexDirection: 'column', gap: 24 };
const headerRow: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  marginBottom: 12, gap: 12, flexWrap: 'wrap',
};
const h2: CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };
const hint: CSSProperties = { fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 };
const ruleCell: CSSProperties = { fontSize: 12, fontWeight: 500, fontFamily: 'ui-monospace, monospace' };
const numCell: CSSProperties = { fontSize: 12, color: 'var(--color-text-secondary)' };
const tsCell: CSSProperties = { fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' };
const agentCell: CSSProperties = { fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' };
const matchedCell: CSSProperties = {
  fontSize: 12, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const mutedSmall: CSSProperties = { fontSize: 11, color: 'var(--color-text-tertiary)' };
const mono: CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: 11.5 };
const btnSecondary: CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  background: 'var(--color-surface)',
  color: 'var(--color-text-secondary)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};
const btnLink: CSSProperties = {
  padding: '2px 8px',
  fontSize: 14,
  color: 'var(--color-primary, #6366f1)',
  textDecoration: 'none',
};

export default GuardrailRulesPage;
