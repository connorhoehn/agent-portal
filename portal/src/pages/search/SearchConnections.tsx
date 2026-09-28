import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, Handle, MarkerType, Panel, Position, ReactFlow, ReactFlowProvider,
  useReactFlow, useViewport, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button, EmptyState, FileKindMark, Inline, SegmentedControl, Select, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import type { SearchEdge, SearchRecord, SearchRecordType } from './searchTypes';
import {
  filterSearchGraph, graphRecordKey, layoutSearchGraph, SEARCH_GRAPH_NODE_HEIGHT,
  SEARCH_GRAPH_NODE_WIDTH, SEARCH_GRAPH_TYPES, type SearchGraphLayout,
} from './searchGraph';
import './searchConnections.css';

export interface SearchConnectionsProps {
  records: SearchRecord[];
  edges: SearchEdge[];
  selectedKeys: string[];
  onSelectionChange: (keys: string[]) => void;
  onAskSelection: () => void;
  onOpenRecord?: (record: SearchRecord) => void;
  layout?: SearchGraphLayout;
  onLayoutChange?: (layout: SearchGraphLayout) => void;
  typeFilter?: SearchRecordType | 'all';
  onTypeFilterChange?: (type: SearchRecordType | 'all') => void;
}

type RecordNode = Node<{ record: SearchRecord; selected: boolean; onToggle: (key: string) => void }, 'record'>;

const TYPE_LABELS: Record<SearchRecordType, string> = {
  person: 'Person', initiative: 'Initiative', work: 'Work', decision: 'Decision', knowledge: 'Knowledge', asset: 'Agent library',
};

function ConnectionNode({ id, data }: NodeProps<RecordNode>) {
  const { record, selected, onToggle } = data;
  const initials = record.title.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('');
  return (
    <Stack gap="none" className="search-connection-node">
      <Handle type="target" position={Position.Left} className="search-connection-handle" />
      <Button variant="ghost" onClick={() => onToggle(id)} aria-pressed={selected}
        aria-label={`${TYPE_LABELS[record.type]}: ${record.title}${record.status ? `, ${record.status}` : ''}`}
        className="search-connection-button nodrag" title={record.description ?? record.title}>
        <Stack gap="xs" align="center" className="w-full min-w-0">
          <Inline as="span" align="center" justify="center" className={`search-connection-mark search-connection-${record.type}${selected ? ' is-selected' : ''}`}>
            {record.type === 'person'
              ? <T className="font-semibold text-sm">{initials}</T>
              : <FileKindMark kind={record.type === 'asset' ? 'workflow' : 'page'} size="md" variant="glyph" />}
            {selected && <T as="span" className="search-connection-check" aria-hidden="true">✓</T>}
          </Inline>
          <T className="line-clamp-2 text-[13px] font-medium leading-tight text-text-primary" wrap>{record.title}</T>
          <T className={`truncate max-w-full text-xs ${record.status === 'blocked' ? 'text-danger' : 'text-text-secondary'}`}>
            {record.status?.replace(/_/g, ' ') || record.subtitle || TYPE_LABELS[record.type]}
          </T>
        </Stack>
      </Button>
      <Handle type="source" position={Position.Right} className="search-connection-handle" />
    </Stack>
  );
}

const NODE_TYPES = { record: ConnectionNode };

function GraphControls({ fullscreen, onFullscreen }: { fullscreen: boolean; onFullscreen: () => void }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <Panel position="bottom-right">
      <Inline gap="xs" wrap={false} className="rounded-md bg-surface p-1">
        <Button size="sm" variant="secondary" aria-label="Zoom out" onClick={() => void zoomOut()}>−</Button>
        <T className="min-w-10 text-center text-xs text-text-secondary" aria-live="polite">{Math.round(zoom * 100)}%</T>
        <Button size="sm" variant="secondary" aria-label="Zoom in" onClick={() => void zoomIn()}>+</Button>
        <Button size="sm" variant="secondary" onClick={() => void fitView({ padding: 0.15, maxZoom: 1 })}>Fit</Button>
        <Button size="sm" variant="secondary" aria-label={fullscreen ? 'Exit full screen' : 'Full screen connections'} onClick={onFullscreen}>⛶</Button>
      </Inline>
    </Panel>
  );
}

