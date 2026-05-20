// CanaryPage — visualizes the prompt-version canary as a live ReactFlow
// topology. Subscribes to /api/observability/canary/events via useCanaryStream
// and renders nine static-position nodes (Input → Router → Prompt A/B → Model
// → Judge → ScorePanel A/B → Controller).
//
// Top toolbar: status pill, refreshed-at timestamp, HaltButton, debug toggle.
// Right rail: DecisionHistoryPanel.

import type { CSSProperties } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { nodeTypes, edgeTypes } from '../components/canary/index.js';
import { useCanaryStream } from '../components/canary/useCanaryStream.js';
import {
  setManualSliderOpen,
  useCanaryEdges,
  useCanaryNodes,
  useCanaryStore,
} from '../components/canary/canaryStore.js';
import { HaltButton } from '../components/canary/HaltButton.js';
import { ManualWeightSlider } from '../components/canary/ManualWeightSlider.js';
import { DecisionHistoryPanel } from '../components/canary/DecisionHistoryPanel.js';

function CanaryPage(): React.ReactElement {
  useCanaryStream();
  const debug = useCanaryStore((s) => s.manualSliderOpen);

  const halted = useCanaryStore((s) => s.halted);
  const lastJudgedAt = useCanaryStore((s) => s.lastJudgedAt);
  const nodes = useCanaryNodes();
  const edges = useCanaryEdges();

  return (
    <div style={pageStyle}>
      <Toolbar
        halted={halted}
        lastJudgedAt={lastJudgedAt}
        debug={debug}
        onDebugChange={setManualSliderOpen}
      />
      <div style={bodyStyle}>
        <div style={flowWrapStyle}>
          <ReactFlowProvider>
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
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </ReactFlowProvider>
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
}: {
  halted: boolean;
  lastJudgedAt: string | undefined;
  debug: boolean;
  onDebugChange: (v: boolean) => void;
}): React.ReactElement {
  return (
    <div style={toolbarStyle}>
      <div style={leftGroupStyle}>
        <span
          style={{
            ...statusPillStyle,
            background: halted ? '#fee2e2' : '#dcfce7',
            color: halted ? '#991b1b' : '#166534',
          }}
        >
          {halted ? '● Halted' : '● Active'}
        </span>
        <span style={refreshTextStyle}>
          {lastJudgedAt
            ? `Last judged ${new Date(lastJudgedAt).toLocaleTimeString()}`
            : 'Awaiting first judgement…'}
        </span>
      </div>
      <div style={rightGroupStyle}>
        {debug && <ManualWeightSlider />}
        <label style={debugLabelStyle}>
          <input
            type="checkbox"
            checked={debug}
            onChange={(e) => onDebugChange(e.target.checked)}
          />
          <span>Debug</span>
        </label>
        <HaltButton />
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  minHeight: 0,
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'row',
};

const flowWrapStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  position: 'relative',
};

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
  background: 'var(--color-surface, #fff)',
  gap: 16,
  position: 'sticky',
  top: 0,
  zIndex: 10,
  flexShrink: 0,
};

const leftGroupStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const rightGroupStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const statusPillStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: '3px 10px',
  borderRadius: 999,
  letterSpacing: '0.02em',
};

const refreshTextStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary, #94a3b8)',
};

const debugLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  color: 'var(--color-text-secondary, #475569)',
  cursor: 'pointer',
};

export default CanaryPage;
