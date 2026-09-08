// CanaryPage — live canary topology + scenario runner.
//
// Top toolbar: status pill, last-judged timestamp, HaltButton, debug toggle,
//   "Scenarios" toggle button.
// Bottom drawer: scenario table — generate from graph people, run all/individual,
//   see version picked + live score per row.
// Right rail: DecisionHistoryPanel.

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
} from '@xyflow/react';
import type { Node, Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Inline,
  Select,
  Stack,
  StatusPill,
  Switch,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
  ThinkingDots,
  Toolbar,
} from '@connorhoehnslalom/ui-components/shared';
import { T } from './Text';
import { nodeTypes, edgeTypes } from '../components/canary/index.js';
import { useCanaryStream } from '../components/canary/useCanaryStream.js';
import {
  setManualSliderOpen,
  resetExperiment,
  useCanaryEdges,
  useCanaryNodes,
  useCanaryStore,
} from '../components/canary/canaryStore.js';
import { useCapabilities } from '../lib/capabilities';
import { HaltButton } from '../components/canary/HaltButton.js';
import { ManualWeightSlider } from '../components/canary/ManualWeightSlider.js';
import { DecisionHistoryPanel } from '../components/canary/DecisionHistoryPanel.js';
import { ExperimentCompleteBanner } from '../components/canary/ExperimentCompleteBanner.js';
import { CanaryDeploymentsView } from '../components/canary/CanaryDeploymentsView.js';

