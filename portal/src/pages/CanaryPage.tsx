// CanaryPage — live canary topology + scenario runner.
//
// Top toolbar: status pill, last-judged timestamp, HaltButton, debug toggle,
//   "Scenarios" toggle button.
// Bottom drawer: scenario table — generate from graph people, run all/individual,
//   see version picked + live score per row.
// Right rail: DecisionHistoryPanel.

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { relativeTime } from '../lib/relativeTime';
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
  ConfirmDialog,
  DataTable,
  EmptyState,
  Inline,
  LoadingState,
  Select,
  Stack,
  StatusPill,
  Switch,
  ThinkingDots,
  Toolbar, T, VisuallyHidden,
} from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { nodeTypes, edgeTypes } from '../components/canary/index.js';
import { useCanaryStream } from '../components/canary/useCanaryStream.js';
import { toastError } from '../lib/toastStore';
import { writeJson } from '../lib/writeJson';
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
          <DataTable<ScenarioRowWithScore>
            data={rows.map((row) => ({ ...row, score: row.requestId ? judgeScores[row.requestId] : undefined }))}
            keyField={(row) => row.key}
            className="text-[12px]"
            columns={scenarioColumns(runRow, resetRow)}
          />
        </Stack>
      )}
    </Stack>
  );
}

interface ScenarioRowWithScore extends ScenarioRow {
  score: number | undefined;
}

function scenarioColumns(onRun: (key: string) => void, onReset: (key: string) => void): DataTableColumn<ScenarioRowWithScore>[] {
  return [
    {
      key: 'person',
      header: 'Person',
      width: '180px',
      getFilterText: (row) => row.personName,
      render: (row) => (
        <Stack gap="none">
          <T className="font-medium leading-[1.3] text-text-primary">{row.personName}</T>
          {row.personMeta && (
            <T className="mt-px text-[10px] text-text-tertiary">{row.personMeta}</T>
          )}
        </Stack>
      ),
    },
    {
      key: 'topic',
      header: 'Topic',
      width: '160px',
      className: 'text-text-secondary',
      render: (row) => row.topic,
    },
    {
      key: 'version',
      header: 'Ver',
      width: '52px',
      align: 'center',
      render: (row) => row.version ? (
        <Chip tone={row.version === 'B' ? 'accent' : 'info'} size="xs">
          {row.version}
        </Chip>
      ) : <T className="text-text-tertiary">—</T>,
    },
    {
      key: 'score',
      header: 'Score',
      width: '60px',
      align: 'center',
      className: 'tabular-nums',
      render: (row) => row.score !== undefined ? (
        <T className={`text-[12px] font-semibold ${row.score >= 0.7 ? 'text-success' : row.score >= 0.4 ? 'text-warning' : 'text-danger'}`}>
          {row.score.toFixed(2)}
        </T>
      ) : row.phase === 'running' ? (
        <ThinkingDots size="sm" className="text-primary" />
      ) : (
        <T className="text-text-tertiary">—</T>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '220px',
      className: 'align-top',
      render: (row) => <ScenarioStatus phase={row.phase} hasScore={row.score !== undefined} errorMsg={row.errorMsg} />,
    },
    {
      key: 'run',
      header: 'Run',
      render: (row) => (
        <>
          {row.phase === 'idle' && (
            <Button variant="secondary" size="sm" onClick={() => onRun(row.key)}>Run</Button>
          )}
          {row.phase === 'running' && (
            <T className="text-[10px] text-text-tertiary">Running</T>
          )}
          {(row.phase === 'done' || row.phase === 'error') && (
            <Button variant="ghost" size="sm" onClick={() => onReset(row.key)}>Reset</Button>
          )}
        </>
      ),
    },
  ];
}

function ScenarioStatus({ phase, hasScore, errorMsg }: { phase: RowPhase; hasScore: boolean; errorMsg: string }): React.ReactElement {
  if (phase === 'idle') return <StatusPill state="neutral" label="idle" size="sm" />;
  if (phase === 'error') return (
    <Stack gap="none" align="start">
      <StatusPill state="error" label="error" size="sm" />
      {errorMsg && (
        <T className="mt-0.5 max-w-[200px] text-[10px] leading-[1.4] text-danger/80" wrap>
          {errorMsg}
        </T>
      )}
    </Stack>
  );
  if (phase === 'running') return <StatusPill state="pending" label="streaming" size="sm" />;
  // done
  if (!hasScore) return <StatusPill state="warning" label="judging…" size="sm" />;
  return <StatusPill state="success" label="scored" size="sm" />;
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

function CanaryWorkspace(): React.ReactElement {
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
            <React.Suspense fallback={<LoadingState label="Loading setup…" />}>
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
  const [confirmNewExperiment, setConfirmNewExperiment] = useState(false);
  const [resetting, setResetting] = useState(false);

  const confirmNewExperimentAction = useCallback(async () => {
    setResetting(true);
    const res = await writeJson('/api/observability/canary/reset', 'POST');
    if (!res.ok) {
      toastError(null, 'Could not end experiment', res.error ?? `HTTP ${res.status}`);
    } else {
      resetExperiment();
    }
    setResetting(false);
    setConfirmNewExperiment(false);
  }, []);

  return (
    <Stack gap="sm">
      <Toolbar
        aria-label="Canary controls"
        wrap
        end={
          <Inline gap="sm" align="center" wrap>
            {canManage && (
              // Debug-only controls (weight slider, debug switch, "+ New
              // experiment", Halt). `Toolbar`'s `wrap` drops `end` to its own
              // line when the row won't fit, so these stay inline at every
              // width instead of needing a breakpoint-gated duplicate.
              <Inline gap="sm" align="center">
                {debug && <ManualWeightSlider />}
                <Inline gap="xs" align="center">
                  <Switch checked={debug} onChange={onDebugChange} aria-label="Debug" size="sm" />
                  <T className="text-[11px] text-text-secondary">Debug</T>
                </Inline>
                <Button
                  variant="secondary"
                  size="sm"
                  title="End this experiment and return to the setup wizard (traffic pins back to A)"
                  onClick={() => setConfirmNewExperiment(true)}
                >
                  ＋ New experiment
                </Button>
                {!halted && <HaltButton />}
              </Inline>
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
            {lastJudgedAt ? `Last judged ${relativeTime(lastJudgedAt)}` : 'Awaiting first judgement…'}
          </T>
        </Inline>
      </Toolbar>

      <ConfirmDialog
        open={confirmNewExperiment}
        tone="destructive"
        title="End this experiment and start a new one?"
        body="Traffic pins back to 100% A; decision history is kept."
        confirmLabel={resetting ? 'Ending…' : 'End experiment'}
        confirmDisabled={resetting}
        onConfirm={() => void confirmNewExperimentAction()}
        onCancel={() => setConfirmNewExperiment(false)}
      />
    </Stack>
  );
}

// The page title follows the trail (docs/layout-cascade.md rule 3); the
// workspace's own toolbar names the phase, so the h1 is for assistive tech.
function CanaryPage(): React.ReactElement {
  return (
    <>
      <VisuallyHidden as="h1">Rollout</VisuallyHidden>
      <CanaryWorkspace />
    </>
  );
}

export default CanaryPage;
