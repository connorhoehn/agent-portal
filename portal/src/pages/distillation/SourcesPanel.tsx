// The Sources inspector (spec §1): the evidence behind one record, as a List
// (default — source cards) or a Graph (the record's actual lineage, drawn by
// the library's TypedNodeCanvas with its zoom controls, list equivalent one
// toggle away). Shared by Knowledge and Review; the host owns the URL
// (`sourceView`) and where "open a source" goes.
import { useMemo, useState } from 'react';
import { SourceList, TypedNodeCanvas, type TypedCanvasNode } from '@connorhoehnslalom/ui-components';
import {
  Button, Card, EmptyState, FileKindMark, Inline, LoadingState, SegmentedControl, Stack, T,
} from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import type { SourceView } from './distillationRoutes';
import {
  lineageGraph, recordFileKind, sourceRows, sourcesGraph, type GraphNode, type GraphSubject,
} from './sourcesModel';
import type { ItemSourcesResponse, Lineage } from './types';

export function sourcesUrl(id: string): string {
  return `/api/distillation/items/${encodeURIComponent(id)}/sources`;
}

/** The sources read, shared with the record pane (which shows "What the
 *  source run found" from the same response) — one request, not two. */
export function useItemSources(id: string | null) {
  return useFetch<ItemSourcesResponse>(id ? sourcesUrl(id) : null, 0, { share: true });
}

type CanvasNode = TypedCanvasNode<string, GraphNode['data']>;

function toCanvas(nodes: GraphNode[]): CanvasNode[] {
  return nodes.map((n) => ({ id: n.id, kind: n.kind, rank: n.rank, data: n.data, label: `${n.data.subtitle ?? ''} ${n.data.title}`.trim() }));
}

function NodeBody({ node, selected }: { node: CanvasNode; selected: boolean }) {
  return (
    <Card padding="sm" className={selected ? 'h-full ring-2 ring-primary' : 'h-full'}>
      <Stack gap="xs">
        <Inline gap="xs" align="center" wrap={false}>
          <FileKindMark kind={recordFileKind(node.kind)} size="sm" variant="glyph" />
          <T size="xs" className="text-text-tertiary">{node.data.subtitle}</T>
        </Inline>
        <T size="xs" className="line-clamp-3 font-medium text-text-primary" title={node.data.title} wrap>{node.data.title}</T>
      </Stack>
    </Card>
  );
}

export function SourcesPanel({
  subject, view, onViewChange, onOpen,
}: {
  subject: GraphSubject;
  view: SourceView;
  onViewChange: (view: SourceView) => void;
  /** Follow a source: the host navigates (pushing history so Back returns). */
  onOpen: (href: string) => void;
}) {
  const sources = useItemSources(subject.id);
  const lineage = useFetch<Lineage>(
    view === 'graph' ? `/api/distillation/items/${encodeURIComponent(subject.id)}/lineage?depth=2` : null,
    0,
  );
  const [asList, setAsList] = useState(false);
  const rows = useMemo(() => sourceRows(sources.data), [sources.data]);

  // The graph is the item's actual lineage; when that read fails, its direct
  // evidence is still a true (shallower) graph — never an invented one.
  const graph = useMemo(() => {
    const deep = lineageGraph(lineage.data, subject.id);
    return deep.nodes.length > 1 ? deep : sourcesGraph(subject, sources.data);
  }, [lineage.data, sources.data, subject]);

  return (
    <Stack gap="md" className="p-3" data-testid="distillation-sources">
      <SegmentedControl
        aria-label="Sources view"
        value={view}
        onChange={(v) => onViewChange(v === 'graph' ? 'graph' : 'list')}
        options={[{ value: 'list', label: 'List' }, { value: 'graph', label: 'Graph' }]}
      />
      {sources.error ? (
        <UnavailableNotice error={sources.error} what="this record's sources" source="Sources are read from Aurora" onRetry={sources.refresh} />
      ) : sources.isLoading && !sources.data ? (
        <LoadingState label="Loading sources…" />
      ) : view === 'list' ? (
        <SourceList
          aria-label={`Sources of ${subject.title}`}
          emptyLabel="No recorded sources for this record."
          items={rows.map((r) => ({
            id: r.id,
            title: r.title,
            kind: recordFileKind(r.kind),
            timestamp: r.timestamp,
            excerpt: r.excerpt ?? undefined,
            onOpen: r.href ? () => onOpen(r.href!) : undefined,
          }))}
        />
      ) : graph.nodes.length <= 1 ? (
        <EmptyState title="No lineage to draw" description="This record has no recorded sources yet." />
      ) : (
        <Stack gap="xs">
          <Inline justify="between" align="center">
            <T size="xs" className="text-text-tertiary">
              {lineage.isLoading && !lineage.data ? 'Tracing lineage…' : `${graph.nodes.length - 1} linked records`}
            </T>
            <Button size="sm" variant="ghost" onClick={() => setAsList((v) => !v)}>
              {asList ? 'Show graph' : 'Show as list'}
            </Button>
          </Inline>
          <TypedNodeCanvas<CanvasNode>
            aria-label={`Lineage of ${subject.title}`}
            className="h-[420px]"
            nodes={toCanvas(graph.nodes)}
            edges={graph.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label, tone: e.tone }))}
            selectedId={subject.id}
            listFallback={asList}
            nodeWidth={176}
            nodeHeight={88}
            columnGap={72}
            rowGap={16}
            caption="Evidence on the left, what it became on the right."
            renderNode={(node, { selected }) => <NodeBody node={node} selected={selected} />}
            renderListItem={(node) => (
              <T size="xs" className="text-text-primary">{node.data.subtitle} · {node.data.title}</T>
            )}
            onSelectNode={(id) => {
              const href = graph.nodes.find((n) => n.id === id)?.data.href;
              if (href && id !== subject.id) onOpen(href);
            }}
          />
        </Stack>
      )}
    </Stack>
  );
}
