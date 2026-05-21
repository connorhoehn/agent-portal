// Diff — side-by-side read-only comparison of any two prompt versions.
//
// Left column: pick Prompt A + version A.
// Right column: pick Prompt B + version B (defaults to same prompt, next version).
// Centre: unified LCS line diff rendered inline.

import { useState, useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { usePromptList, usePromptVersions } from '../../components/canary/usePromptLibrary.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string };

// ── LCS line diff ─────────────────────────────────────────────────────────────

function lineDiff(a: string, b: string): DiffLine[] {
  const la = a.split('\n');
  const lb = b.split('\n');
  const m = la.length, n = lb.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = la[i] === lb[j]
        ? 1 + (dp[i + 1]?.[j + 1] ?? 0)
        : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }
  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && la[i] === lb[j]) {
      result.push({ kind: 'same', text: la[i]! }); i++; j++;
    } else if (j < n && (i >= m || (dp[i + 1]?.[j] ?? 0) <= (dp[i]?.[j + 1] ?? 0))) {
      result.push({ kind: 'add', text: lb[j]! }); j++;
    } else {
      result.push({ kind: 'remove', text: la[i]! }); i++;
    }
  }
  return result;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useTemplateText(promptId: string | null, version: string | null): { text: string; loading: boolean } {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!promptId || !version) { setText(''); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/observability/canary/library/${encodeURIComponent(promptId)}/version/${encodeURIComponent(version)}`)
      .then(r => r.ok ? r.json() as Promise<{ variant?: { templateText?: string } }> : Promise.resolve({}))
      .then(d => { if (!cancelled) { setText((d as { variant?: { templateText?: string } }).variant?.templateText ?? ''); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [promptId, version]);

  return { text, loading };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PromptVersionPicker({
  label,
  promptId,
  version,
  onPromptChange,
  onVersionChange,
}: {
  label: string;
  promptId: string | null;
  version: string | null;
  onPromptChange: (id: string) => void;
  onVersionChange: (v: string) => void;
}): React.ReactElement {
  const { prompts } = usePromptList();
  const { versions } = usePromptVersions(promptId);

  return (
    <div style={pickerStyle}>
      <div style={pickerLabelStyle}>{label}</div>
      <select
        value={promptId ?? ''}
        onChange={e => onPromptChange(e.target.value)}
        style={selectStyle}
      >
        <option value="">Select prompt…</option>
        {prompts.map(p => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <select
        value={version ?? ''}
        onChange={e => onVersionChange(e.target.value)}
        style={selectStyle}
        disabled={!promptId || versions.length === 0}
      >
        <option value="">Select version…</option>
        {versions.map(v => (
          <option key={v.version} value={v.isDraft ? 'DRAFT' : v.version}>
            {v.isDraft || v.version === 'DRAFT' ? 'DRAFT' : `v${v.version}`}
            {v.description ? ` — ${v.description.slice(0, 40)}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Diff viewer ───────────────────────────────────────────────────────────────

function DiffViewer({ textA, textB, labelA, labelB }: {
  textA: string; textB: string; labelA: string; labelB: string;
}): React.ReactElement {
  const lines = useMemo(() => lineDiff(textA, textB), [textA, textB]);
  const added = lines.filter(l => l.kind === 'add').length;
  const removed = lines.filter(l => l.kind === 'remove').length;
  const unchanged = lines.filter(l => l.kind === 'same').length;

  return (
    <div style={diffWrapStyle}>
      <div style={diffHeaderStyle}>
        <span style={diffLabelStyle}>{labelA} → {labelB}</span>
        <div style={diffStatsStyle}>
          <span style={{ color: '#10b981', fontWeight: 600 }}>+{added}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>−{removed}</span>
          <span style={{ color: '#94a3b8' }}>{unchanged} unchanged</span>
        </div>
      </div>
      {lines.length === 0 ? (
        <div style={emptyDiffStyle}>Select two versions to compare.</div>
      ) : added === 0 && removed === 0 ? (
        <div style={emptyDiffStyle}>✓ Templates are identical.</div>
      ) : (
        <div style={diffBodyStyle}>
          {lines.map((line, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 8,
                padding: '1px 16px',
                background: line.kind === 'add' ? '#dcfce7' : line.kind === 'remove' ? '#fee2e2' : 'transparent',
                color: line.kind === 'add' ? '#166534' : line.kind === 'remove' ? '#991b1b' : '#0f172a',
              }}
            >
              <span style={{ width: 14, flexShrink: 0, userSelect: 'none', opacity: 0.5, fontFamily: 'monospace', fontSize: 12 }}>
                {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
              </span>
              <span style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {line.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Side-by-side template viewer ──────────────────────────────────────────────

function SideBySide({ textA, textB, labelA, labelB }: {
  textA: string; textB: string; labelA: string; labelB: string;
}): React.ReactElement {
  return (
    <div style={sideBySideStyle}>
      <div style={sideStyle}>
        <div style={sideLabelStyle}>{labelA}</div>
        <pre style={templatePreStyle}>{textA || '(empty)'}</pre>
      </div>
      <div style={dividerStyle} />
      <div style={sideStyle}>
        <div style={sideLabelStyle}>{labelB}</div>
        <pre style={templatePreStyle}>{textB || '(empty)'}</pre>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type ViewMode = 'diff' | 'side-by-side';

export default function DiffPage(): React.ReactElement {
  const { prompts } = usePromptList();

  const [promptIdA, setPromptIdA] = useState<string | null>(null);
  const [versionA, setVersionA] = useState<string | null>(null);
  const [promptIdB, setPromptIdB] = useState<string | null>(null);
  const [versionB, setVersionB] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('diff');

  // Auto-select first prompt for both panes on load.
  useEffect(() => {
    if (prompts.length > 0 && !promptIdA) {
      setPromptIdA(prompts[0]!.id);
      setPromptIdB(prompts[0]!.id);
    }
  }, [prompts, promptIdA]);

  const { text: textA, loading: loadingA } = useTemplateText(promptIdA, versionA);
  const { text: textB, loading: loadingB } = useTemplateText(promptIdB, versionB);

  const promptNameA = prompts.find(p => p.id === promptIdA)?.name ?? '—';
  const promptNameB = prompts.find(p => p.id === promptIdB)?.name ?? '—';
  const labelA = `${promptNameA}${versionA ? ` (${versionA === 'DRAFT' ? 'DRAFT' : `v${versionA}`})` : ''}`;
  const labelB = `${promptNameB}${versionB ? ` (${versionB === 'DRAFT' ? 'DRAFT' : `v${versionB}`})` : ''}`;

  const canCompare = !!(promptIdA && versionA && promptIdB && versionB);
  const loading = loadingA || loadingB;

  return (
    <div style={pageStyle}>
      {/* ── Toolbar ── */}
      <div style={toolbarStyle}>
        <PromptVersionPicker
          label="Version A (baseline)"
          promptId={promptIdA}
          version={versionA}
          onPromptChange={id => { setPromptIdA(id); setVersionA(null); }}
          onVersionChange={setVersionA}
        />

        <div style={vsChipStyle}>↔</div>

        <PromptVersionPicker
          label="Version B (challenger)"
          promptId={promptIdB}
          version={versionB}
          onPromptChange={id => { setPromptIdB(id); setVersionB(null); }}
          onVersionChange={setVersionB}
        />

        <div style={viewToggleStyle}>
          {(['diff', 'side-by-side'] as ViewMode[]).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setViewMode(m)}
              style={m === viewMode ? activeToggleStyle : inactiveToggleStyle}
            >
              {m === 'diff' ? 'Unified diff' : 'Side by side'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Main content ── */}
      <div style={contentStyle}>
        {!canCompare && (
          <div style={placeholderStyle}>
            <div style={placeholderIconStyle}>⇄</div>
            <p style={placeholderMsgStyle}>
              Select a prompt and version in each column above to compare their templates.
            </p>
          </div>
        )}

        {canCompare && loading && (
          <div style={placeholderStyle}>
            <p style={placeholderMsgStyle}>Loading templates…</p>
          </div>
        )}

        {canCompare && !loading && viewMode === 'diff' && (
          <DiffViewer textA={textA} textB={textB} labelA={labelA} labelB={labelB} />
        )}

        {canCompare && !loading && viewMode === 'side-by-side' && (
          <SideBySide textA={textA} textB={textB} labelA={labelA} labelB={labelB} />
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  margin: -24,
};

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 12,
  padding: '16px 20px',
  borderBottom: '1px solid #e2e8f0',
  flexShrink: 0,
  background: '#fff',
  flexWrap: 'wrap',
};

const pickerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  flex: 1,
  minWidth: 220,
};

const pickerLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#94a3b8',
};

const selectStyle: CSSProperties = {
  padding: '7px 10px',
  fontSize: 12,
  border: '1px solid #e2e8f0',
  borderRadius: 4,
  background: '#f8fafc',
  color: '#0f172a',
  outline: 'none',
  fontFamily: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
};

const vsChipStyle: CSSProperties = {
  fontSize: 18,
  color: '#94a3b8',
  paddingBottom: 6,
  flexShrink: 0,
};

const viewToggleStyle: CSSProperties = {
  display: 'flex',
  border: '1px solid #e2e8f0',
  borderRadius: 4,
  overflow: 'hidden',
  flexShrink: 0,
  alignSelf: 'flex-end',
};

const activeToggleStyle: CSSProperties = {
  padding: '6px 12px',
  fontSize: 11,
  fontWeight: 600,
  border: 'none',
  background: '#6366f1',
  color: '#fff',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const inactiveToggleStyle: CSSProperties = {
  padding: '6px 12px',
  fontSize: 11,
  fontWeight: 500,
  border: 'none',
  background: 'transparent',
  color: '#64748b',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const contentStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
};

const placeholderStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  padding: 40,
};

const placeholderIconStyle: CSSProperties = {
  fontSize: 40,
  color: '#e2e8f0',
};

const placeholderMsgStyle: CSSProperties = {
  fontSize: 13,
  color: '#94a3b8',
  margin: 0,
  textAlign: 'center',
  maxWidth: 360,
};

const diffWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
};

const diffHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid #e2e8f0',
  background: '#f8fafc',
  flexShrink: 0,
  flexWrap: 'wrap',
  gap: 8,
};

const diffLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#475569',
  fontFamily: 'monospace',
};

const diffStatsStyle: CSSProperties = {
  display: 'flex',
  gap: 12,
  fontSize: 12,
};

const diffBodyStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
};

const emptyDiffStyle: CSSProperties = {
  padding: 32,
  fontSize: 13,
  color: '#94a3b8',
  textAlign: 'center',
};

const sideBySideStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
};

const sideStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'auto',
  padding: 16,
};

const sideLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#94a3b8',
  marginBottom: 8,
  flexShrink: 0,
};

const dividerStyle: CSSProperties = {
  width: 1,
  background: '#e2e8f0',
  flexShrink: 0,
};

const templatePreStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 12,
  lineHeight: 1.7,
  margin: 0,
  padding: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: '#0f172a',
};
