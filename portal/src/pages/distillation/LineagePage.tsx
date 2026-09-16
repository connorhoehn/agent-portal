// Distillation → Lineage. The provenance graph a person actually asks for:
// which observations became this cluster, which cluster became this
// artifact, which fact it carries, and what it was published as in the
// Library. `?focus=<id>` is the deep link every other distillation surface
// links into (Artifacts' "Open lineage", Compactions' "Produced" rows); with
// no focus, this is a search-first picker over artifacts.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Banner, Button, Card, Chip, Drawer, EmptyState, Inline, LoadingState, PageSection, SearchInput, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import { KeyValue } from '../../components/KeyValue';
import { ArtifactAssetCard } from './ArtifactAssetCard';
import { ArtifactDrawerBody } from './ArtifactDrawer';
import { LineageFrame } from './LineageFrame';
import { T } from './Text';
import { LINEAGE_NODE_LABEL } from './distillationFormat';
import type { Artifact, ArtifactsResponse, Lineage, LineageNode, ReviewResponse } from './types';

/** POSTs with the session cookie, same fetch shape RecordRunForm/decideReview
 *  already use elsewhere in this feature — no shared helper exists for it
 *  yet, and this is the second and third call site, not the first. */
async function postJson(path: string, body: unknown): Promise<{ ok: boolean; error: string | null }> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true, error: null };
  const parsed = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: parsed.error ?? `HTTP ${res.status}` };
}

// Same cadence TiersPage.tsx set for this exact pattern.
const SEARCH_DEBOUNCE_MS = 250;

export default function DistillationLineagePage() {
  const [params, setParams] = useSearchParams();
  const focus = params.get('focus');
  // `query` drives `artifactsUrl` below — the box shows `searchText` and only
  // commits to `query` (so only re-fetches) `SEARCH_DEBOUNCE_MS` after typing
  // stops. This used to put every keystroke straight into the fetch URL.
  const [query, setQuery] = useState('');
  const { searchText, onSearchChange } = useDebouncedSearch(query, setQuery, SEARCH_DEBOUNCE_MS);
  const [selected, setSelected] = useState<LineageNode | null>(null);
  // The picker's own "expand" drawer — same ArtifactDrawerBody Artifacts
  // uses, so a reader sees the identical record whether they opened it from
  // the table or from here.
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: 'publish' | 'review' } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const lineageUrl = focus
    ? (focus.startsWith('fact-')
      ? `/api/distillation/facts/${encodeURIComponent(focus)}/lineage`
      : `/api/distillation/items/${encodeURIComponent(focus)}/lineage?depth=3`)
    : null;
  const { data: lineage, isLoading, error } = useFetch<Lineage>(lineageUrl, 30_000);

  const artifactsUrl = !focus ? `/api/distillation/artifacts${query ? `?q=${encodeURIComponent(query)}` : ''}` : null;
  const { data: artifactsData, isLoading: artifactsLoading, error: artifactsError, refresh: refreshArtifacts } =
    useFetch<ArtifactsResponse>(artifactsUrl, 0);

  // Which artifacts already have a pending sample — drives "Request review"
  // disabling honestly instead of letting the click 409. Fetched once for
  // the whole picker rather than per card: one list, joined client-side.
  const { data: reviewData, refresh: refreshReview } =
    useFetch<ReviewResponse>(!focus ? '/api/distillation/review?verdict=pending' : null, 0);
  const pendingReviewIds = new Set(
    (reviewData?.samples ?? []).filter((s) => s.target_kind === 'artifact').map((s) => s.target_id),
  );

  const open: Artifact | null = artifactsData?.artifacts.find((a) => a.id === openId) ?? null;

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

  async function handlePublish(id: string) {
    setActionError(null);
    setBusy({ id, action: 'publish' });
    const res = await postJson(`/api/distillation/artifacts/${encodeURIComponent(id)}/publish`, {});
    setBusy(null);
    if (!res.ok) { setActionError(res.error); return; }
    refreshArtifacts();
  }

  async function handleRequestReview(id: string) {
    setActionError(null);
    setBusy({ id, action: 'review' });
    const res = await postJson('/api/distillation/review', { target_kind: 'artifact', target_id: id });
    setBusy(null);
    if (!res.ok) { setActionError(res.error); return; }
    refreshReview();
  }

  if (!focus) {
    return (
      <PageSection
        title="Lineage"
        description="Pick an artifact to trace what it's built from: the clusters that fed it, the observations behind those, and what it was published as."
      >
        <Stack gap="md">
          <SearchInput
            value={searchText}
            onChange={onSearchChange}
            placeholder="Search artifacts by title or summary…"
            aria-label="Search artifacts for lineage"
            className="w-[320px]"
          />
          {actionError && <Banner variant="error">{actionError}</Banner>}
          {artifactsError ? (
            <EmptyState title="Could not load artifacts" description={artifactsError} />
          ) : artifactsLoading && !artifactsData ? (
            <LoadingState label="Loading artifacts…" />
          ) : (artifactsData?.artifacts.length ?? 0) === 0 ? (
            <EmptyState title="No artifacts" description="No artifact matches this search." />
          ) : (
            <Stack gap="xs">
              {artifactsData!.artifacts.map((a) => (
                <ArtifactAssetCard
                  key={a.id}
                  artifact={a}
                  pendingReview={pendingReviewIds.has(a.id)}
                  busy={busy?.id === a.id ? busy.action : null}
                  onOpen={setOpenId}
                  onTraceLineage={focusOn}
                  onPublish={(id) => { void handlePublish(id); }}
                  onRequestReview={(id) => { void handleRequestReview(id); }}
                />
              ))}
            </Stack>
          )}
        </Stack>

        <Drawer open={open != null} onClose={() => setOpenId(null)} aria-label="Artifact detail" width={720}>
          {open && <ArtifactDrawerBody artifact={open} />}
        </Drawer>
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
              <KeyValue key={k} layout="row" labelWidth="w-[120px]" label={k} value={String(v)} />
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