const CanarySetupFlow = React.lazy(() =>
  import('../components/canary/setup/CanarySetupFlow.js').then((m) => ({ default: m.CanarySetupFlow })),
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface PersonEntity {
  id: string;
  name: string;
  title?: string;
  department?: string;
  skills?: string[];
}

type RowPhase = 'idle' | 'running' | 'done' | 'error';

interface ScenarioRow {
  key: string;
  personName: string;
  personMeta: string;   // subtitle shown in table (title · dept)
  topic: string;
  summary: string;
  phase: RowPhase;
  version: 'A' | 'B' | null;
  requestId: string | null;
  errorMsg: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TOPICS = [
  'expertise assessment',
  'collaboration patterns',
  'skills overview',
  'technical leadership',
  'project contributions',
  'knowledge sharing',
  'team impact',
  'technical depth',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSummary(p: PersonEntity): string {
  const parts: string[] = [];
  if (p.title) parts.push(p.title);
  if (p.department) parts.push(p.department);
  if (p.skills?.length) parts.push(`Skills: ${p.skills.slice(0, 4).join(', ')}`);
  return parts.join('. ');
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function runScenario(
  row: ScenarioRow,
  onMeta: (version: 'A' | 'B', requestId: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/observability/canary/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      person_name: row.personName,
      topic: row.topic,
      summary: row.summary,
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        if (ev['type'] === 'meta') {
          onMeta(ev['version'] as 'A' | 'B', ev['request_id'] as string);
        } else if (ev['type'] === 'error') {
          throw new Error((ev['message'] as string) ?? 'Unknown error');
        }
      } catch (parseErr) {
        if ((parseErr as Error).message !== 'Unexpected end of JSON input') {
          throw parseErr;
        }
      }
    }
  }
}

// ── ScenarioPanel ─────────────────────────────────────────────────────────────

function ScenarioPanel({ open }: { open: boolean }): React.ReactElement | null {
  const uid = useId();
  const [rows, setRows] = useState<ScenarioRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState(8);
  const aborts = useRef<Map<string, AbortController>>(new Map());
  // Keep a stable ref to rows so callbacks don't capture stale closures.
  const rowsRef = useRef<ScenarioRow[]>([]);
  rowsRef.current = rows;
  const judgeScores = useCanaryStore((s) => s.recentJudgeScores);

  const generate = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/graph/entities?type=person&limit=100');
      const json = (await res.json()) as { nodes?: PersonEntity[] };
      const people = shuffle(json.nodes ?? []).slice(0, count);
      const newRows: ScenarioRow[] = people.map((p, i) => ({
        key: `${uid}-${i}-${p.id}`,
        personName: p.name,
        personMeta: [p.title, p.department].filter(Boolean).join(' · '),
        topic: TOPICS[i % TOPICS.length],
        summary: makeSummary(p),
        phase: 'idle',
        version: null,
        requestId: null,
        errorMsg: '',
      }));
      setRows(newRows);
    } finally {
      setLoading(false);
    }
  }, [count, uid]);

  // Separated from state update — starts the SSE fetch for one row.
  const startFetch = useCallback((key: string, row: ScenarioRow) => {
    aborts.current.get(key)?.abort();
    const ctrl = new AbortController();
    aborts.current.set(key, ctrl);
    void runScenario(
      row,
      (version, requestId) => setRows((r) => r.map((x) => x.key === key ? { ...x, version, requestId } : x)),
      ctrl.signal,
    )
      .then(() => setRows((r) => r.map((x) => x.key === key && x.phase === 'running' ? { ...x, phase: 'done' } : x)))
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        setRows((r) => r.map((x) => x.key === key ? { ...x, phase: 'error', errorMsg: err.message } : x));
      });
  }, []);

  // Read from ref so these callbacks are stable (no rows dependency).
  const runRow = useCallback((key: string) => {
    const row = rowsRef.current.find((r) => r.key === key);
    if (!row || row.phase === 'running') return;
    const updated = { ...row, phase: 'running' as RowPhase, version: null as null, requestId: null as null, errorMsg: '' };
    setRows((prev) => prev.map((r) => r.key === key ? updated : r));
    startFetch(key, updated);
  }, [startFetch]);

  const runAll = useCallback(() => {
    const toStart = rowsRef.current.filter((r) => r.phase === 'idle' || r.phase === 'error');
    const updates = new Map(toStart.map((r) => [
      r.key,
      { ...r, phase: 'running' as RowPhase, version: null as null, requestId: null as null, errorMsg: '' },
    ]));
    if (updates.size === 0) return;
    setRows((prev) => prev.map((r) => updates.get(r.key) ?? r));
    updates.forEach((updated, key) => startFetch(key, updated));
  }, [startFetch]);

  const clearRows = useCallback(() => {
    aborts.current.forEach((ctrl) => ctrl.abort());
    aborts.current.clear();
    setRows([]);
  }, []);

  const resetRow = useCallback((key: string) => {
    aborts.current.get(key)?.abort();
    aborts.current.delete(key);
    setRows((prev) => prev.map((r) => r.key === key ? { ...r, phase: 'idle', version: null, requestId: null, errorMsg: '' } : r));
  }, []);

  if (!open) return null;

  const anyIdle = rows.some((r) => r.phase === 'idle' || r.phase === 'error');
  const anyRunning = rows.some((r) => r.phase === 'running');

  return (
    <Stack gap="none" className="min-h-0 max-h-[320px] flex-shrink-0 border-t border-border bg-surface">
      {/* Toolbar row */}
      <Toolbar
        aria-label="Scenario controls"
        end={
          <Inline gap="sm" align="center">
            {rows.length > 0 && (
              <>
                <Button variant="primary" size="sm" onClick={runAll} disabled={!anyIdle}>▶ Run all</Button>
                <Button variant="ghost" size="sm" onClick={clearRows}>Clear</Button>
              </>
            )}
            {anyRunning && (
              <T className="text-[11px] italic text-text-tertiary">Running…</T>
            )}
          </Inline>
        }
      >
        <Inline as="label" gap="xs" align="center" className="text-[11px] text-text-secondary">
          Scenarios:
          <Select
            value={String(count)}
            onChange={(e) => setCount(Number(e.target.value))}
            options={[4, 6, 8, 10, 16, 20].map((n) => ({ value: String(n), label: String(n) }))}
            size="sm"
            aria-label="Scenario count"
          />
        </Inline>
        <Button variant="secondary" size="sm" onClick={() => { void generate(); }} disabled={loading}>
          {loading ? 'Loading…' : '⟳ Generate from graph'}
        </Button>
      </Toolbar>

      {/* Table */}
      {rows.length === 0 ? (
        <EmptyState
          title="No scenarios yet"
          body='Click "Generate from graph" to load people from the knowledge graph and create scenarios.'
        />
      ) : (
        <Stack gap="none" className="flex-1 overflow-y-auto overflow-x-hidden">
          <Table className="w-full border-collapse text-[12px]">
            <TableHead>
              <TableRow className="sticky top-0 z-[1]">
                <TableTh className="w-[180px]">Person</TableTh>
                <TableTh className="w-[160px]">Topic</TableTh>
                <TableTh className="w-[52px] text-center">Ver</TableTh>
                <TableTh className="w-[60px] text-center">Score</TableTh>
                <TableTh className="w-[220px] text-left">Status</TableTh>
                <TableTh>Run</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => {
                const score = row.requestId ? judgeScores[row.requestId] : undefined;
                return (
                  <ScenarioTableRow
                    key={row.key}
                    row={row}
                    score={score}
                    onRun={() => runRow(row.key)}
                    onReset={() => resetRow(row.key)}
                  />
                );
              })}
            </TableBody>
          </Table>
        </Stack>
      )}
    </Stack>
  );
}

