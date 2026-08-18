// Evaluations — LLM-as-judge configuration + live score feed.
//
// Judge config (model, rubric weights, sample rate) is stored in localStorage
// and mirrored to the middleware via a best-effort PUT.
//
// Recent evaluation scores come directly from the canary store, which is
// fed by the SSE stream — no separate REST table required.
// Clicking the JudgeNode in the canary diagram navigates here.

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router';
import { usePromptList } from '../../components/canary/usePromptLibrary.js';
import { useCanaryStream } from '../../components/canary/useCanaryStream.js';
import {
  useCanaryStore,
  parsePromptIdFromArn,
  type JudgeHistoryEntry,
} from '../../components/canary/canaryStore.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RubricDimension {
  key: string;
  label: string;
  description: string;
  weight: number; // 0–100
}

interface JudgeConfig {
  enabled: boolean;
  modelId: string;
  promptId: string | null;
  promptVersion: string | null;
  dimensions: RubricDimension[];
  minSampleRate: number;
  failThreshold: number; // 0–10
}

// ── Constants ──────────────────────────────────────────────────────────────────

const JUDGE_MODELS = [
  { id: 'amazon.nova-pro-v1:0',  label: 'Nova Pro',  hint: 'Best quality, higher cost' },
  { id: 'amazon.nova-lite-v1:0', label: 'Nova Lite', hint: 'Faster, lower cost' },
  { id: 'amazon.nova-micro-v1:0', label: 'Nova Micro', hint: 'Cheapest, limited reasoning' },
];

const DEFAULT_DIMENSIONS: RubricDimension[] = [
  { key: 'helpfulness', label: 'Helpfulness', description: 'Does the response address what was asked?',             weight: 30 },
  { key: 'factuality',  label: 'Factuality',  description: 'Is the information accurate and verifiable?',           weight: 30 },
  { key: 'tone',        label: 'Tone',        description: 'Is the response professional and appropriately worded?', weight: 20 },
  { key: 'conciseness', label: 'Conciseness', description: 'Is the response free of unnecessary padding?',           weight: 20 },
];

const SAMPLE_RATES = [
  { value: 10, label: '10%' },
  { value: 25, label: '25%' },
  { value: 50, label: '50%' },
  { value: 100, label: '100% (all)' },
];

const FAIL_THRESHOLDS = [
  { value: 3, label: '3 / 10 — lenient' },
  { value: 5, label: '5 / 10 — moderate' },
  { value: 7, label: '7 / 10 — strict' },
];

const STORAGE_KEY = 'iq-judge-config';

const DIM_COLORS: Record<string, string> = {
  helpfulness: 'var(--color-primary)',
  factuality:  'var(--color-success)',
  tone:        '#0891b2',
  conciseness: 'var(--color-warning)',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function loadConfig(): JudgeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultConfig(), ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return defaultConfig();
}

function defaultConfig(): JudgeConfig {
  return {
    enabled: false,
    modelId: 'amazon.nova-pro-v1:0',
    promptId: null,
    promptVersion: null,
    dimensions: DEFAULT_DIMENSIONS,
    minSampleRate: 25,
    failThreshold: 5,
  };
}

