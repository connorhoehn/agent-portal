// CanaryPage — live canary topology + scenario runner.
//
// Top toolbar: status pill, last-judged timestamp, HaltButton, debug toggle,
//   "Scenarios" toggle button.
// Bottom drawer: scenario table — generate from graph people, run all/individual,
//   see version picked + live score per row.
// Right rail: DecisionHistoryPanel.

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
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
import { ThinkingDots } from '@connorhoehnslalom/ui-components/shared';
import { nodeTypes, edgeTypes } from '../components/canary/index.js';
import { useCanaryStream } from '../components/canary/useCanaryStream.js';
import {
  setManualSliderOpen,
  resetExperiment,
  useCanaryEdges,
  useCanaryNodes,
  useCanaryStore,
} from '../components/canary/canaryStore.js';
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
    <div style={panelStyle}>
      {/* Toolbar row */}
      <div style={panelToolbarStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={countLabelStyle}>
            Scenarios:
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              style={selectStyle}
            >
              {[4, 6, 8, 10, 16, 20].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <button style={genBtnStyle} onClick={() => { void generate(); }} disabled={loading}>
            {loading ? 'Loading…' : '⟳ Generate from graph'}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {rows.length > 0 && (
            <>
              <button
                style={{ ...actionBtnStyle, opacity: anyIdle ? 1 : 0.45, cursor: anyIdle ? 'pointer' : 'not-allowed' }}
                onClick={runAll}
                disabled={!anyIdle}
              >
                ▶ Run all
              </button>
              <button style={{ ...actionBtnStyle, background: 'transparent', color: 'var(--color-text-secondary, #475569)' }} onClick={clearRows}>
                Clear
              </button>
            </>
          )}
          {anyRunning && (
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary, #94a3b8)', fontStyle: 'italic' }}>
              Running…
            </span>
          )}
        </div>
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <div style={emptyStyle}>
          Click "Generate from graph" to load people from the knowledge graph and create scenarios.
        </div>
      ) : (
        <div style={tableWrapStyle}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={theadRowStyle}>
                <th style={{ ...thStyle, width: 180 }}>Person</th>
                <th style={{ ...thStyle, width: 160 }}>Topic</th>
                <th style={{ ...thStyle, width: 52, textAlign: 'center' }}>Ver</th>
                <th style={{ ...thStyle, width: 60, textAlign: 'center' }}>Score</th>
                <th style={{ ...thStyle, width: 220, textAlign: 'left' }}>Status</th>
                <th style={{ ...thStyle }}>Run</th>
              </tr>
            </thead>
            <tbody>
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
            </tbody>
          </table>
        </div>
      )}
    </div>
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
  const bg = row.phase === 'running' ? 'rgba(99,102,241,0.04)'
    : row.phase === 'done' ? 'rgba(22,163,74,0.04)'
    : row.phase === 'error' ? 'rgba(220,38,38,0.04)'
    : 'transparent';

  return (
    <tr style={{ borderBottom: '1px solid var(--color-border, #e2e8f0)', background: bg, transition: 'background 0.2s' }}>
      {/* Person */}
      <td style={tdStyle}>
        <div style={{ fontWeight: 500, color: 'var(--color-text-primary, #0f172a)', lineHeight: 1.3 }}>
          {row.personName}
        </div>
        {row.personMeta && (
          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary, #94a3b8)', marginTop: 1 }}>
            {row.personMeta}
          </div>
        )}
      </td>
      {/* Topic */}
      <td style={{ ...tdStyle, color: 'var(--color-text-secondary, #475569)' }}>
        {row.topic}
      </td>
      {/* Version */}
      <td style={{ ...tdStyle, textAlign: 'center' }}>
        {row.version ? (
          <span style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '1px 7px',
            borderRadius: 999,
            background: row.version === 'B' ? '#f3e8ff' : '#eff6ff',
            color: row.version === 'B' ? 'var(--color-optimize)' : '#1d4ed8',
            border: `1px solid ${row.version === 'B' ? '#d8b4fe' : '#bfdbfe'}`,
          }}>
            {row.version}
          </span>
        ) : <span style={{ color: 'var(--color-text-tertiary, #94a3b8)' }}>—</span>}
      </td>
      {/* Score */}
      <td style={{ ...tdStyle, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
        {score !== undefined ? (
          <span style={{
            fontWeight: 600,
            fontSize: 12,
            color: score >= 0.7 ? 'var(--color-success)' : score >= 0.4 ? 'var(--color-warning)' : 'var(--color-danger)',
          }}>
            {score.toFixed(2)}
          </span>
        ) : row.phase === 'running' ? (
          <ThinkingDots size="sm" color="var(--color-primary, #6366f1)" />
        ) : (
          <span style={{ color: 'var(--color-text-tertiary, #94a3b8)' }}>—</span>
        )}
      </td>
      {/* Status */}
      <td style={{ ...tdStyle, verticalAlign: 'top' }}>
        <StatusPip phase={row.phase} hasScore={score !== undefined} errorMsg={row.errorMsg} />
      </td>
      {/* Run button */}
      <td style={{ ...tdStyle }}>
        {row.phase === 'idle' && (
          <button style={runCellBtnStyle} onClick={onRun}>Run</button>
        )}
        {row.phase === 'running' && (
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary, #94a3b8)' }}>Running</span>
        )}
        {(row.phase === 'done' || row.phase === 'error') && (
          <button style={{ ...runCellBtnStyle, color: 'var(--color-text-secondary, #475569)', borderColor: 'var(--color-border, #e2e8f0)' }} onClick={onReset}>
            Reset
          </button>
        )}
      </td>
    </tr>
  );
}

