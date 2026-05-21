// Evaluations — LLM-as-judge configuration.
//
// Lets users:
//   1. Pick a judge model (Amazon Bedrock — nova-pro, nova-lite, titan-text)
//   2. Pick a judge prompt from the Bedrock Prompt Library (or leave blank for
//      the built-in default rubric)
//   3. Tune rubric dimension weights (helpfulness, factuality, tone, conciseness)
//   4. Enable / disable automatic evaluation on canary invocations
//   5. View recent evaluation scores inline

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { usePromptList } from '../../components/canary/usePromptLibrary.js';

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
  promptId: string | null; // Bedrock prompt ID (null = built-in)
  promptVersion: string | null; // version or 'DRAFT'
  dimensions: RubricDimension[];
  minSampleRate: number; // 0–100 %
  failThreshold: number; // 0–10 score below which flags canary for review
}

interface RecentScore {
  id: string;
  agentId: string;
  sessionId: string;
  evaluatedAt: string;
  overallScore: number; // 0–10
  dimensions: Record<string, number>;
  reasoning: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const JUDGE_MODELS = [
  { id: 'amazon.nova-pro-v1:0',  label: 'Nova Pro',  hint: 'Best quality, higher cost' },
  { id: 'amazon.nova-lite-v1:0', label: 'Nova Lite', hint: 'Faster, lower cost' },
  { id: 'amazon.nova-micro-v1:0', label: 'Nova Micro', hint: 'Cheapest, limited reasoning' },
];

const DEFAULT_DIMENSIONS: RubricDimension[] = [
  { key: 'helpfulness',   label: 'Helpfulness',   description: 'Does the response address what was asked?',            weight: 30 },
  { key: 'factuality',    label: 'Factuality',     description: 'Is the information accurate and verifiable?',          weight: 30 },
  { key: 'tone',          label: 'Tone',           description: 'Is the response professional and appropriately worded?', weight: 20 },
  { key: 'conciseness',   label: 'Conciseness',    description: 'Is the response free of unnecessary padding?',          weight: 20 },
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

function scoreColor(score: number): string {
  if (score >= 7) return '#10b981';
  if (score >= 5) return '#f59e0b';
  return '#ef4444';
}

// ── Hooks ──────────────────────────────────────────────────────────────────────

function useRecentScores(): { scores: RecentScore[]; loading: boolean } {
  const [scores, setScores] = useState<RecentScore[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch('/api/observability/evaluations/recent?limit=10')
      .then(r => r.ok ? r.json() as Promise<{ scores: RecentScore[] }> : Promise.resolve({ scores: [] }))
      .then(d => { setScores(d.scores ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return { scores, loading };
}

function usePromptVersionList(promptId: string | null) {
  const [versions, setVersions] = useState<{ version: string; isDraft: boolean; description?: string }[]>([]);

  useEffect(() => {
    if (!promptId) { setVersions([]); return; }
    fetch(`/api/observability/canary/library/${encodeURIComponent(promptId)}/versions`)
      .then(r => r.ok ? r.json() as Promise<{ versions: typeof versions }> : Promise.resolve({ versions: [] }))
      .then(d => setVersions(d.versions ?? []))
      .catch(() => setVersions([]));
  }, [promptId]);

  return versions;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function WeightSlider({
  dim,
  onChange,
  totalOther,
}: {
  dim: RubricDimension;
  onChange: (key: string, w: number) => void;
  totalOther: number;
}) {
  const maxAllowed = Math.min(100, 100 - totalOther);
  return (
    <div style={dimRowStyle}>
      <div style={dimLabelBlockStyle}>
        <span style={dimNameStyle}>{dim.label}</span>
        <span style={dimDescStyle}>{dim.description}</span>
      </div>
      <div style={sliderWrapStyle}>
        <input
          type="range"
          min={0}
          max={maxAllowed + dim.weight}
          value={dim.weight}
          onChange={e => onChange(dim.key, Math.min(Number(e.target.value), 100 - totalOther))}
          style={{ flex: 1, accentColor: '#6366f1' }}
        />
        <span style={dimWeightStyle}>{dim.weight}%</span>
      </div>
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div style={scoreBarWrapStyle}>
      <div style={{ ...scoreBarFillStyle, width: `${score * 10}%`, background: scoreColor(score) }} />
    </div>
  );
}

function RecentScoreRow({ s }: { s: RecentScore }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={scoreRowStyle}>
      <div style={scoreRowTopStyle} onClick={() => setOpen(o => !o)}>
        <span style={scoreAgentStyle}>{s.agentId}</span>
        <span style={scoreSessionStyle}>{s.sessionId.slice(0, 8)}…</span>
        <div style={{ flex: 1 }} />
        <ScoreBar score={s.overallScore} />
        <span style={{ ...scoreNumStyle, color: scoreColor(s.overallScore) }}>{s.overallScore.toFixed(1)}</span>
        <span style={scoreTimeStyle}>{new Date(s.evaluatedAt).toLocaleTimeString()}</span>
        <span style={chevronStyle}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={scoreDetailStyle}>
          <div style={dimGridStyle}>
            {Object.entries(s.dimensions).map(([k, v]) => (
              <div key={k} style={dimScoreItemStyle}>
                <span style={dimScoreLabelStyle}>{k}</span>
                <span style={{ ...dimScoreValStyle, color: scoreColor(v) }}>{v.toFixed(1)}</span>
              </div>
            ))}
          </div>
          {s.reasoning && (
            <div style={reasoningStyle}>
              <span style={reasoningLabelStyle}>Reasoning</span>
              <p style={reasoningTextStyle}>{s.reasoning}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function EvaluationsPage(): React.ReactElement {
  const [cfg, setCfg] = useState<JudgeConfig>(loadConfig);
  const [saved, setSaved] = useState(false);

  const { prompts } = usePromptList();
  const versions = usePromptVersionList(cfg.promptId);
  const { scores, loading: scoresLoading } = useRecentScores();

  // Judge prompts are those with "judge" or "eval" in the name.
  const judgePrompts = useMemo(
    () => prompts.filter(p => /judge|eval/i.test(p.name)),
    [prompts],
  );

  const handleSave = useCallback(() => {
    saveConfig(cfg);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    // POST to middleware so it re-reads config on next invocation.
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

  return (
    <div style={pageStyle}>
      {/* ── Left column: Config ── */}
      <div style={configColStyle}>

        {/* Enable toggle */}
        <section style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>LLM-as-Judge</h2>
            <label style={toggleLabelStyle}>
              <span style={{ color: cfg.enabled ? '#10b981' : '#94a3b8', fontWeight: 600, fontSize: 12 }}>
                {cfg.enabled ? 'Enabled' : 'Disabled'}
              </span>
              <div
                style={{ ...toggleTrackStyle, background: cfg.enabled ? '#6366f1' : '#e2e8f0' }}
                onClick={() => setCfg(c => ({ ...c, enabled: !c.enabled }))}
              >
                <div style={{ ...toggleThumbStyle, transform: cfg.enabled ? 'translateX(18px)' : 'translateX(2px)' }} />
              </div>
            </label>
          </div>
          <p style={sectionDescStyle}>
            When enabled, a sample of canary invocations is automatically evaluated by a second
            model acting as an impartial judge. Scores appear in the Recent Scores panel and can
            trigger experiment hold/rollback if they fall below the fail threshold.
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

        {/* Judge prompt */}
        <section style={sectionStyle}>
          <h3 style={fieldLabelStyle}>Judge prompt</h3>
          <p style={fieldHintStyle}>
            Pick a prompt from the Prompt Library to use as the judge rubric template. Leave blank
            to use the built-in default rubric derived from the dimension weights below.
          </p>
          <select
            value={cfg.promptId ?? ''}
            onChange={e => setCfg(c => ({ ...c, promptId: e.target.value || null, promptVersion: null }))}
            style={selectStyle}
          >
            <option value="">(built-in default rubric)</option>
            {judgePrompts.length > 0 && (
              <optgroup label="Judge / eval prompts">
                {judgePrompts.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </optgroup>
            )}
            {prompts.filter(p => !/judge|eval/i.test(p.name)).length > 0 && (
              <optgroup label="Other prompts">
                {prompts.filter(p => !/judge|eval/i.test(p.name)).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </optgroup>
            )}
          </select>

          {cfg.promptId && (
            <select
              value={cfg.promptVersion ?? ''}
              onChange={e => setCfg(c => ({ ...c, promptVersion: e.target.value || null }))}
              style={{ ...selectStyle, marginTop: 6 }}
            >
              <option value="">Select version…</option>
              {versions.map(v => (
                <option key={v.version} value={v.isDraft ? 'DRAFT' : v.version}>
                  {v.isDraft || v.version === 'DRAFT' ? 'DRAFT' : `v${v.version}`}
                  {v.description ? ` — ${v.description.slice(0, 40)}` : ''}
                </option>
              ))}
            </select>
          )}

          {cfg.promptId && (
            <a
              href={`/iq/prompts`}
              style={promptLinkStyle}
            >
              Open in Prompt Studio ↗
            </a>
          )}
        </section>

        {/* Rubric weights */}
        <section style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ ...fieldLabelStyle, margin: 0 }}>Rubric weights</h3>
            <span style={{ fontSize: 11, color: weightOk ? '#10b981' : '#ef4444', fontWeight: 600 }}>
              {total}% / 100%
            </span>
          </div>
          <p style={fieldHintStyle}>
            Weights determine how each dimension contributes to the overall 0–10 score.
            {cfg.promptId && ' These are ignored when a custom judge prompt is selected.'}
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
          {!weightOk && (
            <div style={weightWarnStyle}>Weights must sum to exactly 100%.</div>
          )}
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
              {SAMPLE_RATES.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          <div style={{ ...rowFieldStyle, marginTop: 8 }}>
            <label style={inlineFieldLabelStyle}>Fail threshold</label>
            <select
              value={cfg.failThreshold}
              onChange={e => setCfg(c => ({ ...c, failThreshold: Number(e.target.value) }))}
              style={selectStyle}
            >
              {FAIL_THRESHOLDS.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <p style={fieldHintStyle}>
            Invocations scoring below the fail threshold are flagged; if ≥30% of evaluated
            invocations fail, the canary is automatically put on hold.
          </p>
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

      {/* ── Right column: Recent scores ── */}
      <div style={scoresColStyle}>
        <div style={scoresPanelHeaderStyle}>
          <h2 style={sectionTitleStyle}>Recent evaluations</h2>
          <span style={scoresBadgeStyle}>{scores.length}</span>
        </div>

        {scoresLoading && (
          <div style={placeholderStyle}>Loading scores…</div>
        )}

        {!scoresLoading && scores.length === 0 && (
          <div style={emptyScoresStyle}>
            <div style={emptyIconStyle}>📊</div>
            <p style={emptyTextStyle}>
              No evaluation scores yet.
              {cfg.enabled
                ? ' Scores will appear here after the next canary invocations are evaluated.'
                : ' Enable LLM-as-Judge above to start collecting scores.'}
            </p>
          </div>
        )}

        {!scoresLoading && scores.length > 0 && (
          <div style={scoresListStyle}>
            {scores.map(s => <RecentScoreRow key={s.id} s={s} />)}
          </div>
        )}

        {/* Legend */}
        <div style={legendStyle}>
          <span style={legendItemStyle}><span style={{ color: '#10b981' }}>●</span> ≥7 Pass</span>
          <span style={legendItemStyle}><span style={{ color: '#f59e0b' }}>●</span> 5–6 Review</span>
          <span style={legendItemStyle}><span style={{ color: '#ef4444' }}>●</span> &lt;5 Fail</span>
        </div>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  display: 'flex',
  gap: 24,
  height: '100%',
  minHeight: 0,
  margin: -24,
  padding: 24,
  overflow: 'auto',
  alignItems: 'flex-start',
  boxSizing: 'border-box',
};

const configColStyle: CSSProperties = {
  flex: '0 0 520px',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const scoresColStyle: CSSProperties = {
  flex: 1,
  minWidth: 280,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const sectionStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  padding: '16px 20px',
};

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 8,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: '#0f172a',
  margin: 0,
};

const sectionDescStyle: CSSProperties = {
  fontSize: 12,
  color: '#64748b',
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
  background: '#fff',
  boxShadow: '0 1px 3px rgba(0,0,0,.25)',
  transition: 'transform 0.2s',
};

const fieldLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#475569',
  margin: '0 0 6px',
};

const fieldHintStyle: CSSProperties = {
  fontSize: 11,
  color: '#94a3b8',
  margin: '4px 0 10px',
  lineHeight: 1.6,
};

const modelGridStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const modelCardBase: CSSProperties = {
  flex: 1,
  minWidth: 120,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '10px 12px',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  cursor: 'pointer',
  textAlign: 'left',
  background: '#f8fafc',
  fontFamily: 'inherit',
  transition: 'border-color 0.15s',
};

const modelCardStyle: CSSProperties = { ...modelCardBase };
const modelCardActiveStyle: CSSProperties = {
  ...modelCardBase,
  border: '2px solid #6366f1',
  background: '#eef2ff',
};

const modelNameStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#0f172a',
};

const modelHintStyle: CSSProperties = {
  fontSize: 10,
  color: '#94a3b8',
};

const codeStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 11,
  background: '#f1f5f9',
  padding: '1px 4px',
  borderRadius: 3,
  color: '#475569',
};

const selectStyle: CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 12,
  border: '1px solid #e2e8f0',
  borderRadius: 4,
  background: '#f8fafc',
  color: '#0f172a',
  outline: 'none',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const promptLinkStyle: CSSProperties = {
  display: 'inline-block',
  marginTop: 6,
  fontSize: 11,
  color: '#6366f1',
  textDecoration: 'none',
};

const dimsListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const dimRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const dimLabelBlockStyle: CSSProperties = {
  flex: '0 0 140px',
};

const dimNameStyle: CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: '#0f172a',
};

const dimDescStyle: CSSProperties = {
  display: 'block',
  fontSize: 10,
  color: '#94a3b8',
  lineHeight: 1.4,
};

const sliderWrapStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const dimWeightStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#475569',
  width: 34,
  textAlign: 'right',
  flexShrink: 0,
};

const weightWarnStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 11,
  color: '#ef4444',
  fontWeight: 500,
};

const resetBtnStyle: CSSProperties = {
  marginTop: 10,
  padding: '5px 12px',
  fontSize: 11,
  border: '1px solid #e2e8f0',
  borderRadius: 4,
  background: '#f8fafc',
  color: '#64748b',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const rowFieldStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const inlineFieldLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#475569',
  flex: '0 0 100px',
};

const saveRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
};

const saveBtnStyle: CSSProperties = {
  padding: '9px 20px',
  fontSize: 13,
  fontWeight: 600,
  border: 'none',
  borderRadius: 6,
  background: '#6366f1',
  color: '#fff',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const saveBtnDisabledStyle: CSSProperties = {
  ...saveBtnStyle,
  background: '#e2e8f0',
  color: '#94a3b8',
  cursor: 'not-allowed',
};

// ── Scores panel styles ────────────────────────────────────────────────────────

const scoresPanelHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const scoresBadgeStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  background: '#e2e8f0',
  color: '#475569',
  borderRadius: 10,
  padding: '1px 7px',
};

const placeholderStyle: CSSProperties = {
  fontSize: 12,
  color: '#94a3b8',
  padding: 16,
};

const emptyScoresStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
  padding: '40px 20px',
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
};

const emptyIconStyle: CSSProperties = {
  fontSize: 32,
};

const emptyTextStyle: CSSProperties = {
  fontSize: 12,
  color: '#94a3b8',
  textAlign: 'center',
  maxWidth: 280,
  margin: 0,
  lineHeight: 1.6,
};

const scoresListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const scoreRowStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  overflow: 'hidden',
};

const scoreRowTopStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px',
  cursor: 'pointer',
};

const scoreAgentStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#475569',
  maxWidth: 100,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const scoreSessionStyle: CSSProperties = {
  fontSize: 10,
  color: '#94a3b8',
  fontFamily: 'monospace',
};

const scoreBarWrapStyle: CSSProperties = {
  width: 60,
  height: 6,
  background: '#f1f5f9',
  borderRadius: 3,
  overflow: 'hidden',
  flexShrink: 0,
};

const scoreBarFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 3,
  transition: 'width 0.3s',
};

const scoreNumStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  flexShrink: 0,
};

const scoreTimeStyle: CSSProperties = {
  fontSize: 10,
  color: '#94a3b8',
  flexShrink: 0,
};

const chevronStyle: CSSProperties = {
  fontSize: 9,
  color: '#94a3b8',
  flexShrink: 0,
};

const scoreDetailStyle: CSSProperties = {
  borderTop: '1px solid #f1f5f9',
  padding: '10px 14px',
  background: '#f8fafc',
};

const dimGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
  gap: 6,
  marginBottom: 8,
};

const dimScoreItemStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const dimScoreLabelStyle: CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: '#94a3b8',
};

const dimScoreValStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
};

const reasoningStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const reasoningLabelStyle: CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: '#94a3b8',
};

const reasoningTextStyle: CSSProperties = {
  fontSize: 11,
  color: '#475569',
  margin: 0,
  lineHeight: 1.6,
};

const legendStyle: CSSProperties = {
  display: 'flex',
  gap: 12,
  padding: '6px 0',
};

const legendItemStyle: CSSProperties = {
  fontSize: 11,
  color: '#64748b',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
};
