// Prompt History — version timeline + experiment outcome log.
//
// Left rail: version timeline for the selected prompt (status dots, lifecycle).
// Right pane: single-version detail OR side-by-side diff (select 2 versions).
// Bottom of detail: experiment cards that used this version.
// Separate "Experiments" tab shows all runs across all prompts.

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Card, Checkbox, Chip, CodeBlock, EmptyState, InlinePlaceholder, LoadingState, SectionLabel,
  Select, SelectableCard, Stack, StatStrip, Inline, Tabs, T, VisuallyHidden,
} from '@connorhoehnslalom/ui-components/shared';
import { usePromptList, usePromptVersions } from '../../components/canary/usePromptLibrary.js';
import { diffStats, lineDiff } from './diffFormat';
import { DiffFrame } from './DiffFrame';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExperimentRef {
  experimentId: string;
  versionA: string;
  versionB: string;
  startedAt: string;
  finishedAt: string;
  finalAction: string;
  scoreA: number | null;
  scoreB: number | null;
  scoreDelta: number | null;
  decisionCount: number;
}

interface VersionEntry {
  version: string;
  description: string;
  authorEmail: string;
  publishedAt: string;
  deployedAt: string;
  supersededAt: string;
  lifecycleStatus: string;
  experiments: ExperimentRef[];
}

