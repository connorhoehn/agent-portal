// Guardrail rule-level breakdown.
//
// Today invocation_traces.guardrail_action is BLOCKED/ANONYMIZED/NONE —
// opaque. This page surfaces *which* rule fired (PII.email vs.
// topic.violence vs. content.hate) over a window, plus a drill-down to the
// individual interventions for any chosen rule.
//
// Two lenses on the same events, because they answer different questions.
// "By rule" is a question about the CONFIGURATION — which rules earn their
// keep, which never fire. "By person" is a question about BEHAVIOUR: one
// person accounting for every PII block in the window is invisible in a rule
// rollup, and it is the thing you actually want to know when someone starts
// probing for salaries. The join was always available and had never been
// made — interventions carry the invocation id, and traces have carried
// `user_id` since sprint 2.
//
// Data sources (all under /api/observability/guardrails-detail):
//   GET /by-rule?windowHours=             — top rules + severity counts
//   GET /by-actor?windowHours=&limit=     — who tripped them, named
//   GET /interventions?ruleName=&limit=   — drill-down for one rule

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Button, Card, CardHeader, Chip, DataTable, EntityCell, Inline, PageSection,
  SegmentedControl, Table, TableHead, TableBody, TableRow, TableTh, TableTd,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { GuardrailRuleBadge } from '../../components/observability/GuardrailRuleBadge';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { firstDegraded } from '../../lib/degraded';
import { T } from './Text';
import { RowEmpty } from './ReadState';
import { WindowPicker, useWindowUrlState } from './WindowPicker';
import { relativeTime } from '../../lib/relativeTime';

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

interface ByActorEntry {
  userId: string;
  userName: string | null;
  interventions: number;
  blocked: number;
  anonymized: number;
  uniqueRules: number;
  uniqueAgents: number;
  topRule: string | null;
  topRuleCategory: string | null;
  highSeverity: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface ByActorResponse {
  actors: ByActorEntry[];
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

type Lens = 'rule' | 'person';

/** ?lens=rule|person. Mirrors WindowPicker's `?window=` so both survive a link. */
function useLensUrlState(): [Lens, (l: Lens) => void] {
  const [params, setParams] = useSearchParams();
  const lens: Lens = params.get('lens') === 'person' ? 'person' : 'rule';
  const set = (next: Lens) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === 'rule') p.delete('lens'); else p.set('lens', next);
      return p;
    }, { replace: true });
  };
  return [lens, set];
}