function ScenarioTableRow({
  row,
  score,
  onRun,
  onReset,
}: {
  row: ScenarioRow;
  score: number | undefined;
  onRun: () => void;
  onReset: () => void;
}): React.ReactElement {
  const rowBg = row.phase === 'running' ? 'bg-primary/5'
    : row.phase === 'done' ? 'bg-success/5'
    : row.phase === 'error' ? 'bg-danger/5'
    : '';

  return (
    <TableRow className={rowBg}>
      {/* Person */}
      <TableTd>
        <Stack gap="none">
          <T className="font-medium leading-[1.3] text-text-primary">{row.personName}</T>
          {row.personMeta && (
            <T className="mt-px text-[10px] text-text-tertiary">{row.personMeta}</T>
          )}
        </Stack>
      </TableTd>
      {/* Topic */}
      <TableTd className="text-text-secondary">
        {row.topic}
      </TableTd>
      {/* Version */}
      <TableTd className="text-center">
        {row.version ? (
          <Chip tone={row.version === 'B' ? 'accent' : 'info'} size="xs">
            {row.version}
          </Chip>
        ) : <T className="text-text-tertiary">—</T>}
      </TableTd>
      {/* Score */}
      <TableTd className="text-center tabular-nums">
        {score !== undefined ? (
          <T className={`text-[12px] font-semibold ${score >= 0.7 ? 'text-success' : score >= 0.4 ? 'text-warning' : 'text-danger'}`}>
            {score.toFixed(2)}
          </T>
        ) : row.phase === 'running' ? (
          <ThinkingDots size="sm" color="var(--color-primary)" />
        ) : (
          <T className="text-text-tertiary">—</T>
        )}
      </TableTd>
      {/* Status */}
      <TableTd className="align-top">
        <StatusPip phase={row.phase} hasScore={score !== undefined} errorMsg={row.errorMsg} />
      </TableTd>
      {/* Run button */}
      <TableTd>
        {row.phase === 'idle' && (
          <Button variant="secondary" size="sm" onClick={onRun}>Run</Button>
        )}
        {row.phase === 'running' && (
          <T className="text-[10px] text-text-tertiary">Running</T>
        )}
        {(row.phase === 'done' || row.phase === 'error') && (
          <Button variant="ghost" size="sm" onClick={onReset}>Reset</Button>
        )}
      </TableTd>
    </TableRow>
  );
}

function StatusPip({ phase, hasScore, errorMsg }: { phase: RowPhase; hasScore: boolean; errorMsg: string }): React.ReactElement {
  if (phase === 'idle') return <T className="text-[10px] text-text-tertiary">idle</T>;
  if (phase === 'error') return (
    <Stack gap="none" align="start">
      <T className="text-[10px] font-semibold text-danger">● error</T>
      {errorMsg && (
        <T className="mt-0.5 max-w-[200px] text-[10px] leading-[1.4] text-danger/80" wrap>
          {errorMsg}
        </T>
      )}
    </Stack>
  );
  if (phase === 'running') return <T className="text-[10px] text-primary">streaming</T>;
  // done
  if (!hasScore) return <T className="text-[10px] text-warning">judging…</T>;
  return <T className="text-[10px] font-semibold text-success">✓ scored</T>;
}

// ── Focus map ─────────────────────────────────────────────────────────────────
// Maps ?focus= param values (from canaryNavItems) → viewport center in graph coords.
// Node positions from canaryStore POSITIONS + rough half-height offset.

