// Diff — side-by-side read-only comparison of any two prompt versions.
//
// Left column: pick Prompt A + version A.
// Right column: pick Prompt B + version B (defaults to same prompt, next version).
// Centre: a prose before/after diff (ChangeDiff) or the two raw templates
// side by side.

import { useState, useEffect, useMemo } from 'react';
import {
  Chip, CodeBlock, EmptyState, Select, SectionLabel, Stack, Inline, Tabs, T, VisuallyHidden,
} from '@connorhoehn/ui-components/shared';
import { usePromptList, usePromptVersions } from '../../components/canary/usePromptLibrary.js';
import type { PromptLibraryEntry } from '../../components/canary/types.js';
import { diffStats, lineDiff } from './diffFormat';
import { DiffFrame } from './DiffFrame';

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
  prompts,
  promptId,
  version,
  versions,
  onPromptChange,
  onVersionChange,
}: {
  label: string;
  /** Lifted to DiffPage — both panes share the SAME prompt list, so it is
      fetched once there instead of once per picker. */
  prompts: PromptLibraryEntry[];
  promptId: string | null;
  version: string | null;
  /** Lifted to DiffPage too. Each pane has its own promptId, so this is
      still a genuinely separate fetch per pane — it just runs once, in the
      parent, instead of once inside this picker on top of whatever the
      parent already fetched for itself. */
  versions: PromptLibraryEntry[];
  onPromptChange: (id: string) => void;
  onVersionChange: (v: string) => void;
}): React.ReactElement {
  return (
    <Stack gap="xs" className="min-w-[220px] flex-1">
      <SectionLabel as="div">{label}</SectionLabel>
      <Select
        value={promptId ?? ''}
        onChange={e => onPromptChange(e.target.value)}
        placeholder="Select prompt…"
        options={prompts.map(p => ({ value: p.id, label: p.name }))}
        size="sm"
        aria-label={`${label} — prompt`}
      />
      <Select
        value={version ?? ''}
        onChange={e => onVersionChange(e.target.value)}
        placeholder="Select version…"
        disabled={!promptId || versions.length === 0}
        options={versions.map(v => ({
          value: v.isDraft ? 'DRAFT' : v.version,
          label: (v.isDraft || v.version === 'DRAFT' ? 'DRAFT' : `v${v.version}`)
            + (v.description ? ` — ${v.description.slice(0, 40)}` : ''),
        }))}
        size="sm"
        aria-label={`${label} — version`}
      />
    </Stack>
  );
}

// ── Diff viewer ───────────────────────────────────────────────────────────────

