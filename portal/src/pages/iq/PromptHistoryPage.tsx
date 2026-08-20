// Prompt History — version timeline + experiment outcome log.
//
// Left rail: version timeline for the selected prompt (status dots, lifecycle).
// Right pane: single-version detail OR side-by-side diff (select 2 versions).
// Bottom of detail: experiment cards that used this version.
// Separate "Experiments" tab shows all runs across all prompts.

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { usePromptList, usePromptVersions } from '../../components/canary/usePromptLibrary.js';

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

const STATUS_COLOR: Record<string, string> = {
  promoted:     'var(--color-success)',
  deployed:     'var(--color-primary)',
  published:    'var(--color-text-secondary)',
  rolled_back:  'var(--color-danger)',
  superseded:   'var(--color-text-tertiary)',
  draft:        'var(--color-warning)',
};

const STATUS_LABEL: Record<string, string> = {
  promoted:    'PROMOTED',
  deployed:    'DEPLOYED',
  published:   'PUBLISHED',
  rolled_back: 'ROLLED BACK',
  superseded:  'SUPERSEDED',
  draft:       'DRAFT',
};

const ACTION_COLOR: Record<string, { bg: string; text: string }> = {
  PROMOTE:     { bg: 'var(--color-success-bg)', text: 'var(--color-success)' },
  ROLLBACK:    { bg: 'var(--color-danger-bg)', text: 'var(--color-danger)' },
  HALTED:      { bg: 'var(--color-warning-bg)', text: 'var(--color-warning)' },
  IN_PROGRESS: { bg: '#ede9fe', text: 'var(--color-optimize-hover)' },
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

// ── Simple LCS-based line diff ────────────────────────────────────────────────

type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string };

function lineDiff(a: string, b: string): DiffLine[] {
  const la = a.split('\n');
  const lb = b.split('\n');
  const m = la.length, n = lb.length;
  // DP table for LCS lengths
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
      result.push({ kind: 'same', text: la[i]! });
      i++; j++;
    } else if (j < n && (i >= m || (dp[i + 1]?.[j] ?? 0) <= (dp[i]?.[j + 1] ?? 0))) {
      result.push({ kind: 'add', text: lb[j]! });
      j++;
    } else {
      result.push({ kind: 'remove', text: la[i]! });
      i++;
    }
  }
  return result;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }): React.ReactElement {
  const color = STATUS_COLOR[status] ?? 'var(--color-text-tertiary)';
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em',
      padding: '2px 6px', borderRadius: 3, border: `1px solid ${color}`,
      color, background: `${color}18`,
    }}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function ActionBadge({ action }: { action: string }): React.ReactElement {
  const c = ACTION_COLOR[action] ?? { bg: 'var(--color-surface-hover)', text: 'var(--color-text-secondary)' };
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 3,
      background: c.bg, color: c.text,
    }}>
      {action}
    </span>
  );
}

function ExperimentCard({ exp, role }: { exp: ExperimentRef; role: 'a' | 'b' }): React.ReactElement {
  const deltaPositive = (exp.scoreDelta ?? 0) >= 0;
  return (
    <div style={expCardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <ActionBadge action={exp.finalAction || 'IN_PROGRESS'} />
        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          v{exp.versionA} vs v{exp.versionB} · used as {role.toUpperCase()}
        </span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 'auto' }}>
          {fmtDate(exp.startedAt)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
        <div style={scoreBoxStyle}>
          <div style={scoreLabelStyle}>Score A</div>
          <div style={scoreValStyle}>{fmtScore(exp.scoreA)}</div>
        </div>
        <div style={scoreBoxStyle}>
          <div style={scoreLabelStyle}>Score B</div>
          <div style={scoreValStyle}>{fmtScore(exp.scoreB)}</div>
        </div>
        <div style={scoreBoxStyle}>
          <div style={scoreLabelStyle}>Δ</div>
          <div style={{ ...scoreValStyle, color: deltaPositive ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 700 }}>
            {fmtDelta(exp.scoreDelta)}
          </div>
        </div>
        <div style={scoreBoxStyle}>
          <div style={scoreLabelStyle}>Decisions</div>
          <div style={scoreValStyle}>{exp.decisionCount}</div>
        </div>
      </div>
    </div>
  );
}