const FOCUS_CENTERS: Record<string, { x: number; y: number }> = {
  'subject-a': { x: -260 + 60, y: 290 + 50 },
  'subject-b': { x:  260 + 60, y: 290 + 50 },
  'judge':     { x:      0 + 60, y: 580 + 50 },
  'weight':    { x:      0 + 60, y: 140 + 50 },
  'status':    { x:      0 + 60, y: 860 + 50 },
  'traffic':   { x:      0 + 60, y:   0 + 50 },
  'decisions': { x:      0 + 60, y: 860 + 50 },
};

// ── CanaryFlowInner ───────────────────────────────────────────────────────────
// Must be inside ReactFlowProvider to use useReactFlow().

function CanaryFlowInner({
  focusId,
  nodes,
  edges,
}: {
  focusId: string | null;
  nodes: Node[];
  edges: Edge[];
}): React.ReactElement {
  const { setCenter } = useReactFlow();
  const prevFocusId = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || focusId === prevFocusId.current) return;
    prevFocusId.current = focusId;
    const center = FOCUS_CENTERS[focusId];
    if (center) setCenter(center.x, center.y, { zoom: 1.4, duration: 400 });
  }, [focusId, setCenter]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
    >
      <Background />
      <Controls showInteractive={false} />
      <MiniMap
        className="!w-[120px] !h-[80px]"
        nodeColor="var(--color-brand)"
        maskColor="rgba(0,0,0,0.06)"
        pannable
        zoomable
      />
    </ReactFlow>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function CanaryPage(): React.ReactElement {
  useCanaryStream();
  // Start/reset/halt/weight all require Cedar's ManageCanary — the same
  // action the /api/observability/canary mutations enforce.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageCanary');
  const experimentState = useCanaryStore((s) => s.experimentState);
  const debug = useCanaryStore((s) => s.manualSliderOpen);
  const halted = useCanaryStore((s) => s.halted);
  const lastJudgedAt = useCanaryStore((s) => s.lastJudgedAt);
  const nodes = useCanaryNodes();
  const edges = useCanaryEdges();
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get('focus');

  // ── Deployments / history view ───────────────────────────────────────────────
  // ?focus=decisions bypasses the wizard and the live graph entirely. It shows
  // a full-page table of past controller decisions (from Aurora via SSE replay).
  if (focusId === 'decisions') {
    return (
      <Stack gap="none" className="h-full min-h-0 w-full">
        <CanaryDeploymentsView />
      </Stack>
    );
  }

  // ── Setup phase ─────────────────────────────────────────────────────────────
  if (experimentState === 'setup') {
    return (
      <Stack gap="none" className="h-full min-h-0 w-full">
        <Toolbar aria-label="Canary setup">
          <Inline gap="sm" align="baseline">
            <T className="text-sm font-bold text-text-primary">Canary</T>
            <T className="text-xs text-text-tertiary">Configure a new experiment</T>
          </Inline>
        </Toolbar>
        <Stack align="center" justify="center" className="min-h-0 flex-1 bg-bg p-6">
          {canManage ? (
            <React.Suspense fallback={<T className="text-[13px] text-text-tertiary">Loading…</T>}>
              <CanarySetupFlow onStarted={() => { /* store handles state transition */ }} />
            </React.Suspense>
          ) : (
            <Inline as="p" gap="none" className="m-0 max-w-[380px] text-center text-[13px] leading-relaxed text-text-tertiary">
              No experiment is running. Viewing only — your role can&apos;t start a canary experiment.
            </Inline>
          )}
        </Stack>
      </Stack>
    );
  }

  // ── Terminal phase ──────────────────────────────────────────────────────────
  if (experimentState === 'terminal') {
    return (
      <Stack gap="none" className="h-full min-h-0 w-full">
        <Inline gap="none" align="stretch" wrap={false} className="min-h-0 flex-1">
          <Stack gap="none" className="min-h-0 min-w-0 flex-1">
            <ExperimentCompleteBanner onReset={() => { /* store handles reset */ }} />
            <Stack gap="none" className="relative min-h-0 flex-1 opacity-70">
              <ReactFlowProvider>
                <CanaryFlowInner focusId={focusId} nodes={nodes} edges={edges} />
              </ReactFlowProvider>
            </Stack>
          </Stack>
          <DecisionHistoryPanel />
        </Inline>
      </Stack>
    );
  }

  // ── Running phase (default) ─────────────────────────────────────────────────
  return (
    <Stack gap="none" className="h-full min-h-0 w-full">
      <CanaryToolbar
        halted={halted}
        lastJudgedAt={lastJudgedAt}
        debug={debug}
        onDebugChange={setManualSliderOpen}
        scenariosOpen={scenariosOpen}
        onScenariosToggle={() => setScenariosOpen((v) => !v)}
        canManage={canManage}
      />
      <Inline gap="none" align="stretch" wrap={false} className="min-h-0 flex-1">
        <Stack gap="none" className="min-h-0 min-w-0 flex-1">
          <Stack gap="none" className="relative min-h-0 flex-1">
            <ReactFlowProvider>
              <CanaryFlowInner focusId={focusId} nodes={nodes} edges={edges} />
            </ReactFlowProvider>
            {/* First-run guidance: a resumed/new experiment with no judgements
                yet is just an empty diagram — point straight at the next step
                instead of assuming the operator knows the Scenarios flow. */}
            {!lastJudgedAt && !scenariosOpen && (
              <Stack align="center" justify="center" className="pointer-events-none absolute inset-0 z-10">
                <Card padding="md" className="pointer-events-auto max-w-[380px] text-center shadow-lg">
                  <T className="text-sm font-bold text-text-primary">
                    Experiment is live — no traffic yet
                  </T>
                  <Inline as="p" gap="none" className="mt-2 mb-0 text-[12.5px] leading-relaxed text-text-secondary">
                    The router splits traffic A/B and the judge scores every answer,
                    but nothing flows until you send requests. Generate test scenarios from your
                    org graph and run them to see scores and controller decisions appear.
                  </Inline>
                  <Button
                    variant="primary"
                    size="md"
                    className="mt-3.5"
                    onClick={() => setScenariosOpen(true)}
                  >
                    ▶ Generate scenarios
                  </Button>
                </Card>
              </Stack>
            )}
          </Stack>
          <ScenarioPanel open={scenariosOpen} />
        </Stack>
        <DecisionHistoryPanel />
      </Inline>
    </Stack>
  );
}