function saveConfig(cfg: JudgeConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

function totalWeight(dims: RubricDimension[]) {
  return dims.reduce((s, d) => s + d.weight, 0);
}

function scoreColor(score01: number): string {
  // score01 is 0–1 from the judge
  if (score01 >= 0.7) return 'var(--color-success)';
  if (score01 >= 0.5) return 'var(--color-warning)';
  return 'var(--color-danger)';
}

function fmt01(v: number): string {
  return (v * 100).toFixed(0);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

// ── Sub-components ─────────────────────────────────────────────────────────────

// Custom weight stepper — avoids all browser range-input rendering quirks.
// Uses ±5 step buttons + a CSS-controlled progress bar.
function WeightSlider({
  dim, onChange, totalOther,
}: {
  dim: RubricDimension;
  onChange: (key: string, w: number) => void;
  totalOther: number;
}) {
  const color = DIM_COLORS[dim.key] ?? 'var(--color-primary)';
  const maxAllowed = 100 - totalOther; // how much headroom is left
  const canIncrease = dim.weight + 5 <= dim.weight + maxAllowed;
  const canDecrease = dim.weight >= 5;

  function step(delta: number) {
    const next = Math.max(0, Math.min(dim.weight + maxAllowed, dim.weight + delta));
    onChange(dim.key, next);
  }

  return (
    <div style={dimRowStyle}>
      <div style={dimLabelBlockStyle}>
        <span style={{ ...dimNameStyle, color }}>{dim.label}</span>
        <span style={dimDescStyle}>{dim.description}</span>
      </div>
      <div style={sliderWrapStyle}>
        {/* Visual progress bar — fully CSS-controlled, no browser quirks */}
        <div style={trackStyle}>
          <div style={{ ...trackFillStyle, width: `${dim.weight}%`, background: color }} />
        </div>
        <button
          type="button"
          style={stepBtnStyle}
          onClick={() => step(-5)}
          disabled={!canDecrease}
          title="−5%"
        >−</button>
        <span style={dimWeightStyle}>{dim.weight}%</span>
        <button
          type="button"
          style={stepBtnStyle}
          onClick={() => step(+5)}
          disabled={!canIncrease}
          title="+5%"
        >+</button>
      </div>
    </div>
  );
}

function ScoreRow({ entry, i }: { entry: JudgeHistoryEntry; i: number }) {
  const [open, setOpen] = useState(false);
  const composite01 = entry.composite; // already 0–1
  return (
    <div style={scoreRowStyle}>
      <div style={scoreRowTopStyle} onClick={() => setOpen(o => !o)}>
        <span style={scoreIndexStyle}>#{i + 1}</span>
        <span style={{ ...scoreSideStyle, background: entry.side === 'A' ? 'var(--color-primary-soft)' : 'var(--color-success-bg)', color: entry.side === 'A' ? 'var(--color-primary)' : 'var(--color-success)' }}>
          {entry.side}
        </span>
        <div style={{ flex: 1 }}>
          <div style={scoreBarTrackStyle}>
            <div style={{ ...scoreBarFillStyle, width: `${composite01 * 100}%`, background: scoreColor(composite01) }} />
          </div>
        </div>
        <span style={{ ...scoreNumStyle, color: scoreColor(composite01) }}>
          {(composite01 * 10).toFixed(1)}
        </span>
        <span style={scoreTimeStyle}>{fmtTime(entry.ts)}</span>
        <span style={chevronStyle}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={scoreDetailStyle}>
          <div style={dimGridStyle}>
            {Object.entries(entry.scores).map(([k, v]) => (
              <div key={k} style={dimScoreItemStyle}>
                <span style={{ ...dimScoreLabelStyle, color: DIM_COLORS[k] ?? 'var(--color-text-tertiary)' }}>{k}</span>
                <span style={{ ...dimScoreValStyle, color: scoreColor(v) }}>{fmt01(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function EvaluationsPage(): React.ReactElement {
  const navigate = useNavigate();
  // Open the canary SSE feed — the score history below reads from the canary
  // store, which is only populated while a stream subscription is mounted.
  // Without this, the page showed live data only if you visited /iq/canary
  // first in the same session.
  useCanaryStream();
  const [cfg, setCfg] = useState<JudgeConfig>(loadConfig);
  const [saved, setSaved] = useState(false);

  // The middleware's SSM-backed config is what fireJudge() actually reads —
  // hydrate from it on mount so the toggle/weights reflect live behavior.
  // localStorage is just an offline fallback.
  useEffect(() => {
    fetch('/api/observability/evaluations/config')
      .then(r => (r.ok ? (r.json() as Promise<Partial<JudgeConfig>>) : null))
      .then(server => {
        if (!server || typeof server !== 'object') return;
        setCfg(c => ({
          ...c,
          ...(typeof server.enabled === 'boolean' ? { enabled: server.enabled } : {}),
          ...(typeof server.modelId === 'string' && server.modelId ? { modelId: server.modelId } : {}),
          ...(typeof server.minSampleRate === 'number' ? { minSampleRate: server.minSampleRate } : {}),
          ...(typeof server.failThreshold === 'number' ? { failThreshold: server.failThreshold } : {}),
          // Merge weights by key — keep the page's labels/descriptions.
          dimensions: Array.isArray(server.dimensions)
            ? c.dimensions.map(d => {
                const s = server.dimensions?.find(x => x && x.key === d.key);
                return s && typeof s.weight === 'number' ? { ...d, weight: s.weight } : d;
              })
            : c.dimensions,
        }));
      })
      .catch(() => { /* offline — keep localStorage config */ });
  }, []);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clear any pending "Saved" reset timer on unmount to avoid setState after unmount.
  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  const { prompts } = usePromptList();

  // Live data from the canary SSE stream via the store.
  const judgeVersionLabel = useCanaryStore(s => s.judgeVersionLabel);
  const judgeArn = useCanaryStore(s => s.judgeArn);
  const lastJudgeScores = useCanaryStore(s => s.lastJudgeScores);
  const lastJudgedAt = useCanaryStore(s => s.lastJudgedAt);
  const judgeHistory = useCanaryStore(s => s.judgeHistory);
  const rollingMeanA = useCanaryStore(s => s.rollingMeanA);
  const rollingMeanB = useCanaryStore(s => s.rollingMeanB);

  // The prompt ID embedded in the judge ARN (for the Prompt Studio link).
  const judgePromptId = useMemo(() => parsePromptIdFromArn(judgeArn), [judgeArn]);

  // Judge prompts: those with "judge" or "eval" in the name.
  const judgePrompts = useMemo(
    () => prompts.filter(p => /judge|eval/i.test(p.name)),
    [prompts],
  );

  const handleSave = useCallback(() => {
    saveConfig(cfg);
    setSaved(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
    fetch('/api/observability/evaluations/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    }).catch(() => { /* best-effort */ });
  }, [cfg]);

  const setDimWeight = useCallback((key: string, w: number) => {
    setCfg(c => ({ ...c, dimensions: c.dimensions.map(d => d.key === key ? { ...d, weight: w } : d) }));
  }, []);

  const total = totalWeight(cfg.dimensions);
  const weightOk = total === 100;

  // Reverse so newest is at top.
  const historyDesc = useMemo(() => [...judgeHistory].reverse(), [judgeHistory]);

  return (
    <div style={pageStyle}>
      {/* ── Left column: Config ── */}
      <div style={configColStyle}>

        {/* Judge identity banner */}
        {judgeArn && (
          <div style={judgeArnBannerStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={judgeVersionBadgeStyle}>{judgeVersionLabel}</span>
              <span style={judgeArnTextStyle} title={judgeArn}>{judgeArn}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              {judgePromptId
                ? <Link to="/iq/prompts" style={smallLinkStyle}>Edit in Prompt Studio ↗</Link>
                : <span style={smallLinkStyle}>Edit in Prompt Studio ↗</span>}
              <Link to="/iq/diff" style={smallLinkStyle}>Compare versions ↗</Link>
            </div>
          </div>
        )}

        {/* Enable toggle */}
        <section style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>LLM-as-Judge</h2>
            <label style={toggleLabelStyle}>
              <span style={{ color: cfg.enabled ? 'var(--color-success)' : 'var(--color-text-tertiary)', fontWeight: 600, fontSize: 12 }}>
                {cfg.enabled ? 'Enabled' : 'Disabled'}
              </span>
              <div
                style={{ ...toggleTrackStyle, background: cfg.enabled ? 'var(--color-primary)' : 'var(--color-border)' }}
                onClick={() => setCfg(c => ({ ...c, enabled: !c.enabled }))}
              >
                <div style={{ ...toggleThumbStyle, transform: cfg.enabled ? 'translateX(18px)' : 'translateX(2px)' }} />
              </div>
            </label>
          </div>
          <p style={sectionDescStyle}>
            When enabled, a sample of canary invocations is automatically evaluated by the
            judge model. Scores flow live into this page via SSE.
          </p>
        </section>

        {/* Judge model */}
        <section style={sectionStyle}>
          <h3 style={fieldLabelStyle}>Judge model</h3>
          <div style={modelGridStyle}>
            {JUDGE_MODELS.map(m => (
              <button
                key={m.id}
                type="button"
                onClick={() => setCfg(c => ({ ...c, modelId: m.id }))}
                style={m.id === cfg.modelId ? modelCardActiveStyle : modelCardStyle}
              >
                <span style={modelNameStyle}>{m.label}</span>
                <span style={modelHintStyle}>{m.hint}</span>
              </button>
            ))}
          </div>
          <p style={fieldHintStyle}>Model ID: <code style={codeStyle}>{cfg.modelId}</code></p>
        </section>

        {/* Rubric weights */}
        <section style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ ...fieldLabelStyle, margin: 0 }}>Rubric weights</h3>
            <span style={{ fontSize: 11, color: weightOk ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 600 }}>
              {total}% / 100%
            </span>
          </div>
          <p style={fieldHintStyle}>
            How each dimension contributes to the overall 0–10 score.
            {judgeArn && ' Overridden by the active judge prompt when one is configured.'}
          </p>
          <div style={dimsListStyle}>
            {cfg.dimensions.map(dim => (
              <WeightSlider
                key={dim.key}
                dim={dim}
                onChange={setDimWeight}
                totalOther={total - dim.weight}
              />
            ))}
          </div>
          {!weightOk && <div style={weightWarnStyle}>Weights must sum to exactly 100%.</div>}
          <button
            type="button"
            style={resetBtnStyle}
            onClick={() => setCfg(c => ({ ...c, dimensions: DEFAULT_DIMENSIONS }))}
          >
            Reset to defaults
          </button>
        </section>

        {/* Sampling + thresholds */}
        <section style={sectionStyle}>
          <h3 style={fieldLabelStyle}>Sampling & thresholds</h3>
          <div style={rowFieldStyle}>
            <label style={inlineFieldLabelStyle}>Sample rate</label>
            <select
              value={cfg.minSampleRate}
              onChange={e => setCfg(c => ({ ...c, minSampleRate: Number(e.target.value) }))}
              style={selectStyle}
            >
              {SAMPLE_RATES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div style={{ ...rowFieldStyle, marginTop: 8 }}>
            <label style={inlineFieldLabelStyle}>Fail threshold</label>
            <select
              value={cfg.failThreshold}
              onChange={e => setCfg(c => ({ ...c, failThreshold: Number(e.target.value) }))}
              style={selectStyle}
            >
              {FAIL_THRESHOLDS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        </section>

        {/* Save */}
        <div style={saveRowStyle}>
          <button
            type="button"
            style={!weightOk ? saveBtnDisabledStyle : saveBtnStyle}
            disabled={!weightOk}
            onClick={handleSave}
          >
            {saved ? '✓ Saved' : 'Save configuration'}
          </button>
        </div>
      </div>

      {/* ── Right column: Live scores ── */}
      <div style={scoresColStyle}>

        {/* Stat cards */}
        <div style={statRowStyle}>
          <div style={statCardStyle}>
            <div style={statNumStyle}>{lastJudgeScores ? (lastJudgeScores.helpfulness * 100).toFixed(0) : '—'}</div>
            <div style={{ ...statLabelStyle, color: DIM_COLORS.helpfulness }}>Helpfulness</div>
          </div>
          <div style={statCardStyle}>
            <div style={statNumStyle}>{lastJudgeScores ? (lastJudgeScores.factuality * 100).toFixed(0) : '—'}</div>
            <div style={{ ...statLabelStyle, color: DIM_COLORS.factuality }}>Factuality</div>
          </div>
          <div style={statCardStyle}>
            <div style={statNumStyle}>{lastJudgeScores ? (lastJudgeScores.tone * 100).toFixed(0) : '—'}</div>
            <div style={{ ...statLabelStyle, color: DIM_COLORS.tone }}>Tone</div>
          </div>
          <div style={statCardStyle}>
            <div style={statNumStyle}>{lastJudgeScores ? (lastJudgeScores.conciseness * 100).toFixed(0) : '—'}</div>
            <div style={{ ...statLabelStyle, color: DIM_COLORS.conciseness }}>Conciseness</div>
          </div>
        </div>

        {/* Rolling means */}
        <div style={meansRowStyle}>
          <div style={meanCardStyle}>
            <span style={meanLabelStyle}>Rolling mean A</span>
            <span style={{ ...meanValStyle, color: scoreColor(rollingMeanA) }}>{(rollingMeanA * 10).toFixed(2)}</span>
          </div>
          <div style={meanCardStyle}>
            <span style={meanLabelStyle}>Rolling mean B</span>
            <span style={{ ...meanValStyle, color: scoreColor(rollingMeanB) }}>{(rollingMeanB * 10).toFixed(2)}</span>
          </div>
          {lastJudgedAt && (
            <div style={{ ...meanCardStyle, flex: '0 0 auto', minWidth: 120 }}>
              <span style={meanLabelStyle}>Last judged</span>
              <span style={meanValStyle}>{fmtTime(lastJudgedAt)}</span>
            </div>
          )}
        </div>

        {/* Score history */}
        <div style={scoresPanelHeaderStyle}>
          <h2 style={sectionTitleStyle}>Score history</h2>
          <span style={scoresBadgeStyle}>{historyDesc.length}</span>
          <span style={scoresSourceStyle}>live · SSE feed</span>
        </div>

        {historyDesc.length === 0 ? (
          <div style={emptyScoresStyle}>
            <div style={emptyIconStyle}>📊</div>
            <p style={emptyTextStyle}>
              No scores yet.{' '}
              {cfg.enabled
                ? 'Scores appear here in real-time as the canary evaluates responses.'
                : 'Enable LLM-as-Judge above to start collecting scores.'}
            </p>
            <button
              type="button"
              style={openCanaryBtnStyle}
              onClick={() => navigate('/iq/canary')}
            >
              Open canary dashboard →
            </button>
          </div>
        ) : (
          <div style={scoresListStyle}>
            {historyDesc.map((entry, i) => (
              <ScoreRow key={`${entry.ts}-${i}`} entry={entry} i={historyDesc.length - 1 - i} />
            ))}
          </div>
        )}

        {/* Legend */}
        <div style={legendStyle}>
          <span style={legendItemStyle}><span style={{ color: 'var(--color-success)' }}>●</span> ≥70 Pass</span>
          <span style={legendItemStyle}><span style={{ color: 'var(--color-warning)' }}>●</span> 50–69 Review</span>
          <span style={legendItemStyle}><span style={{ color: 'var(--color-danger)' }}>●</span> &lt;50 Fail</span>
          <span style={{ ...legendItemStyle, marginLeft: 'auto', color: 'var(--color-text-tertiary)', fontSize: 10 }}>scores are 0–100 (judge outputs 0–1)</span>
        </div>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  display: 'flex',
  gap: 24,
  margin: -24,
  padding: 24,
  overflow: 'auto',         // page itself scrolls if needed
  alignItems: 'flex-start',
  boxSizing: 'border-box',
  minHeight: '100%',
};

const configColStyle: CSSProperties = {
  flex: '0 0 480px',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const scoresColStyle: CSSProperties = {
  flex: 1,
  minWidth: 300,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const judgeArnBannerStyle: CSSProperties = {
  background: 'var(--color-primary-soft)',
  border: '1px solid var(--color-border-emphasis)',
  borderRadius: 8,
  padding: '10px 14px',
};

const judgeVersionBadgeStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: 11,
  fontWeight: 700,
  fontFamily: 'monospace',
  background: 'var(--color-primary)',
  color: 'var(--color-surface)',
  padding: '2px 8px',
  borderRadius: 4,
  flexShrink: 0,
};

const judgeArnTextStyle: CSSProperties = {
  fontSize: 10,
  fontFamily: 'monospace',
  color: 'var(--color-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
};

const smallLinkStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-primary)',
  textDecoration: 'none',
  cursor: 'pointer',
};

const sectionStyle: CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  padding: '14px 18px',
};

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 6,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--color-text-primary)',
  margin: 0,
};

const sectionDescStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-secondary)',
  margin: 0,
  lineHeight: 1.6,
};

const toggleLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
};

const toggleTrackStyle: CSSProperties = {
  width: 40,
  height: 22,
  borderRadius: 11,
  position: 'relative',
  cursor: 'pointer',
  transition: 'background 0.2s',
};

const toggleThumbStyle: CSSProperties = {
  position: 'absolute',
  top: 2,
  width: 18,
  height: 18,
  borderRadius: 9,
  background: 'var(--color-surface)',
  boxShadow: '0 1px 3px rgba(0,0,0,.25)',
  transition: 'transform 0.2s',
};

const fieldLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--color-text-secondary)',
  margin: '0 0 6px',
};

const fieldHintStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  margin: '4px 0 8px',
  lineHeight: 1.5,
};

const modelGridStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const modelCardBase: CSSProperties = {
  flex: 1,
  minWidth: 110,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '8px 10px',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  cursor: 'pointer',
  textAlign: 'left',
  background: 'var(--color-surface-panel)',
  fontFamily: 'inherit',
};

const modelCardStyle: CSSProperties = { ...modelCardBase };
const modelCardActiveStyle: CSSProperties = { ...modelCardBase, border: '2px solid var(--color-primary)', background: 'var(--color-primary-soft)' };

const modelNameStyle: CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)' };
const modelHintStyle: CSSProperties = { fontSize: 10, color: 'var(--color-text-tertiary)' };

const codeStyle: CSSProperties = {
  fontFamily: 'monospace', fontSize: 10, background: 'var(--color-surface-hover)',
  padding: '1px 4px', borderRadius: 3, color: 'var(--color-text-secondary)',
};

const selectStyle: CSSProperties = {
  flex: 1, padding: '6px 8px', fontSize: 12,
  border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface-panel)',
  color: 'var(--color-text-primary)', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
};

const dimsListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };

const dimRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const dimLabelBlockStyle: CSSProperties = { flex: '0 0 130px' };
const dimNameStyle: CSSProperties = { display: 'block', fontSize: 11, fontWeight: 600 };
const dimDescStyle: CSSProperties = { display: 'block', fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.4 };
const sliderWrapStyle: CSSProperties = { flex: 1, display: 'flex', alignItems: 'center', gap: 6 };
const dimWeightStyle: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--color-text-primary)', width: 30, textAlign: 'center', flexShrink: 0 };

const trackStyle: CSSProperties = {
  flex: 1, height: 8, background: 'var(--color-border)', borderRadius: 4, overflow: 'hidden',
};
const trackFillStyle: CSSProperties = {
  height: '100%', borderRadius: 4, transition: 'width 0.15s ease',
};
const stepBtnStyle: CSSProperties = {
  width: 24, height: 24, border: '1px solid var(--color-border)', borderRadius: 4,
  background: 'var(--color-surface-panel)', color: 'var(--color-text-secondary)', fontSize: 14, fontWeight: 700,
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0, fontFamily: 'inherit', lineHeight: 1, padding: 0,
};

const weightWarnStyle: CSSProperties = { marginTop: 6, fontSize: 11, color: 'var(--color-danger)', fontWeight: 500 };