function DiffView({ textA, textB, labelA, labelB }: { textA: string; textB: string; labelA: string; labelB: string }): React.ReactElement {
  const lines = lineDiff(textA, textB);
  const added = lines.filter(l => l.kind === 'add').length;
  const removed = lines.filter(l => l.kind === 'remove').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}>{labelA} → {labelB}</span>
        <span style={{ fontSize: 11, color: 'var(--color-success)' }}>+{added}</span>
        <span style={{ fontSize: 11, color: 'var(--color-danger)' }}>−{removed}</span>
      </div>
      <div style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6, border: '1px solid var(--color-border)', borderRadius: 4, overflow: 'auto', flex: 1 }}>
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 8,
              padding: '1px 12px',
              background: line.kind === 'add' ? 'var(--color-success-bg)' : line.kind === 'remove' ? 'var(--color-danger-bg)' : 'transparent',
              color: line.kind === 'same' ? 'var(--color-text-primary)' : line.kind === 'add' ? 'var(--color-success)' : 'var(--color-danger)',
            }}
          >
            <span style={{ width: 12, flexShrink: 0, userSelect: 'none', opacity: 0.6 }}>
              {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
            </span>
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{line.text}</span>
          </div>
        ))}
      </div>
    </div>
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

  return { versions, loading, error };
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

  return { templateText, loading };
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
      <div style={{ padding: 40, maxWidth: 560 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
          {denied ? 'Prompt history access needed' : 'Could not load prompt history'}
        </h2>
        <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
          {denied
            ? 'Prompt history is limited to the org-leader and HR Admin roles. Switch role from the identity menu, top right.'
            : <>The prompt library did not load. {promptsError}</>}
        </p>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      {/* ── Left: prompt selector + version timeline ── */}
      <div style={leftRailStyle}>
        {/* Prompt picker */}
        <div style={promptPickerStyle}>
          <select
            value={selectedPromptId ?? ''}
            onChange={e => setSelectedPromptId(e.target.value || null)}
            style={promptSelectStyle}
          >
            <option value="">Select a prompt…</option>
            {prompts.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Tabs */}
        <div style={tabBarStyle}>
          <button type="button" style={tab === 'versions' ? activeTabStyle : inactiveTabStyle} onClick={() => setTab('versions')}>
            Versions
          </button>
          <button type="button" style={tab === 'experiments' ? activeTabStyle : inactiveTabStyle} onClick={() => setTab('experiments')}>
            All Experiments
          </button>
        </div>

        {tab === 'versions' && (
          <>
            {/* Compare toggle */}
            <div style={compareToggleBarStyle}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={compareMode}
                  onChange={e => { setCompareMode(e.target.checked); setSelectedVersions([]); }}
                />
                Compare two versions
              </label>
              {compareMode && selectedVersions.length === 2 && (
                <span style={{ fontSize: 10, color: 'var(--color-optimize)' }}>
                  {selectedVersions[0]} ↔ {selectedVersions[1]}
                </span>
              )}
            </div>

            {versionsLoading && <div style={listMsgStyle}>Loading…</div>}
            {versionsError && <div style={{ ...listMsgStyle, color: 'var(--color-danger)' }}>{versionsError}</div>}
            {!versionsLoading && !versionsError && versions.length === 0 && (
              <div style={listMsgStyle}>No version history yet.</div>
            )}

            {versions.map(v => {
              const color = STATUS_COLOR[v.lifecycleStatus] ?? 'var(--color-text-tertiary)';
              const isSelected = selectedVersions.includes(v.version);
              return (
                <button
                  key={v.version}
                  type="button"
                  onClick={() => toggleVersion(v.version)}
                  style={{
                    ...versionRowStyle,
                    borderLeft: `3px solid ${isSelected ? color : 'transparent'}`,
                    background: isSelected ? `${color}12` : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace', color: 'var(--color-text-primary)' }}>
                      {v.version === 'DRAFT' ? 'DRAFT' : `v${v.version}`}
                    </span>
                    <StatusChip status={v.lifecycleStatus} />
                  </div>
                  {v.description && (
                    <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4, paddingLeft: 16, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {v.description}
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2, paddingLeft: 16 }}>
                    {v.publishedAt ? fmtDate(v.publishedAt) : '—'}
                    {v.experiments.length > 0 && ` · ${v.experiments.length} exp`}
                  </div>
                </button>
              );
            })}
          </>
        )}

        {tab === 'experiments' && (
          <>
            {expLoading && <div style={listMsgStyle}>Loading…</div>}
            {expError && <div style={{ ...listMsgStyle, color: 'var(--color-danger)' }}>{expError}</div>}
            {!expLoading && !expError && experiments.length === 0 && (
              <div style={listMsgStyle}>No experiments recorded yet.</div>
            )}
            {experiments.map(exp => (
              <div key={exp.experimentId} style={expListRowStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <ActionBadge action={exp.finalAction || 'IN_PROGRESS'} />
                  <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--color-text-secondary)' }}>
                    v{exp.versionA}→v{exp.versionB}
                  </span>
                </div>
                {exp.descriptionB && (
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 3, lineHeight: 1.4 }}>{exp.descriptionB}</div>
                )}
                <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                  <span>{fmtDate(exp.startedAt)}</span>
                  {exp.scoreDelta !== null && (
                    <span style={{ color: (exp.scoreDelta ?? 0) >= 0 ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 600 }}>
                      {fmtDelta(exp.scoreDelta)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* ── Right: detail or diff pane ── */}
      <div style={detailPaneStyle}>
        {/* No selection */}
        {!selectedPromptId && (
          <div style={emptyDetailStyle}>
            <p style={emptyMsgStyle}>Select a prompt to view its version history.</p>
          </div>
        )}

        {selectedPromptId && !selectedVersion && !inDiffMode && (
          <div style={emptyDetailStyle}>
            <p style={emptyMsgStyle}>
              {compareMode
                ? 'Select two versions to compare.'
                : 'Click a version in the timeline to view its detail.'}
            </p>
          </div>
        )}

        {/* Single version detail */}
        {selectedVersion && versionDetail && !inDiffMode && (
          <div style={detailScrollStyle}>
            <div style={detailHeaderStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace' }}>
                  {selectedVersion === 'DRAFT' ? 'DRAFT' : `v${selectedVersion}`}
                </span>
                <StatusChip status={versionDetail.lifecycleStatus} />
              </div>
              {versionDetail.description && (
                <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '8px 0 0', lineHeight: 1.5 }}>
                  {versionDetail.description}
                </p>
              )}
              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'var(--color-text-tertiary)', flexWrap: 'wrap' }}>
                {versionDetail.publishedAt && <span>Published {fmtDate(versionDetail.publishedAt)}</span>}
                {versionDetail.deployedAt && <span>Deployed {fmtDate(versionDetail.deployedAt)}</span>}
                {versionDetail.supersededAt && <span>Superseded {fmtDate(versionDetail.supersededAt)}</span>}
                {versionDetail.authorEmail && <span>by {versionDetail.authorEmail}</span>}
              </div>
            </div>

            {/* Lifecycle timeline */}
            {(versionDetail.publishedAt || versionDetail.deployedAt) && (
              <div style={lifecycleBarStyle}>
                <LifecycleMilestone label="Published" date={versionDetail.publishedAt} active={!!versionDetail.publishedAt} />
                <LifecycleConnector active={!!versionDetail.deployedAt} />
                <LifecycleMilestone label="Deployed" date={versionDetail.deployedAt} active={!!versionDetail.deployedAt} />
                <LifecycleConnector active={versionDetail.lifecycleStatus === 'promoted' || versionDetail.lifecycleStatus === 'rolled_back'} />
                <LifecycleMilestone
                  label={versionDetail.lifecycleStatus === 'rolled_back' ? 'Rolled Back' : 'Promoted'}
                  date={versionDetail.lifecycleStatus === 'promoted' ? versionDetail.supersededAt : ''}
                  active={versionDetail.lifecycleStatus === 'promoted' || versionDetail.lifecycleStatus === 'rolled_back'}
                  color={versionDetail.lifecycleStatus === 'rolled_back' ? 'var(--color-danger)' : 'var(--color-success)'}
                />
              </div>
            )}

            {/* Template text */}
            <div style={templateSectionStyle}>
              <div style={sectionTitleStyle}>Template</div>
              {text0 ? (
                <pre style={templatePreStyle}>{text0}</pre>
              ) : (
                <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontStyle: 'italic', margin: 0 }}>Template not available.</p>
              )}
            </div>

            {/* Experiments */}
            {versionDetail.experiments.length > 0 && (
              <div style={expSectionStyle}>
                <div style={sectionTitleStyle}>Experiments using this version</div>
                {versionDetail.experiments.map(exp => (
                  <ExperimentCard
                    key={exp.experimentId}
                    exp={exp}
                    role={exp.versionA === selectedVersion ? 'a' : 'b'}
                  />
                ))}
              </div>
            )}

            {versionDetail.experiments.length === 0 && (
              <div style={expSectionStyle}>
                <div style={sectionTitleStyle}>Experiments</div>
                <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', margin: 0 }}>
                  This version hasn't been used in a canary experiment yet.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Diff mode */}
        {inDiffMode && (
          <div style={detailScrollStyle}>
            <div style={detailHeaderStyle}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                Comparing v{selectedVersions[0]} → v{selectedVersions[1]}
              </div>
              <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '4px 0 0' }}>
                Lines added in green, removed in red.
              </p>
            </div>
            <div style={{ padding: '0 24px 24px', flex: 1, display: 'flex', flexDirection: 'column' }}>
              <DiffView
                textA={text0}
                textB={text1}
                labelA={`v${selectedVersions[0]}`}
                labelB={`v${selectedVersions[1]}`}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Lifecycle milestone ───────────────────────────────────────────────────────

function LifecycleMilestone({ label, date, active, color }: { label: string; date: string; active: boolean; color?: string }): React.ReactElement {
  const c = color ?? (active ? 'var(--color-primary)' : 'var(--color-border)');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ width: 12, height: 12, borderRadius: '50%', background: active ? c : 'var(--color-border)', border: `2px solid ${active ? c : 'var(--color-border-emphasis)'}` }} />
      <span style={{ fontSize: 10, fontWeight: 600, color: active ? c : 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{label}</span>
      {date && <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{fmtDate(date)}</span>}
    </div>
  );
}

function LifecycleConnector({ active }: { active: boolean }): React.ReactElement {
  return (
    <div style={{ flex: 1, height: 2, background: active ? 'var(--color-primary)' : 'var(--color-border)', marginBottom: 24, minWidth: 20 }} />
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  display: 'flex',
  height: '100%',
  minHeight: 0,
  margin: -24,
};

const leftRailStyle: CSSProperties = {
  width: 260,
  flexShrink: 0,
  borderRight: '1px solid var(--color-border)',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--color-surface)',
  overflowY: 'auto',
};

const promptPickerStyle: CSSProperties = {
  padding: '14px 12px 10px',
  borderBottom: '1px solid var(--color-border)',
  flexShrink: 0,
};

const promptSelectStyle: CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 12,
  border: '1px solid var(--color-border)',
  borderRadius: 5,
  background: 'var(--color-surface-panel)',
  color: 'var(--color-text-primary)',
  outline: 'none',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const tabBarStyle: CSSProperties = {
  display: 'flex',
  borderBottom: '1px solid var(--color-border)',
  flexShrink: 0,
};

const activeTabStyle: CSSProperties = {
  flex: 1,
  padding: '9px 0',
  fontSize: 11,
  fontWeight: 700,
  border: 'none',
  borderBottom: '2px solid var(--color-primary)',
  background: 'transparent',
  color: 'var(--color-primary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const inactiveTabStyle: CSSProperties = {
  flex: 1,
  padding: '9px 0',
  fontSize: 11,
  fontWeight: 500,
  border: 'none',
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--color-text-tertiary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const compareToggleBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 12px',
  borderBottom: '1px solid var(--color-border)',
  background: 'var(--color-surface-panel)',
  flexShrink: 0,
};

const listMsgStyle: CSSProperties = {
  padding: '12px 14px',
  fontSize: 12,
  color: 'var(--color-text-tertiary)',
};

const versionRowStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '10px 12px',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--color-border)',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
  transition: 'background 0.1s',
};

const expListRowStyle: CSSProperties = {
  padding: '10px 14px',
  borderBottom: '1px solid var(--color-border)',
};

const detailPaneStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--color-surface)',
  overflow: 'hidden',
};

const emptyDetailStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 40,
};

const emptyMsgStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-tertiary)',
  margin: 0,
  textAlign: 'center',
};

const detailScrollStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
};

const detailHeaderStyle: CSSProperties = {
  padding: '20px 24px 16px',
  borderBottom: '1px solid var(--color-border)',
  flexShrink: 0,
};

const lifecycleBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 0,
  padding: '16px 24px 12px',
  borderBottom: '1px solid var(--color-border)',
  flexShrink: 0,
};

const templateSectionStyle: CSSProperties = {
  padding: '16px 24px',
  borderBottom: '1px solid var(--color-border)',
  flexShrink: 0,
};

const expSectionStyle: CSSProperties = {
  padding: '16px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--color-text-tertiary)',
  marginBottom: 10,
};

const templatePreStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 12,
  lineHeight: 1.7,
  padding: '14px 16px',
  margin: 0,
  background: 'var(--color-surface-panel)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'var(--color-text-primary)',
};

const expCardStyle: CSSProperties = {
  padding: '12px 14px',
  background: 'var(--color-surface-panel)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
};

const scoreBoxStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
  minWidth: 48,
};

const scoreLabelStyle: CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--color-text-tertiary)',
};

const scoreValStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'monospace',
  color: 'var(--color-text-primary)',
};