function CanaryToolbar({
  halted,
  lastJudgedAt,
  debug,
  onDebugChange,
  scenariosOpen,
  onScenariosToggle,
  canManage,
}: {
  halted: boolean;
  lastJudgedAt: string | undefined;
  debug: boolean;
  onDebugChange: (v: boolean) => void;
  scenariosOpen: boolean;
  onScenariosToggle: () => void;
  /** ManageCanary — controls that mutate the experiment hide without it. */
  canManage: boolean;
}): React.ReactElement {
  return (
    <Toolbar
      aria-label="Canary controls"
      end={
        <Inline gap="sm" align="center">
          {canManage && (
            <>
              {debug && <ManualWeightSlider />}
              <Inline gap="xs" align="center">
                <Switch checked={debug} onChange={onDebugChange} aria-label="Debug" size="sm" />
                <T className="text-[11px] text-text-secondary">Debug</T>
              </Inline>
              <Button
                variant="secondary"
                size="sm"
                title="End this experiment and return to the setup wizard (traffic pins back to A)"
                onClick={() => {
                  if (!window.confirm('End this experiment and start a new one?\nTraffic pins back to 100% A; decision history is kept.')) return;
                  void fetch('/api/observability/canary/reset', { method: 'POST', credentials: 'include' })
                    .catch(() => { /* store reset still returns the UI to the wizard */ })
                    .finally(() => resetExperiment());
                }}
              >
                ＋ New experiment
              </Button>
              {!halted && <HaltButton />}
            </>
          )}
          <Button
            variant={scenariosOpen ? 'primary' : 'ghost'}
            size="sm"
            onClick={onScenariosToggle}
          >
            {scenariosOpen ? '✕ Scenarios' : '▶ Scenarios'}
          </Button>
        </Inline>
      }
    >
      <Inline gap="md" align="center">
        <StatusPill state={halted ? 'error' : 'success'} label={halted ? 'Halted' : 'Active'} size="sm" />
        <T className="text-[11px] text-text-tertiary">
          {lastJudgedAt ? `Last judged ${new Date(lastJudgedAt).toLocaleTimeString()}` : 'Awaiting first judgement…'}
        </T>
      </Inline>
    </Toolbar>
  );
}

export default CanaryPage;
