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
import { relativeTime } from '../../lib/relativeTime';
import { Link, useNavigate } from 'react-router';
import {
  Button, Card, Chip, CollapsibleSection, EmptyState, IconButton, Inline, ProgressBar, Select, SectionLabel, SelectableCard, Stack, StatStrip, Switch, T, VisuallyHidden,
} from '@connorhoehn/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
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
  // Recency, not a clock reading: both call sites ask "how stale is this",
  // and a bare time is ambiguous once the window crosses midnight.
  return relativeTime(iso);
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
      <T size="xs" className="block pl-0.5 leading-snug text-text-tertiary">{dim.description}</T>
    </Stack>
  );
}

/**
 * The four named dimensions in a stable order, then anything else the judge
 * returned — with `undefined` for one it ABSTAINED on.
 *
 * `judge_score.scores` carries only the dimensions actually measured:
 * `offline/lexical-answer-check` omits `tone` unless there is a refusal to
 * report. Iterating the object alone made an abstention invisible (the cell
 * just vanished, and the four-column grid grew a hole), which reads as "this
 * judge has three dimensions" rather than "nobody looked at tone here". Naming
 * all four and marking the gap says which one, and the tooltip says why it is
 * not a zero — the composite renormalises over what WAS judged.
 */
function dimensionCells(scores: Record<string, number>): Array<[string, number | undefined]> {
  const named = Object.keys(DIM_COLOR_CLASS);
  return [
    ...named.map((k) => [k, scores[k]] as [string, number | undefined]),
    ...Object.entries(scores).filter(([k]) => !named.includes(k)),
  ];
}