function FitOnGraphChange({ graphKey }: { graphKey: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const frame = requestAnimationFrame(() => void fitView({ padding: 0.15, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [graphKey, fitView]);
  return null;
}

/** The graph shares record IDs and selection with Results and Answer. */
export function SearchConnections({ records, edges, selectedKeys, onSelectionChange, onAskSelection, onOpenRecord,
  layout: controlledLayout, onLayoutChange, typeFilter: controlledType, onTypeFilterChange }: SearchConnectionsProps) {
  const [localLayout, setLocalLayout] = useState<SearchGraphLayout>('force');
  const [localType, setLocalType] = useState<SearchRecordType | 'all'>('all');
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const layout = controlledLayout ?? localLayout;
  const type = controlledType ?? localType;
  const graph = useMemo(() => filterSearchGraph(records, edges, type), [records, edges, type]);
  const positions = useMemo(() => layoutSearchGraph(graph.records, graph.edges, layout), [graph, layout]);
  const selected = new Set(selectedKeys);
  const selectedRecords = records.filter(record => selected.has(graphRecordKey(record)));
  const nodes: RecordNode[] = graph.records.map(record => {
    const id = graphRecordKey(record);
    return { id, type: 'record', position: positions.get(id)!, initialWidth: SEARCH_GRAPH_NODE_WIDTH,
      initialHeight: SEARCH_GRAPH_NODE_HEIGHT, data: { record, selected: selected.has(id), onToggle: key => {
        onSelectionChange(selected.has(key) ? selectedKeys.filter(item => item !== key) : [...selectedKeys, key]);
      } } };
  });
  const graphEdges = graph.edges.map(edge => ({ ...edge, label: edge.label, type: 'default',
    markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
    className: /related (result|match)/i.test(edge.label) ? 'search-connection-related-edge' : undefined,
  }));
  const graphKey = `${layout}:${graph.records.map(graphRecordKey).join('|')}:${graph.edges.map(edge => edge.id).join('|')}`;

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  const toggleFullscreen = async () => {
    try {
      setFullscreenError(false);
      if (document.fullscreenElement === container.current) await document.exitFullscreen();
      else await container.current?.requestFullscreen();
    } catch { setFullscreenError(true); }
  };

  return (
    <Stack ref={container} gap="none" className="search-connections min-h-0 flex-1 bg-surface" data-testid="search-connections">
      <Inline gap="sm" align="center" className="border-b border-border py-2 px-1 shrink-0">
        <SegmentedControl size="sm" aria-label="Connection layout" value={layout}
          options={[{ value: 'force', label: 'Force' }, { value: 'radial', label: 'Radial' }, { value: 'hierarchy', label: 'Hierarchy' }]}
          onChange={value => { setLocalLayout(value as SearchGraphLayout); onLayoutChange?.(value as SearchGraphLayout); }} />
        <Select aria-label="Connection record type" size="sm" className="w-auto min-w-28" value={type}
          options={[{ value: 'all', label: 'All types' }, ...SEARCH_GRAPH_TYPES]}
          onChange={event => { const next = event.target.value as SearchRecordType | 'all'; setLocalType(next); onTypeFilterChange?.(next); }} />
        <T className="text-xs text-text-secondary">{graph.records.length} records · {graph.edges.length} connections</T>
        <Inline gap="xs" align="center" className="ml-auto">
          <T className="text-xs text-primary" aria-live="polite">{selectedKeys.length} selected</T>
          {selectedRecords.length === 1 && onOpenRecord && <Button size="sm" variant="secondary" onClick={() => onOpenRecord(selectedRecords[0])}>Open record ↗</Button>}
          <Button size="sm" variant="secondary" disabled={!selectedKeys.length} onClick={() => onSelectionChange([])}>Clear</Button>
          <Button size="sm" disabled={!selectedRecords.length} onClick={onAskSelection}>Ask about selection →</Button>
        </Inline>
      </Inline>
      {fullscreenError && <T role="status" className="px-2 py-1 text-xs text-text-secondary">Full screen is unavailable in this browser.</T>}
      {!graph.records.length ? <EmptyState title="No connections to show" description="Choose another record type or search for records." /> : (
        <Stack gap="none" className="search-connection-canvas flex-1 min-h-64 relative">
          <ReactFlowProvider>
            <ReactFlow nodes={nodes} edges={graphEdges} nodeTypes={NODE_TYPES} fitView
              fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.15} maxZoom={2}
              nodesDraggable={false} nodesConnectable={false} nodesFocusable={false}
              edgesFocusable={false} elementsSelectable={false} onlyRenderVisibleElements
              proOptions={{ hideAttribution: true }} aria-label="Search record connections">
              <Background color="var(--color-border)" gap={22} size={1} />
              <FitOnGraphChange graphKey={graphKey} />
              <Panel position="bottom-left">
                <Inline gap="sm" className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-secondary">
                  {SEARCH_GRAPH_TYPES.filter(item => graph.records.some(record => record.type === item.value)).map(item => (
                    <Inline key={item.value} gap="xs" align="center" as="span">
                      <Inline as="span" className={`search-connection-legend-dot search-connection-${item.value}`} />{item.label}
                    </Inline>
                  ))}
                </Inline>
              </Panel>
              <GraphControls fullscreen={fullscreen} onFullscreen={() => void toggleFullscreen()} />
            </ReactFlow>
          </ReactFlowProvider>
        </Stack>
      )}
    </Stack>
  );
}
