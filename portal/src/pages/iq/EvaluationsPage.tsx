// Evaluations — LLM-as-judge configuration + live score feed.
//
// The middleware's SSM-backed config is authoritative — it is what fireJudge()
// reads on every canary ask. This page hydrates from it on mount and saves by
// PUTting it; a save only reads "Saved" when the server accepted it.
// localStorage is a display cache for the offline case, nothing more.
//
// Recent evaluation scores come directly from the canary store, which is
// fed by the SSE stream — no separate REST table required.
// Clicking the JudgeNode in the canary diagram navigates here.

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Button, Chip, IconButton, Inline, ProgressBar, Select, SelectableCard, Stack, StatStrip, Switch,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useCanaryStream } from '../../components/canary/useCanaryStream.js';
import {
  useCanaryStore,
  parsePromptIdFromArn,
  type JudgeHistoryEntry,
} from '../../components/canary/canaryStore.js';
import { T } from './Text';

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

// CSS color values for the ProgressBar `color` prop (a library prop, not an
// inline style on a raw element) — one identity color per rubric dimension.
const DIM_COLOR_VAR: Record<string, string> = {
  helpfulness: 'var(--color-primary)',
  factuality:  'var(--color-success)',
  tone:        'var(--color-info)',
  conciseness: 'var(--color-warning)',
};