function ScoreRow({ entry, i }: { entry: JudgeHistoryEntry; i: number }) {
  const composite01 = entry.composite; // already 0–1
  return (
    <CollapsibleSection
      className="rounded-md"
      title={
        <Inline gap="sm" align="center" className="w-full">
          <T size="xs" className="w-6 shrink-0 text-text-tertiary">#{i + 1}</T>
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
          <T size="xs" weight="semibold" className={`w-7 shrink-0 text-right   ${scoreColorClass(composite01)}`}>
            {(composite01 * 10).toFixed(1)}
          </T>
          <T size="xs" className="shrink-0 text-text-tertiary">{fmtTime(entry.ts)}</T>
        </Inline>
      }
    >
      <Inline gap="sm" wrap className="grid grid-cols-4 gap-2 px-3 py-2">
        {dimensionCells(entry.scores).map(([k, v]) => (
          <Stack key={k} gap="none">
            <SectionLabel className={DIM_COLOR_CLASS[k]}>{k}</SectionLabel>
            {v === undefined ? (
              <T size="xs"
                className="text-xs italic leading-[1.45] text-text-tertiary"
                title={`The judge abstained on ${k} — not scored, not scored zero. The composite renormalises over the dimensions that were judged.`}
              >
                not judged
              </T>
            ) : (
              <T size="sm" weight="semibold" className={`  ${scoreColorClass(v)}`}>{fmt01(v)}</T>
            )}
          </Stack>
        ))}
      </Inline>
    </CollapsibleSection>
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
        throw new Error('Your role cannot change judge config — that needs org-leader or hr-admin.');
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

  // rollingMeanA/B default to 0 in the store until a judge_score for that
  // side has actually arrived (mean([]) === 0) — rendering that as "0.00"
  // reads as "this variant scored zero" rather than "not judged yet". Gate
  // the display on whether the side has any history at all.
  const hasScoresA = useMemo(() => judgeHistory.some(e => e.side === 'A'), [judgeHistory]);
  const hasScoresB = useMemo(() => judgeHistory.some(e => e.side === 'B'), [judgeHistory]);

  const statItems = [
    { key: 'helpfulness', label: 'Helpfulness' },
    { key: 'factuality', label: 'Factuality' },
    { key: 'tone', label: 'Tone' },
    { key: 'conciseness', label: 'Conciseness' },
  ] as const;

  return (
    <Inline gap="xl" align="start" className="overflow-auto">
      <VisuallyHidden as="h1">Evals</VisuallyHidden>
      {/* ── Left column: Config ── */}
      <Stack gap="sm" className="w-[480px] shrink-0">

        {/* Judge identity banner */}
        {judgeArn && (
          <Card padding="sm" className="border-border-emphasis bg-primary-soft">
            <Stack gap="xs">
              <Inline gap="sm" align="center" wrap>
                <Chip tone="accent" mono size="xs">{judgeVersionLabel}</Chip>
                <T size="xs" className="flex-1 truncate font-mono text-primary" title={judgeArn}>{judgeArn}</T>
              </Inline>
              <Inline gap="sm">
                {judgePromptId
                  ? <Link to="/iq/prompts" className="text-xs text-primary no-underline hover:underline">Edit in Prompt Studio ↗</Link>
                  : <T size="xs" className="text-primary">Edit in Prompt Studio ↗</T>}
                <Link to="/iq/diff" className="text-xs text-primary no-underline hover:underline">Compare versions ↗</Link>
              </Inline>
            </Stack>
          </Card>
        )}

        {/* Enable toggle */}
        <Card padding="md">
          <Stack gap="xs">
            <Inline gap="sm" align="center" justify="between">
              <T size="sm" weight="semibold" className="text-text-primary">LLM-as-Judge</T>
              <Inline gap="sm" align="center">
                <T size="xs" weight="semibold" className={`  ${cfg.enabled ? 'text-success' : 'text-text-tertiary'}`}>
                  {cfg.enabled ? 'Enabled' : 'Disabled'}
                </T>
                <Switch
                  checked={cfg.enabled}
                  onChange={enabled => setCfg(c => ({ ...c, enabled }))}
                  aria-label="Enable LLM-as-Judge"
                />
              </Inline>
            </Inline>
            <T size="xs" className="block leading-relaxed text-text-secondary">
              When enabled, a sample of canary invocations is automatically evaluated by the
              judge model. Scores flow live into this page via SSE.
            </T>
          </Stack>
        </Card>

        {/* Judge model */}
        <Card padding="md">
          <Stack gap="xs">
            <SectionLabel as="div">Judge model</SectionLabel>
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
                    <T size="xs" weight="semibold" className="block text-text-primary">{m.label}</T>
                    <T size="xs" className="block text-text-tertiary">{m.hint}</T>
                  </Stack>
                </SelectableCard>
              ))}
            </Inline>
            <T size="xs" className="block leading-relaxed text-text-tertiary">
              Model ID:&nbsp;<T size="xs" className="rounded bg-surface-hover px-1 py-px font-mono text-text-secondary">{cfg.modelId}</T>
            </T>
          </Stack>
        </Card>

        {/* Rubric weights */}
        <Card padding="md">
          <Stack gap="xs">
            <Inline gap="sm" align="center" justify="between">
              <SectionLabel>Rubric weights</SectionLabel>
              <T size="xs" weight="semibold" className={`  ${weightOk ? 'text-success' : 'text-danger'}`}>{total}% / 100%</T>
            </Inline>
            <T size="xs" className="block leading-relaxed text-text-tertiary">
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
            {!weightOk && <T size="xs" weight="medium" className="block text-danger">Weights must sum to exactly 100%.</T>}
            <Button variant="ghost" size="sm" onClick={() => setCfg(c => ({ ...c, dimensions: DEFAULT_DIMENSIONS }))}>
              Reset to defaults
            </Button>
          </Stack>
        </Card>

        {/* Sampling + thresholds */}
        <Card padding="md">
          <Stack gap="sm">
            <SectionLabel as="div">Sampling &amp; thresholds</SectionLabel>
            <Inline gap="sm" align="center">
              <T size="xs" weight="semibold" className="w-[90px] shrink-0 text-text-secondary">Sample rate</T>
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
              <T size="xs" weight="semibold" className="w-[90px] shrink-0 text-text-secondary">Fail threshold</T>
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
        </Card>

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
              <Inline as="span" gap="none" role="alert" className="text-xs text-danger">Not saved — {saveError}</Inline>
            )}
          </Inline>
        )}
      </Stack>

      {/* ── Right column: Live scores ── */}
      <Stack gap="sm" className="min-w-[300px] flex-1">

        {/* Stat cards */}
        <StatStrip
          variant="line"
          items={statItems.map(s => ({
            label: s.label.toLowerCase(),
            value: lastJudgeScores ? `${(lastJudgeScores[s.key] * 100).toFixed(0)}` : '—',
            tone: lastJudgeScores ? scoreStripTone(lastJudgeScores[s.key]) : 'default',
          }))}
        />

        {/* Rolling means */}
        <StatStrip
          variant="line"
          items={[
            { label: 'rolling mean A', value: hasScoresA ? (rollingMeanA * 10).toFixed(2) : '—', tone: hasScoresA ? scoreStripTone(rollingMeanA) : 'default' },
            { label: 'rolling mean B', value: hasScoresB ? (rollingMeanB * 10).toFixed(2) : '—', tone: hasScoresB ? scoreStripTone(rollingMeanB) : 'default' },
            ...(lastJudgedAt ? [{ label: 'last judged', value: fmtTime(lastJudgedAt) }] : []),
          ]}
        />

        {/* Score history */}
        <Inline gap="sm" align="center">
          <T size="sm" weight="semibold" className="text-text-primary">Score history</T>
          <Chip mono size="xs">{historyDesc.length}</Chip>
          <T size="xs" className="text-text-tertiary">live · SSE feed</T>
        </Inline>

          {/* Was a Card + Stack + a 32px 📊 + text + Button — an EmptyState
              assembled by hand out of allowed primitives, which is why the
              component-discipline gate could not see it. The emoji was the
              tell: a decorative colour glyph that ignores the theme, standing
              in for an icon the library does not ship. EmptyState wants no
              icon at all here. */}
        {historyDesc.length === 0 ? (
          <Card padding="md">
            <EmptyState
              title="No scores yet"
              body={cfg.enabled
                ? 'Scores appear here in real-time as the canary evaluates responses.'
                : 'Enable LLM-as-Judge above to start collecting scores.'}
              actionLabel="Open canary dashboard"
              onAction={() => void navigate('/iq/canary')}
            />
          </Card>
        ) : (
          <Stack gap="xs" className="max-h-[calc(100vh-420px)] overflow-y-auto">
            {historyDesc.map((entry, i) => (
              <ScoreRow key={`${entry.ts}-${i}`} entry={entry} i={historyDesc.length - 1 - i} />
            ))}
          </Stack>
        )}

        {/* Legend */}
        <Inline gap="md" wrap align="center" className="py-1">
          <Inline gap="xs" align="center"><T className="text-success">●</T><T size="xs" className="text-text-secondary">≥70 Pass</T></Inline>
          <Inline gap="xs" align="center"><T className="text-warning">●</T><T size="xs" className="text-text-secondary">50–69 Review</T></Inline>
          <Inline gap="xs" align="center"><T className="text-danger">●</T><T size="xs" className="text-text-secondary">&lt;50 Fail</T></Inline>
          <T size="xs" className="ml-auto text-text-tertiary">scores are 0–100 (judge outputs 0–1)</T>
        </Inline>
      </Stack>
    </Inline>
  );
}
