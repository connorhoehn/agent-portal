// Pure org-graph exploration. The previous version of this page bundled the
// canvas with a chat panel against orgiq-search; that chat lives at /search
// now. This page stays focused on visual exploration: click to multi-select,
// dial top-K / min-strength to thin the canvas, jump into Search to ask about
// the current selection.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { OrgGraph } from '../components/org-graph';
import type { GraphPerson, GraphRelationship, GraphDepartment } from '../components/org-graph';
import { useFetch } from '../hooks/useFetch';

interface GraphData {
  nodes: GraphPerson[];
  edges: GraphRelationship[];
  departments: GraphDepartment[];
}

// Cap edges to the strongest-K per node so the canvas stays readable. Edges
// failing minStrength drop out first; then we trim per-node.
function filterEdges(edges: GraphRelationship[], topK: number, minStrength: number): GraphRelationship[] {
  const filtered = edges.filter(e => e.strength >= minStrength);
  const sorted = [...filtered].sort((a, b) => b.strength - a.strength);
  const perNodeCount = new Map<string, number>();
  const kept: GraphRelationship[] = [];
  for (const e of sorted) {
    const sCount = perNodeCount.get(e.source) ?? 0;
    const tCount = perNodeCount.get(e.target) ?? 0;
    if (sCount >= topK && tCount >= topK) continue;
    kept.push(e);
    perNodeCount.set(e.source, sCount + 1);
    perNodeCount.set(e.target, tCount + 1);
  }
  return kept;
}

function ExplorePage() {
  const { data } = useFetch<GraphData>('/api/graph/entities');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [topK, setTopK] = useState(4);
  const [minStrength, setMinStrength] = useState(0.6);

  // ?focus=<id> arrives from /search "related people" cards. Seed the
  // selection with that id and strip the param so a manual reload doesn't
  // keep re-applying it.
  useEffect(() => {
    const focus = searchParams.get('focus');
    if (!focus) return;
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.add(focus);
      return next;
    });
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('focus');
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  // When a selection is active, narrow the canvas to the selected nodes + their
  // direct neighbors so the spatial context stays readable. The full-graph
  // toggle restores everything.
  const [filterToSelection, setFilterToSelection] = useState(true);

  const { visibleNodes, baseEdges } = useMemo(() => {
    if (!data) return { visibleNodes: [] as GraphPerson[], baseEdges: [] as GraphRelationship[] };
    const filterActive = filterToSelection && selectedIds.size > 0;
    if (!filterActive) {
      return { visibleNodes: data.nodes, baseEdges: data.edges };
    }
    const neighbors = new Set<string>();
    for (const e of data.edges) {
      if (selectedIds.has(e.source)) neighbors.add(e.target);
      if (selectedIds.has(e.target)) neighbors.add(e.source);
    }
    const keep = new Set<string>([...selectedIds, ...neighbors]);
    const nodes = data.nodes.filter(n => keep.has(n.id));
    const edges = data.edges.filter(e => keep.has(e.source) && keep.has(e.target));
    return { visibleNodes: nodes, baseEdges: edges };
  }, [data, filterToSelection, selectedIds]);

  const filteredEdges = useMemo(
    () => filterEdges(baseEdges, topK, minStrength),
    [baseEdges, topK, minStrength],
  );

  const isFiltered = filterToSelection && selectedIds.size > 0 && data && visibleNodes.length < data.nodes.length;

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setFilterToSelection(true); // reset for the next selection
  }

  function askInSearch() {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds).join(',');
    navigate(`/iq/search?peopleIds=${encodeURIComponent(ids)}`);
  }

  if (!data) {
    return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading graph…</div>;
  }

  return (
    <div style={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
      <div style={toolbarStyle}>
        <span style={{ fontWeight: 600 }}>Explore</span>
        <span style={{ color: 'var(--color-text-tertiary)' }}>
          <b>{visibleNodes.length}</b>{isFiltered ? ` / ${data.nodes.length}` : ''} people · <b>{filteredEdges.length}</b> edges
        </span>
        {isFiltered && (
          <button onClick={() => setFilterToSelection(false)} style={primaryBtn()}>
            ✕ Show full graph
          </button>
        )}
        <span style={controlStyle}>
          Top-K
          <input type="range" min={1} max={10} value={topK} onChange={e => setTopK(parseInt(e.target.value, 10))} style={{ width: 80 }} />
          <span style={{ width: 16, textAlign: 'right' }}>{topK}</span>
        </span>
        <span style={controlStyle}>
          Min strength
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(minStrength * 100)}
            onChange={e => setMinStrength(parseInt(e.target.value, 10) / 100)}
            style={{ width: 80 }}
          />
          <span style={{ width: 28, textAlign: 'right' }}>{minStrength.toFixed(2)}</span>
        </span>
        <span style={{ flex: 1 }} />
        {selectedIds.size > 0 && (
          <>
            <span style={{ color: 'var(--color-primary)', fontWeight: 600, fontSize: 12 }}>
              {selectedIds.size} selected
            </span>
            <button onClick={clearSelection} style={ghostBtn()}>Clear</button>
            <button onClick={askInSearch} style={primaryBtn()}>Ask in Search →</button>
          </>
        )}
        <Link to="/iq/search" style={ghostBtnLink()}>Open Search</Link>
      </div>

      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <OrgGraph
          people={visibleNodes}
          relationships={filteredEdges}
          departments={data.departments}
          multiSelectIds={selectedIds}
          onToggleMultiSelect={toggleSelect}
          spotlightIds={selectedIds}
        />
        {selectedIds.size === 0 && (
          <div style={hintStyle}>
            Click people to build a selection, then jump into <b>Search</b> to ask about them.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: '8px 16px',
  borderBottom: '1px solid var(--color-border)',
  fontSize: 12,
  background: 'var(--color-surface)',
};
const controlStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  color: 'var(--color-text-secondary)',
};
const hintStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  left: 12,
  padding: '6px 10px',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
};

function primaryBtn(): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '4px 10px',
    background: 'var(--color-primary, #6366f1)',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontWeight: 500,
  };
}
function ghostBtn(): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '4px 10px',
    background: 'var(--color-surface)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}
function ghostBtnLink(): React.CSSProperties {
  return {
    ...ghostBtn(),
    textDecoration: 'none',
    display: 'inline-block',
  };
}

export default ExplorePage;
