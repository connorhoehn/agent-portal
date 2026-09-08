// Distillation → Lineage. The provenance graph a person actually asks for:
// which observations became this cluster, which cluster became this
// artifact, which fact it carries, and what it was published as in the
// Library. `?focus=<id>` is the deep link every other distillation surface
// links into (Artifacts' "Open lineage", Compactions' "Produced" rows); with
// no focus, this is a search-first picker over artifacts.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Button, Card, Chip, EmptyState, Inline, LoadingState, PageSection, SearchInput, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { LineageFrame } from './LineageFrame';
import { T } from './Text';
import {
  ARTIFACT_STATUS_TONE, ARTIFACT_TYPE_LABEL, ARTIFACT_TYPE_TONE, LINEAGE_NODE_LABEL,
} from './distillationFormat';
import type { ArtifactsResponse, Lineage, LineageNode } from './types';

export default function DistillationLineagePage() {
  const [params, setParams] = useSearchParams();
  const focus = params.get('focus');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<LineageNode | null>(null);

  const lineageUrl = focus
    ? (focus.startsWith('fact-')
      ? `/api/distillation/facts/${encodeURIComponent(focus)}/lineage`
      : `/api/distillation/items/${encodeURIComponent(focus)}/lineage?depth=3`)
    : null;
  const { data: lineage, isLoading, error } = useFetch<Lineage>(lineageUrl, 30_000);

  const artifactsUrl = !focus ? `/api/distillation/artifacts${query ? `?q=${encodeURIComponent(query)}` : ''}` : null;
  const { data: artifactsData, isLoading: artifactsLoading, error: artifactsError } =
    useFetch<ArtifactsResponse>(artifactsUrl, 0);

  useEffect(() => setSelected(null), [focus]);

  // Esc clears the side panel first, then the focus itself — mirrors how a
  // Drawer/overlay is normally dismissed before the page state under it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (selected) setSelected(null);
      else if (focus) setParams({}, { replace: true });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, focus, setParams]);

  function focusOn(id: string) {
    setParams({ focus: id });
  }

  function selectNode(id: string) {
    const node = lineage?.nodes.find((n) => n.id === id) ?? null;
    setSelected(node);
  }

  if (!focus) {
    return (
      <PageSection
        title="Lineage"
        description="Pick an artifact to trace what it's built from: the clusters that fed it, the observations behind those, and what it was published as."
      >
        <Stack gap="md">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search artifacts by title or summary…"
            aria-label="Search artifacts for lineage"
            className="w-[320px]"
          />
          {artifactsError ? (
            <EmptyState title="Could not load artifacts" description={artifactsError} />
          ) : artifactsLoading && !artifactsData ? (
            <LoadingState label="Loading artifacts…" />
          ) : (artifactsData?.artifacts.length ?? 0) === 0 ? (
            <EmptyState title="No artifacts" description="No artifact matches this search." />
          ) : (
            <Stack gap="xs">
              {artifactsData!.artifacts.map((a) => (
                <Card key={a.id} padding="sm">
                  <Inline gap="sm" align="center" justify="between" wrap={false}>
                    <Inline gap="xs" align="center" wrap={false}>
                      <Chip tone={ARTIFACT_TYPE_TONE[a.type]} size="xs">{ARTIFACT_TYPE_LABEL[a.type]}</Chip>
                      <Chip tone={ARTIFACT_STATUS_TONE[a.status]} size="xs">{a.status}</Chip>
                      <T className="min-w-0 truncate text-[12.5px] font-medium text-text-primary" title={a.title}>{a.title}</T>
                    </Inline>
                    <Button size="sm" variant="secondary" onClick={() => focusOn(a.id)}>View lineage</Button>
                  </Inline>
                </Card>
              ))}
            </Stack>
          )}
        </Stack>
      </PageSection>
    );
  }

  return (
    <PageSection
      title="Lineage"
      description="Observation → cluster → artifact → library item. Click or Tab + Enter a node for its record; Esc clears."
      actions={<Button size="sm" variant="secondary" onClick={() => setParams({}, { replace: true })}>Change artifact</Button>}
    >
      <LineageFrame
        lineage={lineage ?? null}
        loading={isLoading}
        error={error}
        focusId={focus}
        onSelectNode={selectNode}
        aside={selected && (
          <DetailPanel node={selected} onClose={() => setSelected(null)} onFocusHere={() => focusOn(selected.id)} isFocus={selected.id === focus} />
        )}
      />
    </PageSection>
  );
}

function DetailPanel({
  node, onClose, onFocusHere, isFocus,
}: { node: LineageNode; onClose: () => void; onFocusHere: () => void; isFocus: boolean }) {
  const metaEntries = node.meta ? Object.entries(node.meta) : [];
  return (
    <Card padding="sm">
      <Stack gap="sm">
        <Inline gap="sm" align="center" justify="between">
          <Inline gap="xs" align="center">
            <Chip tone="neutral" size="xs">{LINEAGE_NODE_LABEL[node.kind]}</Chip>
            <T className="text-[13px] font-semibold text-text-primary">{node.label}</T>
          </Inline>
          <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
        </Inline>
        {metaEntries.length > 0 && (
          <Stack gap="xs">
            {metaEntries.map(([k, v]) => (
              <Inline key={k} gap="md" align="baseline">
                <T className="w-[120px] shrink-0 text-[11px] text-text-tertiary">{k}</T>
                <T className="min-w-0 flex-1 text-[12px] text-text-primary">{String(v)}</T>
              </Inline>
            ))}
          </Stack>
        )}
        <Button size="sm" variant="primary" disabled={isFocus} onClick={onFocusHere}>
          {isFocus ? 'Already focused here' : 'Focus here'}
        </Button>
      </Stack>
    </Card>
  );
}