const resetBtnStyle: CSSProperties = {
  marginTop: 8, padding: '4px 10px', fontSize: 11,
  border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface-panel)',
  color: 'var(--color-text-secondary)', cursor: 'pointer', fontFamily: 'inherit',
};

const rowFieldStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const inlineFieldLabelStyle: CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', flex: '0 0 90px' };

const saveRowStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end' };

const saveBtnStyle: CSSProperties = {
  padding: '8px 18px', fontSize: 12, fontWeight: 600,
  border: 'none', borderRadius: 6, background: 'var(--color-primary)', color: 'var(--color-surface)',
  cursor: 'pointer', fontFamily: 'inherit',
};
const saveBtnDisabledStyle: CSSProperties = { ...saveBtnStyle, background: 'var(--color-border)', color: 'var(--color-text-tertiary)', cursor: 'not-allowed' };

// ── Scores panel ──────────────────────────────────────────────────────────────

const statRowStyle: CSSProperties = { display: 'flex', gap: 8 };

const statCardStyle: CSSProperties = {
  flex: 1, background: 'var(--color-surface)', border: '1px solid var(--color-border)',
  borderRadius: 8, padding: '10px 12px', textAlign: 'center',
};

const statNumStyle: CSSProperties = { fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' };
const statLabelStyle: CSSProperties = { fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 };

const meansRowStyle: CSSProperties = { display: 'flex', gap: 8 };

const meanCardStyle: CSSProperties = {
  flex: 1, background: 'var(--color-surface)', border: '1px solid var(--color-border)',
  borderRadius: 8, padding: '8px 12px',
  display: 'flex', flexDirection: 'column', gap: 2,
};
const meanLabelStyle: CSSProperties = { fontSize: 10, color: 'var(--color-text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' };
const meanValStyle: CSSProperties = { fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)' };

const scoresPanelHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const scoresBadgeStyle: CSSProperties = {
  fontSize: 11, fontWeight: 700, background: 'var(--color-border)',
  color: 'var(--color-text-secondary)', borderRadius: 10, padding: '1px 7px',
};
const scoresSourceStyle: CSSProperties = { fontSize: 10, color: 'var(--color-text-tertiary)', marginLeft: 4 };

const emptyScoresStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
  padding: '32px 20px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8,
};
const emptyIconStyle: CSSProperties = { fontSize: 32 };
const emptyTextStyle: CSSProperties = { fontSize: 12, color: 'var(--color-text-tertiary)', textAlign: 'center', maxWidth: 280, margin: 0, lineHeight: 1.6 };