function GuardrailRulesPage() {
  const [windowIdx, setWindowIdx] = useWindowUrlState(WINDOW_OPTIONS, 2); // 24h, ?window=
  const win = WINDOW_OPTIONS[windowIdx];

  const { data, error, refresh } = useFetch<ByRuleResponse>(
    `/api/observability/guardrails-detail/by-rule?windowHours=${win.hours}`,
    30_000,
  );
  const rules = useMemo<ByRuleEntry[]>(() => data?.byRule ?? [], [data]);
  const totalFires = useMemo(
    () => rules.reduce((acc, r) => acc + r.count, 0),
    [rules],
  );

  // ?lens=rule|person — in the URL, like every other lens in this app, so the
  // view someone is looking at survives a link.
  const [lens, setLens] = useLensUrlState();

  const { data: actorData, refresh: refreshActors } = useFetch<ByActorResponse>(
    lens === 'person'
      ? `/api/observability/guardrails-detail/by-actor?windowHours=${win.hours}&limit=50`
      : '',
    30_000,
  );
  const actors = useMemo<ByActorEntry[]>(() => actorData?.actors ?? [], [actorData]);

  const [selectedRule, setSelectedRule] = useState<string | null>(null);
  const interventionsUrl = selectedRule
    ? `/api/observability/guardrails-detail/interventions?ruleName=${encodeURIComponent(selectedRule)}&limit=50`
    : '';
  const { data: intData } = useFetch<InterventionsResponse>(interventionsUrl, 30_000);
  const interventions = useMemo<GuardrailIntervention[]>(
    () => intData?.interventions ?? [],
    [intData],
  );

  // "No interventions yet" is a RELIEF on this page — it says the guardrails
  // are quiet. That makes it exactly the wrong thing to render when the query
  // that would have found them failed.
  const guardrailsDegraded = firstDegraded(data, intData, actorData);

  const actorColumns: DataTableColumn<ByActorEntry>[] = [
    {
      key: 'userName',
      header: 'Person',
      sortable: true,
      // The name, because "u-caleb tripped PROMPT_ATTACK five times" is a
      // riddle and "Caleb Turner" is a finding. The id stays underneath: it is
      // what you need to search a log with.
      render: (a) => <EntityCell label={a.userName ?? a.userId} id={a.userId} />,
    },
    {
      key: 'topRule',
      header: 'Mostly tripped',
      render: (a) => (
        a.topRule ? (
          <Inline gap="xs" align="center" wrap>
            <T className="font-mono text-[12px] text-text-primary">{a.topRule}</T>
            {a.topRuleCategory && (
              <Chip tone={categoryTone(a.topRuleCategory)} size="xs">{a.topRuleCategory}</Chip>
            )}
          </Inline>
        ) : <T className="text-[11px] text-text-tertiary">—</T>
      ),
    },
    {
      key: 'interventions',
      header: 'Times',
      align: 'right',
      sortable: true,
      render: (a) => <T className="tabular-nums text-[12px]">{a.interventions}</T>,
    },
    {
      key: 'blocked',
      header: 'Blocked',
      align: 'right',
      sortable: true,
      // Blocked and anonymized are different events: one refused the request,
      // the other served it with the sensitive part removed. Summing them into
      // a single "interventions" number hides which happened.
      render: (a) => (
        <T className={`tabular-nums text-[12px] ${a.blocked > 0 ? 'text-danger' : 'text-text-tertiary'}`}>{a.blocked}</T>
      ),
    },
    {
      key: 'anonymized',
      header: 'Anonymized',
      align: 'right',
      render: (a) => <T className="tabular-nums text-[12px] text-text-secondary">{a.anonymized}</T>,
    },
    {
      key: 'highSeverity',
      header: 'High',
      align: 'right',
      sortable: true,
      render: (a) => (
        a.highSeverity > 0
          ? <Chip tone="danger" size="xs">{a.highSeverity}</Chip>
          : <T className="tabular-nums text-[12px] text-text-tertiary">0</T>
      ),
    },
    {
      key: 'uniqueRules',
      header: 'Rules',
      align: 'right',
      // Distinct rules is the probing signal: one person hitting one rule
      // repeatedly is usually doing their job badly, and one person hitting
      // four different rules is looking for the edges.
      render: (a) => <T className="tabular-nums text-[12px] text-text-secondary">{a.uniqueRules}</T>,
    },
    {
      key: 'lastSeenAt',
      header: 'Last',
      sortable: true,
      render: (a) => (
        <T className="whitespace-nowrap text-[11.5px] text-text-secondary" title={new Date(a.lastSeenAt).toLocaleString()}>
          {relativeTime(a.lastSeenAt)}
        </T>
      ),
    },
    {
      key: 'go',
      header: '',
      // Every row references a person, so every row links to their requests.
      // Search rather than Traffic: Traffic lists top users but accepts no
      // userId filter, so linking there would land on an unfiltered page.
      render: (a) => (
        <Link
          to={`/admin/observability/invocations/search?userId=${encodeURIComponent(a.userId)}`}
          className="whitespace-nowrap text-[12px] font-medium text-primary no-underline hover:underline"
        >
          Their requests →
        </Link>
      ),
    },
  ];

  return (
    <PageSection
      title="Guardrail Rules"
      description={lens === 'person'
        ? `${actors.length} ${actors.length === 1 ? 'person' : 'people'} tripped a guardrail · last ${win.label}`
        : `${totalFires} intervention${totalFires === 1 ? '' : 's'} across ${rules.length} rule${rules.length === 1 ? '' : 's'} · last ${win.label}`}
      actions={(
        <Inline align="center" gap="md">
          <SegmentedControl
            size="sm"
            aria-label="Group interventions by"
            value={lens}
            onChange={(v) => { setLens(v as Lens); setSelectedRule(null); }}
            options={[{ label: 'By rule', value: 'rule' }, { label: 'By person', value: 'person' }]}
          />
          <WindowPicker options={WINDOW_OPTIONS} value={windowIdx} onChange={(i) => { setWindowIdx(i); setSelectedRule(null); }} />
        </Inline>
      )}
    >
      {(error || guardrailsDegraded) && (
        <UnavailableNotice
          error={error ?? guardrailsDegraded ?? 'the guardrail query failed'}
          what="guardrail interventions"
          source="Interventions are read from the Aurora observability tables"
          onRetry={refresh}
          className="mb-4"
        />
      )}

      {lens === 'person' ? (
        <Card padding="md">
          {actors.length === 0 ? (
            <SmartEmptyState
              title="Nobody has tripped a guardrail"
              detail="This lists the people whose requests a guardrail acted on. It stays empty while nothing is being blocked or anonymized — which on this page is the good outcome. Calls with no signed-in actor (a schedule, or one agent calling another) are left out rather than grouped under an invented user."
              degraded={guardrailsDegraded}
              degradedWhat="the per-person rollup"
              degradedSource="Interventions are joined to traces in the Aurora observability tables"
              onRetry={refreshActors}
            />
          ) : (
            <DataTable<ByActorEntry>
              data={actors}
              keyField={(a) => a.userId}
              striped
              columns={actorColumns}
            />
          )}
        </Card>
      ) : (
      <Card padding="md">
        {rules.length === 0 ? (
          <SmartEmptyState
            title="No interventions yet"
            detail="Rules surface here as soon as Bedrock Guardrails fires a block or anonymize action."
            degraded={guardrailsDegraded}
            degradedWhat="the guardrail rule rollup"
            degradedSource="Interventions are read from the Aurora observability tables"
            onRetry={refresh}
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
      )}

      {lens === 'rule' && selectedRule && (
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
            <RowEmpty text="No interventions captured for this rule yet." degraded={guardrailsDegraded} />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Agent</TableTh>
                  <TableTh>When</TableTh>
                  <TableTh>Rule</TableTh>
                  <TableTh>Matched text</TableTh>
                  <TableTh></TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {interventions.map((i) => (
                  <TableRow key={i.interventionId}>
                    <TableTd className="text-[12px] font-medium whitespace-nowrap">{i.agentId}</TableTd>
                    <TableTd className="text-[11px] text-text-tertiary whitespace-nowrap">
                      {new Date(i.ts).toLocaleString()}
                    </TableTd>
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
                          className="px-2 py-0.5 text-[12px] text-primary no-underline"
                          title="Open invocation detail"
                        >
                          Open
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

export default GuardrailRulesPage;