function StatusPip({ phase, hasScore, errorMsg }: { phase: RowPhase; hasScore: boolean; errorMsg: string }): React.ReactElement {
  if (phase === 'idle') return <span style={{ fontSize: 10, color: 'var(--color-text-tertiary, #94a3b8)' }}>idle</span>;
  if (phase === 'error') return (
    <div style={{ textAlign: 'left' }}>
      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-danger)' }}>● error</span>
      {errorMsg && (
        <div style={{
          fontSize: 10,
          color: 'var(--color-danger)',
          opacity: 0.8,
          marginTop: 2,
          maxWidth: 200,
          whiteSpace: 'normal',
          lineHeight: 1.4,
          wordBreak: 'break-word',
        }}>
          {errorMsg}
        </div>
      )}
    </div>
  );
  if (phase === 'running') return <span style={{ fontSize: 10, color: 'var(--color-primary)' }}>streaming</span>;
  // done
  if (!hasScore) return <span style={{ fontSize: 10, color: 'var(--color-warning)' }}>judging…</span>;
  return <span style={{ fontSize: 10, color: 'var(--color-success)', fontWeight: 600 }}>✓ scored</span>;
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
        style={{ width: 120, height: 80 }}
        nodeColor="#6366f1"
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
      <div style={pageStyle}>
        <CanaryDeploymentsView />
      </div>
    );
  }

  // ── Setup phase ─────────────────────────────────────────────────────────────
  if (experimentState === 'setup') {
    return (
      <div style={pageStyle}>
        <div style={setupToolbarStyle}>
          <span style={setupTitleStyle}>Canary</span>
          <span style={setupSubtitleStyle}>Configure a new experiment</span>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'var(--color-bg, #f8fafc)' }}>
          <React.Suspense fallback={<div style={{ fontSize: 13, color: 'var(--color-text-tertiary, #94a3b8)' }}>Loading…</div>}>
            <CanarySetupFlow onStarted={() => { /* store handles state transition */ }} />
          </React.Suspense>
        </div>
      </div>
    );
  }

  // ── Terminal phase ──────────────────────────────────────────────────────────
  if (experimentState === 'terminal') {
    return (
      <div style={pageStyle}>
        <div style={bodyStyle}>
          <div style={mainColStyle}>
            <ExperimentCompleteBanner onReset={() => { /* store handles reset */ }} />
            <div style={{ ...flowWrapStyle, opacity: 0.7 }}>
              <ReactFlowProvider>
                <CanaryFlowInner focusId={focusId} nodes={nodes} edges={edges} />
              </ReactFlowProvider>
            </div>
          </div>
          <DecisionHistoryPanel />
        </div>
      </div>
    );
  }

  // ── Running phase (default) ─────────────────────────────────────────────────
  return (
    <div style={pageStyle}>
      <Toolbar
        halted={halted}
        lastJudgedAt={lastJudgedAt}
        debug={debug}
        onDebugChange={setManualSliderOpen}
        scenariosOpen={scenariosOpen}
        onScenariosToggle={() => setScenariosOpen((v) => !v)}
      />
      <div style={bodyStyle}>
        <div style={mainColStyle}>
          <div style={{ ...flowWrapStyle, position: 'relative' }}>
            <ReactFlowProvider>
              <CanaryFlowInner focusId={focusId} nodes={nodes} edges={edges} />
            </ReactFlowProvider>
            {/* First-run guidance: a resumed/new experiment with no judgements
                yet is just an empty diagram — point straight at the next step
                instead of assuming the operator knows the Scenarios flow. */}
            {!lastJudgedAt && !scenariosOpen && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none', zIndex: 10,
              }}>
                <div style={{
                  pointerEvents: 'auto', maxWidth: 380, textAlign: 'center',
                  background: 'var(--color-surface, #fff)', border: '1px solid var(--color-border, #e2e8f0)',
                  borderRadius: 12, boxShadow: '0 8px 28px rgba(0,0,0,0.10)', padding: '20px 24px',
                }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary, #0f172a)' }}>
                    Experiment is live — no traffic yet
                  </div>
                  <p style={{ margin: '8px 0 0', fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-text-secondary, #475569)' }}>
                    The router splits traffic A/B and the judge scores every answer,
                    but nothing flows until you send requests. Generate test scenarios from your
                    org graph and run them to see scores and controller decisions appear.
                  </p>
                  <button
                    onClick={() => setScenariosOpen(true)}
                    style={{
                      marginTop: 14, padding: '8px 18px', borderRadius: 8, border: 'none',
                      background: 'var(--color-primary, #6366f1)', color: '#fff',
                      fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    ▶ Generate scenarios
                  </button>
                </div>
              </div>
            )}
          </div>
          <ScenarioPanel open={scenariosOpen} />
        </div>
        <DecisionHistoryPanel />
      </div>
    </div>
  );
}

function Toolbar({
  halted,
  lastJudgedAt,
  debug,
  onDebugChange,
  scenariosOpen,
  onScenariosToggle,
}: {
  halted: boolean;
  lastJudgedAt: string | undefined;
  debug: boolean;
  onDebugChange: (v: boolean) => void;
  scenariosOpen: boolean;
  onScenariosToggle: () => void;
}): React.ReactElement {
  return (
    <div style={toolbarStyle}>
      <div style={leftGroupStyle}>
        <span style={{ ...statusPillStyle, background: halted ? 'var(--color-danger-bg)' : 'var(--color-success-bg)', color: halted ? 'var(--color-danger)' : 'var(--color-success)' }}>
          {halted ? '● Halted' : '● Active'}
        </span>
        <span style={refreshTextStyle}>
          {lastJudgedAt ? `Last judged ${new Date(lastJudgedAt).toLocaleTimeString()}` : 'Awaiting first judgement…'}
        </span>
      </div>
      <div style={rightGroupStyle}>
        {debug && <ManualWeightSlider />}
        <label style={debugLabelStyle}>
          <input type="checkbox" checked={debug} onChange={(e) => onDebugChange(e.target.checked)} />
          <span>Debug</span>
        </label>
        <button
          style={scenarioBtnStyle}
          title="End this experiment and return to the setup wizard (traffic pins back to A)"
          onClick={() => {
            if (!window.confirm('End this experiment and start a new one?\nTraffic pins back to 100% A; decision history is kept.')) return;
            void fetch('/api/observability/canary/reset', { method: 'POST', credentials: 'include' })
              .catch(() => { /* store reset still returns the UI to the wizard */ })
              .finally(() => resetExperiment());
          }}
        >
          ＋ New experiment
        </button>
        {!halted && <HaltButton />}
        <button
          style={{
            ...scenarioBtnStyle,
            background: scenariosOpen ? 'var(--color-primary, #6366f1)' : 'transparent',
            color: scenariosOpen ? '#fff' : 'var(--color-text-secondary, #475569)',
          }}
          onClick={onScenariosToggle}
        >
          {scenariosOpen ? '✕ Scenarios' : '▶ Scenarios'}
        </button>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 };
const bodyStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' };

// Setup-phase simplified header styles
const setupToolbarStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '10px 14px', borderBottom: '1px solid var(--color-border, #e2e8f0)',
  background: 'var(--color-surface, #fff)', flexShrink: 0, zIndex: 10,
};
const setupTitleStyle: CSSProperties = { fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary, #0f172a)' };
const setupSubtitleStyle: CSSProperties = { fontSize: 12, color: 'var(--color-text-tertiary, #94a3b8)' };
const mainColStyle: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' };
const flowWrapStyle: CSSProperties = { flex: 1, minHeight: 0, position: 'relative' };

const toolbarStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '10px 14px', borderBottom: '1px solid var(--color-border, #e2e8f0)',
  background: 'var(--color-surface, #fff)', gap: 16, flexShrink: 0, zIndex: 10,
};
const leftGroupStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12 };
const rightGroupStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const statusPillStyle: CSSProperties = { fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 999, letterSpacing: '0.02em' };
const refreshTextStyle: CSSProperties = { fontSize: 11, color: 'var(--color-text-tertiary, #94a3b8)' };
const debugLabelStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--color-text-secondary, #475569)', cursor: 'pointer' };
const scenarioBtnStyle: CSSProperties = { fontSize: 12, fontWeight: 600, padding: '5px 14px', borderRadius: 6, border: '1px solid var(--color-border, #e2e8f0)', cursor: 'pointer', transition: 'background 0.15s' };