// Tailwind text-color classes for the same dimensions, for plain text labels.
const DIM_COLOR_CLASS: Record<string, string> = {
  helpfulness: 'text-primary',
  factuality:  'text-success',
  tone:        'text-info',
  conciseness: 'text-warning',
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

// score01 is 0–1 from the judge — CSS color for the ProgressBar `color` prop.
function scoreColorVar(score01: number): string {
  if (score01 >= 0.7) return 'var(--color-success)';
  if (score01 >= 0.5) return 'var(--color-warning)';
  return 'var(--color-danger)';
}

// Same thresholds, as a Tailwind text-color class for plain text.
function scoreColorClass(score01: number): string {
  if (score01 >= 0.7) return 'text-success';
  if (score01 >= 0.5) return 'text-warning';
  return 'text-danger';
}

function scoreStripTone(score01: number): 'default' | 'accent' | 'danger' {
  if (score01 >= 0.7) return 'accent';
  if (score01 >= 0.5) return 'default';
  return 'danger';
}

function fmt01(v: number): string {
  return (v * 100).toFixed(0);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

// ── Sub-components ─────────────────────────────────────────────────────────────

// Custom weight stepper — ±5 IconButtons around a ProgressBar track, so the
// visible weight/percent text is the library's own, not a hand-rolled span.
function WeightSlider({
  dim, onChange, totalOther,
}: {
  dim: RubricDimension;
  onChange: (key: string, w: number) => void;
  totalOther: number;
}) {
  const color = DIM_COLOR_VAR[dim.key] ?? 'var(--color-primary)';
  const maxAllowed = 100 - totalOther; // how much headroom is left
  const canIncrease = dim.weight + 5 <= dim.weight + maxAllowed;
  const canDecrease = dim.weight >= 5;

  function step(delta: number) {
    const next = Math.max(0, Math.min(dim.weight + maxAllowed, dim.weight + delta));
    onChange(dim.key, next);
  }

  return (
    <Stack gap="xs">
      <Inline gap="sm" align="center">
        <ProgressBar
          value={dim.weight}
          max={100}
          color={color}
          size="sm"
          showRatio={false}
          label={<T className={DIM_COLOR_CLASS[dim.key] ?? 'text-text-primary'}>{dim.label}</T>}
          className="flex-1"
          aria-label={`${dim.label} weight`}
        />
        <IconButton aria-label={`Decrease ${dim.label} weight by 5`} size="sm" variant="ghost" onClick={() => step(-5)} disabled={!canDecrease}>−</IconButton>
        <IconButton aria-label={`Increase ${dim.label} weight by 5`} size="sm" variant="ghost" onClick={() => step(5)} disabled={!canIncrease}>+</IconButton>
      </Inline>
      <T className="block pl-0.5 text-[10px] leading-snug text-text-tertiary">{dim.description}</T>
    </Stack>
  );
}

function ScoreRow({ entry, i }: { entry: JudgeHistoryEntry; i: number }) {
  const [open, setOpen] = useState(false);
  const composite01 = entry.composite; // already 0–1
  return (
    <Stack gap="none" className="overflow-hidden rounded-md border border-border bg-surface">
      <Inline gap="sm" align="center" className="cursor-pointer px-3 py-2" onClick={() => setOpen(o => !o)}>
        <T className="w-6 shrink-0 text-[10px] text-text-tertiary">#{i + 1}</T>
        <Chip tone={entry.side === 'A' ? 'accent' : 'success'} size="xs">{entry.side}</Chip>
        <ProgressBar
          value={composite01 * 100}
          max={100}
          color={scoreColorVar(composite01)}
          size="sm"
          showRatio={false}
          className="flex-1"
          aria-label="Composite score"
        />
        <T className={`w-7 shrink-0 text-right text-[12px] font-bold ${scoreColorClass(composite01)}`}>
          {(composite01 * 10).toFixed(1)}
        </T>
        <T className="shrink-0 text-[10px] text-text-tertiary">{fmtTime(entry.ts)}</T>
        <T className="shrink-0 text-[9px] text-text-tertiary">{open ? '▲' : '▼'}</T>
      </Inline>
      {open && (
        <Stack gap="none" className="border-t border-surface-hover bg-surface-panel px-3 py-2">
          <Inline gap="sm" wrap className="grid grid-cols-4 gap-2">
            {Object.entries(entry.scores).map(([k, v]) => (
              <Stack key={k} gap="none">
                <T className={`text-[9px] font-bold uppercase tracking-wide ${DIM_COLOR_CLASS[k] ?? 'text-text-tertiary'}`}>{k}</T>
                <T className={`text-[16px] font-bold ${scoreColorClass(v)}`}>{fmt01(v)}</T>
              </Stack>
            ))}
          </Inline>
        </Stack>
      )}
    </Stack>
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
  // Saving judge config PUTs /api/observability/evaluations/config (ManageCanary).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageCanary');
  const [cfg, setCfg] = useState<JudgeConfig>(loadConfig);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  // The PUT is the save — SSM is what live judging reads, so claiming "Saved"
  // before the server accepted it would present a setting that isn't in
  // effect. localStorage is only refreshed after the server has it.
  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/observability/evaluations/config', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      if (res.status === 403) {
        throw new Error('Your role cannot change judge config (needs ManageCanary — org-leader or hr-admin).');
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      saveConfig(cfg);
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [cfg]);

  const setDimWeight = useCallback((key: string, w: number) => {
    setCfg(c => ({ ...c, dimensions: c.dimensions.map(d => d.key === key ? { ...d, weight: w } : d) }));
  }, []);

  const total = totalWeight(cfg.dimensions);
  const weightOk = total === 100;

  // Reverse so newest is at top.
  const historyDesc = useMemo(() => [...judgeHistory].reverse(), [judgeHistory]);

  const statItems = [
    { key: 'helpfulness', label: 'Helpfulness' },
    { key: 'factuality', label: 'Factuality' },
    { key: 'tone', label: 'Tone' },
    { key: 'conciseness', label: 'Conciseness' },
  ] as const;

  return (
    <Inline gap="xl" align="start" className="-m-6 overflow-auto p-6">
      {/* ── Left column: Config ── */}
      <Stack gap="sm" className="w-[480px] shrink-0">

        {/* Judge identity banner */}
        {judgeArn && (
          <Stack gap="xs" className="rounded-lg border border-border-emphasis bg-primary-soft px-3.5 py-2.5">
            <Inline gap="sm" align="center" wrap>
              <Chip tone="accent" mono size="xs">{judgeVersionLabel}</Chip>
              <T className="flex-1 truncate font-mono text-[10px] text-primary" title={judgeArn}>{judgeArn}</T>
            </Inline>
            <Inline gap="sm">
              {judgePromptId
                ? <Link to="/iq/prompts" className="text-[11px] text-primary no-underline hover:underline">Edit in Prompt Studio ↗</Link>
                : <T className="text-[11px] text-primary">Edit in Prompt Studio ↗</T>}
              <Link to="/iq/diff" className="text-[11px] text-primary no-underline hover:underline">Compare versions ↗</Link>
            </Inline>
          </Stack>
        )}

        {/* Enable toggle */}
        <Stack gap="xs" className="rounded-lg border border-border bg-surface px-4.5 py-3.5">
          <Inline gap="sm" align="center" justify="between">
            <T className="text-[13px] font-bold text-text-primary">LLM-as-Judge</T>
            <Inline gap="sm" align="center">
              <T className={`text-[12px] font-semibold ${cfg.enabled ? 'text-success' : 'text-text-tertiary'}`}>
                {cfg.enabled ? 'Enabled' : 'Disabled'}
              </T>
              <Switch
                checked={cfg.enabled}
                onChange={enabled => setCfg(c => ({ ...c, enabled }))}
                aria-label="Enable LLM-as-Judge"
              />
            </Inline>
          </Inline>
          <T className="block text-[11px] leading-relaxed text-text-secondary">
            When enabled, a sample of canary invocations is automatically evaluated by the
            judge model. Scores flow live into this page via SSE.
          </T>
        </Stack>

        {/* Judge model */}
        <Stack gap="xs" className="rounded-lg border border-border bg-surface px-4.5 py-3.5">
          <T className="block text-[10px] font-bold uppercase tracking-wide text-text-secondary">Judge model</T>
          <Inline gap="sm" wrap>
            {JUDGE_MODELS.map(m => (
              <SelectableCard
                key={m.id}
                selected={m.id === cfg.modelId}
                onSelect={() => setCfg(c => ({ ...c, modelId: m.id }))}
                padding="sm"
                className="min-w-[110px] flex-1 text-left"
              >
                <Stack gap="none">
                  <T className="block text-[11px] font-semibold text-text-primary">{m.label}</T>
                  <T className="block text-[10px] text-text-tertiary">{m.hint}</T>
                </Stack>
              </SelectableCard>
            ))}
          </Inline>
          <T className="block text-[11px] leading-relaxed text-text-tertiary">
            Model ID: <T className="rounded bg-surface-hover px-1 py-px font-mono text-[10px] text-text-secondary">{cfg.modelId}</T>
          </T>
        </Stack>

        {/* Rubric weights */}
        <Stack gap="xs" className="rounded-lg border border-border bg-surface px-4.5 py-3.5">
          <Inline gap="sm" align="center" justify="between">
            <T className="text-[10px] font-bold uppercase tracking-wide text-text-secondary">Rubric weights</T>
            <T className={`text-[11px] font-semibold ${weightOk ? 'text-success' : 'text-danger'}`}>{total}% / 100%</T>
          </Inline>
          <T className="block text-[11px] leading-relaxed text-text-tertiary">
            How each dimension contributes to the overall 0–10 score.
            {judgeArn && ' Overridden by the active judge prompt when one is configured.'}
          </T>
          <Stack gap="sm">
            {cfg.dimensions.map(dim => (
              <WeightSlider
                key={dim.key}
                dim={dim}
                onChange={setDimWeight}
                totalOther={total - dim.weight}
              />
            ))}
          </Stack>
          {!weightOk && <T className="block text-[11px] font-medium text-danger">Weights must sum to exactly 100%.</T>}
          <Button variant="ghost" size="sm" onClick={() => setCfg(c => ({ ...c, dimensions: DEFAULT_DIMENSIONS }))}>
            Reset to defaults
          </Button>
        </Stack>

        {/* Sampling + thresholds */}
        <Stack gap="sm" className="rounded-lg border border-border bg-surface px-4.5 py-3.5">
          <T className="block text-[10px] font-bold uppercase tracking-wide text-text-secondary">Sampling &amp; thresholds</T>
          <Inline gap="sm" align="center">
            <T className="w-[90px] shrink-0 text-[11px] font-semibold text-text-secondary">Sample rate</T>
            <Select
              value={String(cfg.minSampleRate)}
              onChange={e => setCfg(c => ({ ...c, minSampleRate: Number(e.target.value) }))}
              options={SAMPLE_RATES.map(r => ({ value: String(r.value), label: r.label }))}
              size="sm"
              className="flex-1"
              aria-label="Sample rate"
            />
          </Inline>
          <Inline gap="sm" align="center">
            <T className="w-[90px] shrink-0 text-[11px] font-semibold text-text-secondary">Fail threshold</T>
            <Select
              value={String(cfg.failThreshold)}
              onChange={e => setCfg(c => ({ ...c, failThreshold: Number(e.target.value) }))}
              options={FAIL_THRESHOLDS.map(t => ({ value: String(t.value), label: t.label }))}
              size="sm"
              className="flex-1"
              aria-label="Fail threshold"
            />
          </Inline>
        </Stack>

        {/* Save — ManageCanary only; without it the config is a read-only view. */}
        {canManage && (
          <Inline gap="sm" justify="end" align="center">
            <Button
              variant="primary"
              size="sm"
              disabled={!weightOk || saving}
              onClick={() => void handleSave()}
            >
              {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save configuration'}
            </Button>
            {saveError && (
              <Inline as="span" gap="none" role="alert" className="text-[12px] text-danger">Not saved — {saveError}</Inline>
            )}
          </Inline>
        )}
      </Stack>

      {/* ── Right column: Live scores ── */}
      <Stack gap="sm" className="min-w-[300px] flex-1">

        {/* Stat cards */}
        <StatStrip
          items={statItems.map(s => ({
            label: s.label,
            value: lastJudgeScores ? `${(lastJudgeScores[s.key] * 100).toFixed(0)}` : '—',
            tone: lastJudgeScores ? scoreStripTone(lastJudgeScores[s.key]) : 'default',
          }))}
        />

        {/* Rolling means */}
        <StatStrip
          items={[
            { label: 'Rolling mean A', value: (rollingMeanA * 10).toFixed(2), tone: scoreStripTone(rollingMeanA) },
            { label: 'Rolling mean B', value: (rollingMeanB * 10).toFixed(2), tone: scoreStripTone(rollingMeanB) },
            ...(lastJudgedAt ? [{ label: 'Last judged', value: fmtTime(lastJudgedAt) }] : []),
          ]}
        />

        {/* Score history */}
        <Inline gap="sm" align="center">
          <T className="text-[13px] font-bold text-text-primary">Score history</T>
          <Chip mono size="xs">{historyDesc.length}</Chip>
          <T className="text-[10px] text-text-tertiary">live · SSE feed</T>
        </Inline>

        {historyDesc.length === 0 ? (
          <Stack gap="sm" align="center" className="rounded-lg border border-border bg-surface px-5 py-8">
            <T className="text-[32px]">📊</T>
            <T className="max-w-[280px] text-center text-[12px] leading-relaxed text-text-tertiary">
              No scores yet.{' '}
              {cfg.enabled
                ? 'Scores appear here in real-time as the canary evaluates responses.'
                : 'Enable LLM-as-Judge above to start collecting scores.'}
            </T>
            <Button variant="secondary" size="sm" onClick={() => navigate('/iq/canary')}>
              Open canary dashboard →
            </Button>
          </Stack>
        ) : (
          <Stack gap="xs" className="max-h-[calc(100vh-420px)] overflow-y-auto">
            {historyDesc.map((entry, i) => (
              <ScoreRow key={`${entry.ts}-${i}`} entry={entry} i={historyDesc.length - 1 - i} />
            ))}
          </Stack>
        )}

        {/* Legend */}
        <Inline gap="md" wrap align="center" className="py-1">
          <Inline gap="xs" align="center"><T className="text-success">●</T><T className="text-[11px] text-text-secondary">≥70 Pass</T></Inline>
          <Inline gap="xs" align="center"><T className="text-warning">●</T><T className="text-[11px] text-text-secondary">50–69 Review</T></Inline>
          <Inline gap="xs" align="center"><T className="text-danger">●</T><T className="text-[11px] text-text-secondary">&lt;50 Fail</T></Inline>
          <T className="ml-auto text-[10px] text-text-tertiary">scores are 0–100 (judge outputs 0–1)</T>
        </Inline>
      </Stack>
    </Inline>
  );
}