interface ExperimentSummary {
  experimentId: string;
  promptId: string;
  canaryName: string;
  versionA: string;
  versionB: string;
  descriptionB: string;
  startedAt: string;
  finishedAt: string;
  finalAction: string;
  scoreA: number | null;
  scoreB: number | null;
  scoreDelta: number | null;
  decisionCount: number;
  haltReason: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Chip tones per lifecycle status — replaces the old hex-color lookup now
// that StatusChip renders through the library's <Chip>.
const STATUS_TONE: Record<string, 'success' | 'accent' | 'neutral' | 'danger' | 'warning'> = {
  promoted:     'success',
  deployed:     'accent',
  published:    'neutral',
  rolled_back:  'danger',
  superseded:   'neutral',
  draft:        'warning',
};

const STATUS_LABEL: Record<string, string> = {
  promoted:    'PROMOTED',
  deployed:    'DEPLOYED',
  published:   'PUBLISHED',
  rolled_back: 'ROLLED BACK',
  superseded:  'SUPERSEDED',
  draft:       'DRAFT',
};

const ACTION_TONE: Record<string, 'success' | 'danger' | 'warning' | 'accent'> = {
  PROMOTE:     'success',
  ROLLBACK:    'danger',
  HALTED:      'warning',
  IN_PROGRESS: 'accent',
};

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtScore(n: number | null): string {
  return n === null ? '—' : n.toFixed(3);
}

function fmtDelta(n: number | null): string {
  if (n === null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(3);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }): React.ReactElement {
  return (
    <Chip tone={STATUS_TONE[status] ?? 'neutral'} size="xs" uppercase>
      {STATUS_LABEL[status] ?? status}
    </Chip>
  );
}

function ActionBadge({ action }: { action: string }): React.ReactElement {
  return (
    <Chip tone={ACTION_TONE[action] ?? 'neutral'} size="xs" solid>
      {action}
    </Chip>
  );
}

function ExperimentCard({ exp, role }: { exp: ExperimentRef; role: 'a' | 'b' }): React.ReactElement {
  const deltaPositive = (exp.scoreDelta ?? 0) >= 0;
  return (
    <Card padding="sm" className="bg-surface-panel">
      <Inline gap="sm" align="center" wrap>
        <ActionBadge action={exp.finalAction || 'IN_PROGRESS'} />
        <T size="xs" className="text-text-secondary">
          v{exp.versionA} vs v{exp.versionB} · used as {role.toUpperCase()}
        </T>
        <T size="xs" className="ml-auto text-text-tertiary">{fmtDate(exp.startedAt)}</T>
      </Inline>
      {/* The four numbers are a stat strip, not four hand-built tiles: same
          composite the dashboards use, so an experiment's scores read the
          way every other score on the app does. */}
      <StatStrip
        variant="line"
        className="mt-2"
        aria-label={`Experiment v${exp.versionA} vs v${exp.versionB}`}
        items={[
          { label: 'score A', value: fmtScore(exp.scoreA) },
          { label: 'score B', value: fmtScore(exp.scoreB) },
          { label: 'Δ', value: fmtDelta(exp.scoreDelta), tone: deltaPositive ? 'accent' : 'danger' },
          { label: 'decisions', value: exp.decisionCount },
        ]}
      />
    </Card>
  );
}

function DiffView({ textA, textB, labelA, labelB }: { textA: string; textB: string; labelA: string; labelB: string }): React.ReactElement {
  const lines = useMemo(() => lineDiff(textA, textB), [textA, textB]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  const identical = stats.added === 0 && stats.removed === 0;

  return (
    <Stack gap="sm" className="flex-1">
      <Inline gap="sm" align="center">
        <T size="xs" weight="semibold" className="text-text-secondary">{labelA} → {labelB}</T>
        <Chip tone="success" size="xs" mono>+{stats.added}</Chip>
        <Chip tone="danger" size="xs" mono>−{stats.removed}</Chip>
      </Inline>
      {identical ? (
        <InlinePlaceholder size="sm" align="center" className="p-6">
          ✓ Templates are identical.
        </InlinePlaceholder>
      ) : (
        <Stack gap="none" className="min-h-0 flex-1 overflow-auto">
          <DiffFrame lines={lines} />
        </Stack>
      )}
    </Stack>
  );
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useAuroraVersionHistory(promptId: string | null): { versions: VersionEntry[]; loading: boolean; error: string | null } {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!promptId) { setVersions([]); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/iq/prompts/history/${encodeURIComponent(promptId)}`)
      .then(r => r.ok ? r.json() as Promise<{ versions: VersionEntry[] }> : r.text().then(t => { throw new Error(t || `HTTP ${r.status}`); }))
      .then(data => { if (!cancelled) { setVersions(data.versions ?? []); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [promptId]);

  // `loading` only means something to a caller with nothing to show yet —
  // the same `isLoading && !data` shape useFetch enforces. A prompt switch
  // or a re-fetch of the SAME prompt (e.g. after a publish) keeps the prior
  // list on screen and updates it in place instead of flashing a spinner
  // over content that is still valid.
  return { versions, loading: loading && versions.length === 0, error };
}

// Merges Bedrock version list with Aurora metadata. Falls back gracefully when
// the Aurora prompt_version_meta table is empty (no experiments run yet).
function useVersionHistory(promptId: string | null): { versions: VersionEntry[]; loading: boolean; error: string | null } {
  const { versions: bedrockVersions, loading: bedrockLoading } = usePromptVersions(promptId);
  const { versions: auroraVersions, loading: auroraLoading, error } = useAuroraVersionHistory(promptId);

  const versions = useMemo<VersionEntry[]>(() => {
    const auroraMap = new Map(auroraVersions.map(v => [v.version, v]));

    // Build from Bedrock as the source of truth, enrich with Aurora data when present.
    const merged: VersionEntry[] = bedrockVersions.map(bv => {
      const ver = bv.isDraft || bv.version === '' ? 'DRAFT' : bv.version;
      const aurora = auroraMap.get(ver);
      return aurora ?? {
        version: ver,
        description: bv.description ?? '',
        authorEmail: '',
        publishedAt: bv.updatedAt ?? '',
        deployedAt: '',
        supersededAt: '',
        lifecycleStatus: ver === 'DRAFT' ? 'draft' : 'published',
        experiments: [],
      };
    });

    // Include any Aurora-only versions not found in Bedrock (rare).
    for (const av of auroraVersions) {
      if (!merged.find(m => m.version === av.version)) merged.push(av);
    }

    return merged;
  }, [bedrockVersions, auroraVersions]);

  return { versions, loading: bedrockLoading || auroraLoading, error };
}

function useExperiments(): { experiments: ExperimentSummary[]; loading: boolean; error: string | null; refresh: () => void } {
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(n => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/iq/prompts/experiments')
      .then(r => r.ok ? r.json() as Promise<{ experiments: ExperimentSummary[] }> : r.text().then(t => { throw new Error(t || `HTTP ${r.status}`); }))
      .then(data => { if (!cancelled) { setExperiments(data.experiments ?? []); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [tick]);

  return { experiments, loading, error, refresh };
}

// ── Version detail pane ───────────────────────────────────────────────────────

function useVersionDetail(promptId: string | null, version: string | null): { templateText: string; loading: boolean } {
  const [templateText, setTemplateText] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!promptId || !version) { setTemplateText(''); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/observability/canary/library/${encodeURIComponent(promptId)}/version/${encodeURIComponent(version)}`)
      .then(r => r.ok ? r.json() as Promise<{ variant?: { templateText?: string } }> : Promise.resolve({ variant: { templateText: '' } }))
      .then(d => { if (!cancelled) { setTemplateText(d.variant?.templateText ?? ''); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [promptId, version]);

  // Same isLoading && !data shape as useAuroraVersionHistory above.
  return { templateText, loading: loading && !templateText };
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = 'versions' | 'experiments';

export default function PromptHistoryPage(): React.ReactElement {
  const { prompts, error: promptsError } = usePromptList();
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('versions');
  const [selectedVersions, setSelectedVersions] = useState<string[]>([]);
  const [compareMode, setCompareMode] = useState(false);

  const { versions, loading: versionsLoading, error: versionsError } = useVersionHistory(selectedPromptId);
  const { experiments, loading: expLoading, error: expError } = useExperiments();

  // Template text for detail / diff
  const v0 = selectedVersions[0] ?? null;
  const v1 = selectedVersions[1] ?? null;
  const { templateText: text0 } = useVersionDetail(selectedPromptId, v0);
  const { templateText: text1 } = useVersionDetail(selectedPromptId, v1);

  // Auto-select first prompt
  useEffect(() => {
    if (!selectedPromptId && prompts.length > 0) setSelectedPromptId(prompts[0]!.id);
  }, [prompts, selectedPromptId]);

  // Auto-select first version when prompt changes
  useEffect(() => {
    setSelectedVersions([]);
    setCompareMode(false);
  }, [selectedPromptId]);

  function toggleVersion(version: string): void {
    if (compareMode) {
      setSelectedVersions(prev => {
        if (prev.includes(version)) return prev.filter(v => v !== version);
        if (prev.length >= 2) return [prev[1]!, version];
        return [...prev, version];
      });
    } else {
      setSelectedVersions([version]);
    }
  }

  const selectedVersion = !compareMode && selectedVersions.length === 1 ? selectedVersions[0]! : null;
  const versionDetail = selectedVersion ? versions.find(v => v.version === selectedVersion) : null;
  const inDiffMode = compareMode && selectedVersions.length === 2;

  // The prompt library gates the whole page; a denial must not render as an
  // empty picker that looks like "no prompts exist".
  if (promptsError) {
    const denied = /403|forbidden/i.test(promptsError);
    return (
      <Stack gap="none" className="max-w-xl p-10">
        <EmptyState
          title={denied ? 'Prompt history access needed' : 'Could not load prompt history'}
          description={denied
            ? 'Prompt history is limited to the org-leader and HR Admin roles. Switch role from the identity menu, top right.'
            : <>The prompt library did not load. {promptsError}</>}
        />
      </Stack>
    );
  }

  return (
    <Inline gap="none" className="h-full min-h-0">
      <VisuallyHidden as="h1">Prompt versions</VisuallyHidden>
      {/* ── Left: prompt selector + version timeline ── */}
      <Stack gap="none" className="w-[260px] shrink-0 overflow-y-auto border-r border-border bg-surface">
        {/* Prompt picker */}
        <Stack gap="none" className="shrink-0 border-b border-border px-3 pb-2.5 pt-3.5">
          <Select
            value={selectedPromptId ?? ''}
            onChange={e => setSelectedPromptId(e.target.value || null)}
            placeholder="Select a prompt…"
            options={prompts.map(p => ({ value: p.id, label: p.name }))}
            size="sm"
            aria-label="Select a prompt"
          />
        </Stack>

        {/* Tabs */}
        <Stack gap="none" className="shrink-0 border-b border-border px-2 pt-2">
          <Tabs
            items={[
              { id: 'versions', label: 'Versions' },
              { id: 'experiments', label: 'All Experiments' },
            ]}
            value={tab}
            onValueChange={id => setTab(id as Tab)}
            variant="underline"
            size="sm"
          />
        </Stack>

        {tab === 'versions' && (
          <>
            {/* Compare toggle */}
            <Inline gap="sm" align="center" justify="between" className="shrink-0 border-b border-border bg-surface-panel px-3 py-2">
              <Inline as="label" gap="xs" align="center" className="text-xs cursor-pointer text-text-secondary">
                <Checkbox
                  checked={compareMode}
                  onChange={checked => { setCompareMode(checked); setSelectedVersions([]); }}
                />
                Compare two versions
              </Inline>
              {compareMode && selectedVersions.length === 2 && (
                <T size="xs" className="text-optimize">
                  {selectedVersions[0]} ↔ {selectedVersions[1]}
                </T>
              )}
            </Inline>

            {versionsLoading && versions.length === 0 && <LoadingState label="Loading versions…" />}
            {versionsError && <T size="xs" className="block px-3.5 py-3 text-danger">{versionsError}</T>}
            {!versionsLoading && !versionsError && versions.length === 0 && (
              <InlinePlaceholder align="center" className="px-3.5 py-3">
                No version history yet.
              </InlinePlaceholder>
            )}

            {versions.map(v => {
              const isSelected = selectedVersions.includes(v.version);
              return (
                <SelectableCard
                  key={v.version}
                  selected={isSelected}
                  onSelect={() => toggleVersion(v.version)}
                  padding="sm"
                  className="block w-full rounded-none border-x-0 border-t-0 text-left"
                >
                  <Inline gap="sm" align="center">
                    <T size="xs" weight="semibold" className="font-mono text-text-primary">
                      {v.version === 'DRAFT' ? 'DRAFT' : `v${v.version}`}
                    </T>
                    <StatusChip status={v.lifecycleStatus} />
                  </Inline>
                  {v.description && (
                    <T size="xs" className="mt-1 block truncate pl-0.5 leading-snug text-text-secondary">
                      {v.description}
                    </T>
                  )}
                  <T size="xs" className="mt-0.5 block pl-0.5 text-text-tertiary">
                    {v.publishedAt ? fmtDate(v.publishedAt) : '—'}
                    {v.experiments.length > 0 && ` · ${v.experiments.length} exp`}
                  </T>
                </SelectableCard>
              );
            })}
          </>
        )}

        {tab === 'experiments' && (
          <>
            {expLoading && <LoadingState label="Loading experiments…" />}
            {expError && <T size="xs" className="block px-3.5 py-3 text-danger">{expError}</T>}
            {!expLoading && !expError && experiments.length === 0 && (
              <InlinePlaceholder align="center" className="px-3.5 py-3">
                No experiments recorded yet.
              </InlinePlaceholder>
            )}
            {experiments.map(exp => (
              <Stack key={exp.experimentId} gap="none" className="border-b border-border px-3.5 py-2.5">
                <Inline gap="sm" align="center" wrap>
                  <ActionBadge action={exp.finalAction || 'IN_PROGRESS'} />
                  <T size="xs" className="font-mono text-text-secondary">
                    v{exp.versionA}→v{exp.versionB}
                  </T>
                </Inline>
                {exp.descriptionB && (
                  <T size="xs" className="mt-0.5 block leading-snug text-text-secondary">{exp.descriptionB}</T>
                )}
                <Inline gap="sm" className="text-xs mt-1 text-text-tertiary">
                  <T size="xs" className="text-text-tertiary">{fmtDate(exp.startedAt)}</T>
                  {exp.scoreDelta !== null && (
                    <T size="xs" weight="semibold" className={`  ${(exp.scoreDelta ?? 0) >= 0 ? 'text-success' : 'text-danger'}`}>
                      {fmtDelta(exp.scoreDelta)}
                    </T>
                  )}
                </Inline>
              </Stack>
            ))}
          </>
        )}
      </Stack>

      {/* ── Right: detail or diff pane ── */}
      <Stack gap="none" className="min-w-0 flex-1 overflow-hidden bg-surface">
        {/* No selection */}
        {!selectedPromptId && (
          <EmptyState title="No prompt selected" description="Select a prompt to view its version history." />
        )}

        {selectedPromptId && !selectedVersion && !inDiffMode && (
          <EmptyState
            title={compareMode ? 'Select two versions' : 'No version selected'}
            description={compareMode
              ? 'Select two versions to compare.'
              : 'Click a version in the timeline to view its detail.'}
          />
        )}

        {/* Single version detail */}
        {selectedVersion && versionDetail && !inDiffMode && (
          <Stack gap="none" className="flex-1 overflow-y-auto">
            <Stack gap="none" className="shrink-0 border-b border-border px-6 pb-4 pt-5">
              <Inline gap="sm" align="center">
                <T size="sm" weight="semibold" className="font-mono ">
                  {selectedVersion === 'DRAFT' ? 'DRAFT' : `v${selectedVersion}`}
                </T>
                <StatusChip status={versionDetail.lifecycleStatus} />
              </Inline>
              {versionDetail.description && (
                <T size="sm" className="mt-2 block leading-relaxed text-text-secondary">
                  {versionDetail.description}
                </T>
              )}
              <Inline gap="md" wrap className="text-xs mt-2 text-text-tertiary">
                {versionDetail.publishedAt && <T size="xs" className="text-text-tertiary">Published {fmtDate(versionDetail.publishedAt)}</T>}
                {versionDetail.deployedAt && <T size="xs" className="text-text-tertiary">Deployed {fmtDate(versionDetail.deployedAt)}</T>}
                {versionDetail.supersededAt && <T size="xs" className="text-text-tertiary">Superseded {fmtDate(versionDetail.supersededAt)}</T>}
                {versionDetail.authorEmail && <T size="xs" className="text-text-tertiary">by {versionDetail.authorEmail}</T>}
              </Inline>
            </Stack>

            {/* Lifecycle timeline */}
            {(versionDetail.publishedAt || versionDetail.deployedAt) && (
              <Inline gap="none" align="center" className="shrink-0 border-b border-border px-6 pb-3 pt-4">
                <LifecycleMilestone label="Published" date={versionDetail.publishedAt} active={!!versionDetail.publishedAt} />
                <LifecycleConnector active={!!versionDetail.deployedAt} />
                <LifecycleMilestone label="Deployed" date={versionDetail.deployedAt} active={!!versionDetail.deployedAt} />
                <LifecycleConnector active={versionDetail.lifecycleStatus === 'promoted' || versionDetail.lifecycleStatus === 'rolled_back'} />
                <LifecycleMilestone
                  label={versionDetail.lifecycleStatus === 'rolled_back' ? 'Rolled Back' : 'Promoted'}
                  date={versionDetail.lifecycleStatus === 'promoted' ? versionDetail.supersededAt : ''}
                  active={versionDetail.lifecycleStatus === 'promoted' || versionDetail.lifecycleStatus === 'rolled_back'}
                  tone={versionDetail.lifecycleStatus === 'rolled_back' ? 'danger' : 'success'}
                />
              </Inline>
            )}

            {/* Template text */}
            <Stack gap="none" className="shrink-0 border-b border-border px-6 py-4">
              <SectionLabel as="div" className="mb-2.5">Template</SectionLabel>
              {text0 ? (
                <CodeBlock code={text0} language="text" />
              ) : (
                <InlinePlaceholder>Template not available.</InlinePlaceholder>
              )}
            </Stack>

            {/* Experiments */}
            {versionDetail.experiments.length > 0 && (
              <Stack gap="sm" className="px-6 py-4">
                <SectionLabel>Experiments using this version</SectionLabel>
                {versionDetail.experiments.map(exp => (
                  <ExperimentCard
                    key={exp.experimentId}
                    exp={exp}
                    role={exp.versionA === selectedVersion ? 'a' : 'b'}
                  />
                ))}
              </Stack>
            )}

            {versionDetail.experiments.length === 0 && (
              <Stack gap="sm" className="px-6 py-4">
                <SectionLabel>Experiments</SectionLabel>
                <InlinePlaceholder>
                  This version hasn't been used in a canary experiment yet.
                </InlinePlaceholder>
              </Stack>
            )}
          </Stack>
        )}

        {/* Diff mode */}
        {inDiffMode && (
          <Stack gap="none" className="flex-1 overflow-y-auto">
            <Stack gap="none" className="shrink-0 border-b border-border px-6 pb-4 pt-5">
              <T size="sm" weight="semibold" className="text-text-primary">
                Comparing v{selectedVersions[0]} → v{selectedVersions[1]}
              </T>
              <T size="xs" className="mt-1 block text-text-secondary">
                Lines added in green, removed in red.
              </T>
            </Stack>
            <Stack gap="none" className="flex-1 px-6 pb-6 pt-0">
              <DiffView
                textA={text0}
                textB={text1}
                labelA={`v${selectedVersions[0]}`}
                labelB={`v${selectedVersions[1]}`}
              />
            </Stack>
          </Stack>
        )}
      </Stack>
    </Inline>
  );
}

// ── Lifecycle milestone ───────────────────────────────────────────────────────

function LifecycleMilestone({ label, date, active, tone }: { label: string; date: string; active: boolean; tone?: 'success' | 'danger' }): React.ReactElement {
  const dotClass = !active
    ? 'border-border-emphasis bg-border'
    : tone === 'danger'
      ? 'border-danger bg-danger'
      : tone === 'success'
        ? 'border-success bg-success'
        : 'border-primary bg-primary';
  const labelClass = !active ? 'text-text-tertiary' : tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-primary';
  return (
    <Stack gap="xs" align="center">
      <Inline as="span" gap="none" className={`h-3 w-3 rounded-full border-2 ${dotClass}`} />
      <T size="xs" weight="semibold" className={`whitespace-nowrap   ${labelClass}`}>{label}</T>
      {date && <T size="xs" className="whitespace-nowrap text-text-tertiary">{fmtDate(date)}</T>}
    </Stack>
  );
}

function LifecycleConnector({ active }: { active: boolean }): React.ReactElement {
  return (
    <Inline as="span" gap="none" className={`mb-6 h-0.5 min-w-[20px] flex-1 ${active ? 'bg-primary' : 'bg-border'}`} />
  );
}