// Panel
const panelStyle: CSSProperties = {
  flexShrink: 0, borderTop: '1px solid var(--color-border, #e2e8f0)',
  background: 'var(--color-surface, #fff)', display: 'flex', flexDirection: 'column',
  maxHeight: 320, minHeight: 0,
};
const panelToolbarStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '8px 14px', borderBottom: '1px solid var(--color-border, #e2e8f0)', flexShrink: 0, gap: 10,
};
const countLabelStyle: CSSProperties = { fontSize: 11, color: 'var(--color-text-secondary, #475569)', display: 'flex', alignItems: 'center', gap: 6 };
const selectStyle: CSSProperties = { fontSize: 12, padding: '2px 4px', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 4, background: 'var(--color-bg, #f8fafc)' };
const genBtnStyle: CSSProperties = { fontSize: 12, fontWeight: 500, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--color-border, #e2e8f0)', background: 'var(--color-bg, #f8fafc)', cursor: 'pointer', color: 'var(--color-text-primary, #0f172a)' };
const actionBtnStyle: CSSProperties = { fontSize: 12, fontWeight: 600, padding: '4px 14px', borderRadius: 6, border: 'none', background: 'var(--color-primary, #6366f1)', color: '#fff', cursor: 'pointer' };
const emptyStyle: CSSProperties = { padding: '20px 16px', fontSize: 12, color: 'var(--color-text-tertiary, #94a3b8)', fontStyle: 'italic' };
const tableWrapStyle: CSSProperties = { flex: 1, overflowY: 'auto', overflowX: 'hidden' };
const theadRowStyle: CSSProperties = { background: 'var(--color-surface-raised, #f8fafc)', borderBottom: '1px solid var(--color-border, #e2e8f0)', position: 'sticky', top: 0 };
const thStyle: CSSProperties = { padding: '6px 12px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary, #94a3b8)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' };
const tdStyle: CSSProperties = { padding: '7px 12px', verticalAlign: 'middle' };
const runCellBtnStyle: CSSProperties = { fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 5, border: '1px solid var(--color-primary, #6366f1)', background: 'transparent', color: 'var(--color-primary, #6366f1)', cursor: 'pointer' };

export default CanaryPage;