const openCanaryBtnStyle: CSSProperties = {
  padding: '7px 14px', fontSize: 12, fontWeight: 600,
  border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-surface-panel)',
  color: 'var(--color-text-secondary)', cursor: 'pointer', fontFamily: 'inherit',
};

const scoresListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  // Cap height so the list never expands the page vertically beyond the viewport.
  // 420px accounts for stat cards + means + header above the list.
  maxHeight: 'calc(100vh - 420px)',
  overflowY: 'auto',
};

const scoreRowStyle: CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden',
};

const scoreRowTopStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer',
};

const scoreIndexStyle: CSSProperties = { fontSize: 10, color: 'var(--color-text-tertiary)', flexShrink: 0, width: 24 };

const scoreSideStyle: CSSProperties = {
  fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3, flexShrink: 0,
};

const scoreBarTrackStyle: CSSProperties = {
  height: 6, background: 'var(--color-surface-hover)', borderRadius: 3, overflow: 'hidden',
};

const scoreBarFillStyle: CSSProperties = { height: '100%', borderRadius: 3, transition: 'width 0.3s' };

const scoreNumStyle: CSSProperties = { fontSize: 12, fontWeight: 700, flexShrink: 0, width: 28, textAlign: 'right' };
const scoreTimeStyle: CSSProperties = { fontSize: 10, color: 'var(--color-text-tertiary)', flexShrink: 0 };
const chevronStyle: CSSProperties = { fontSize: 9, color: 'var(--color-text-tertiary)', flexShrink: 0 };

const scoreDetailStyle: CSSProperties = {
  borderTop: '1px solid var(--color-surface-hover)', padding: '8px 12px', background: 'var(--color-surface-panel)',
};

const dimGridStyle: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
};

const dimScoreItemStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1 };
const dimScoreLabelStyle: CSSProperties = { fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' };
const dimScoreValStyle: CSSProperties = { fontSize: 16, fontWeight: 700 };

const legendStyle: CSSProperties = { display: 'flex', gap: 10, padding: '4px 0', flexWrap: 'wrap', alignItems: 'center' };
const legendItemStyle: CSSProperties = { fontSize: 11, color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 4 };