function DiffViewer({ textA, textB, labelA, labelB }: {
  textA: string; textB: string; labelA: string; labelB: string;
}): React.ReactElement {
  const lines = useMemo(() => lineDiff(textA, textB), [textA, textB]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  const identical = stats.added === 0 && stats.removed === 0;

  return (
    <Stack gap="sm" className="min-h-0 flex-1 p-4">
      <Inline gap="sm" align="center" wrap>
        <T size="xs" weight="semibold" className="font-mono text-text-secondary">{labelA} → {labelB}</T>
        <Chip tone="success" size="xs" mono>+{stats.added}</Chip>
        <Chip tone="danger" size="xs" mono>−{stats.removed}</Chip>
        <Chip tone="neutral" size="xs" mono>{stats.unchanged} unchanged</Chip>
      </Inline>
      {identical ? (
        <T size="sm" className="p-8 text-center text-text-tertiary">✓ Templates are identical.</T>
      ) : (
        <Stack gap="none" className="min-h-0 flex-1 overflow-auto">
          <DiffFrame lines={lines} />
        </Stack>
      )}
    </Stack>
  );
}

// ── Side-by-side template viewer ──────────────────────────────────────────────

function SideBySide({ textA, textB, labelA, labelB }: {
  textA: string; textB: string; labelA: string; labelB: string;
}): React.ReactElement {
  return (
    <Inline gap="none" className="min-h-0 flex-1 overflow-hidden">
      <Stack gap="xs" className="min-w-0 flex-1 overflow-auto border-r border-border p-4">
        <SectionLabel as="div">{labelA}</SectionLabel>
        <CodeBlock code={textA || '(empty)'} language="text" />
      </Stack>
      <Stack gap="xs" className="min-w-0 flex-1 overflow-auto p-4">
        <SectionLabel as="div">{labelB}</SectionLabel>
        <CodeBlock code={textB || '(empty)'} language="text" />
      </Stack>
    </Inline>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type ViewMode = 'diff' | 'side-by-side';

export default function DiffPage(): React.ReactElement {
  const { prompts, error: promptsError } = usePromptList();

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

  // Lifted from PromptVersionPicker — see its comment. `prompts` above is
  // already shared between both panes; these two are the per-pane halves.
  const { versions: versionsA } = usePromptVersions(promptIdA);
  const { versions: versionsB } = usePromptVersions(promptIdB);

  const { text: textA, loading: loadingA } = useTemplateText(promptIdA, versionA);
  const { text: textB, loading: loadingB } = useTemplateText(promptIdB, versionB);

  const promptNameA = prompts.find(p => p.id === promptIdA)?.name ?? '—';
  const promptNameB = prompts.find(p => p.id === promptIdB)?.name ?? '—';
  const labelA = `${promptNameA}${versionA ? ` (${versionA === 'DRAFT' ? 'DRAFT' : `v${versionA}`})` : ''}`;
  const labelB = `${promptNameB}${versionB ? ` (${versionB === 'DRAFT' ? 'DRAFT' : `v${versionB}`})` : ''}`;

  const canCompare = !!(promptIdA && versionA && promptIdB && versionB);
  const loading = loadingA || loadingB;

  // The prompt library gates this page; surface a denial instead of two empty
  // "Select prompt…" pickers that read as "nothing to compare".
  if (promptsError) {
    const denied = /403|forbidden/i.test(promptsError);
    return (
      <Stack gap="none" className="max-w-xl p-10">
        <EmptyState
          title={denied ? 'Prompt diff access needed' : 'Could not load prompts'}
          description={denied
            ? 'Prompt comparison is limited to the org-leader and HR Admin roles. Switch role from the identity menu, top right.'
            : <>The prompt library did not load. {promptsError}</>}
        />
      </Stack>
    );
  }

  return (
    <Stack gap="none" className="h-full min-h-0">
      <VisuallyHidden as="h1">Prompt diff</VisuallyHidden>
      {/* ── Toolbar ── */}
      <Inline gap="md" align="end" wrap className="shrink-0 flex-wrap border-b border-border bg-surface px-5 py-4">
        <PromptVersionPicker
          label="Version A (baseline)"
          prompts={prompts}
          promptId={promptIdA}
          version={versionA}
          versions={versionsA}
          onPromptChange={id => { setPromptIdA(id); setVersionA(null); }}
          onVersionChange={setVersionA}
        />

        <T size="sm" className="shrink-0 pb-1.5 text-text-tertiary">↔</T>

        <PromptVersionPicker
          label="Version B (challenger)"
          prompts={prompts}
          promptId={promptIdB}
          version={versionB}
          versions={versionsB}
          onPromptChange={id => { setPromptIdB(id); setVersionB(null); }}
          onVersionChange={setVersionB}
        />

        <Tabs
          items={[
            { id: 'diff', label: 'Unified diff' },
            { id: 'side-by-side', label: 'Side by side' },
          ]}
          value={viewMode}
          onValueChange={id => setViewMode(id as ViewMode)}
          variant="segmented"
          size="sm"
          className="shrink-0 self-end"
        />
      </Inline>

      {/* ── Main content ── */}
      <Stack gap="none" className="min-h-0 flex-1 overflow-auto">
        {!canCompare && (
          <EmptyState
            icon="⇄"
            title="Nothing to compare yet"
            description="Select a prompt and version in each column above to compare their templates."
          />
        )}

        {canCompare && loading && (
          <T size="sm" className="flex-1 p-10 text-center text-text-tertiary">Loading templates…</T>
        )}

        {canCompare && !loading && viewMode === 'diff' && (
          <DiffViewer textA={textA} textB={textB} labelA={labelA} labelB={labelB} />
        )}

        {canCompare && !loading && viewMode === 'side-by-side' && (
          <SideBySide textA={textA} textB={textB} labelA={labelA} labelB={labelB} />
        )}
      </Stack>
    </Stack>
  );
}
