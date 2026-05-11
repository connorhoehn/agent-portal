import { useMemo, useState, useEffect, useRef } from 'react';
import { Card } from '@connorhoehnslalom/ui-components/shared';
import { OrgGraph } from '../components/org-graph';
import type { GraphPerson, GraphRelationship, GraphDepartment } from '../components/org-graph';
import { useAgUiStream } from '../hooks/useAgUiStream';
import { useFetch } from '../hooks/useFetch';

interface GraphData {
  nodes: GraphPerson[];
  edges: GraphRelationship[];
  departments: GraphDepartment[];
}

// Filter edges down to the strongest-K per node so the canvas stays readable.
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

// Parse references from streaming assistant text. We support two patterns:
//   1. Explicit [[id|Display Name]] markers — emitted by agents that play along
//   2. Bare names matching anyone in the people list — name-based fallback
//
// The Bedrock guardrail's PROMPT_ATTACK filter blocks middleware-side prompts
// that instruct the agent to emit markers, so the fallback is the main path.
type Seg = { kind: 'text'; body: string } | { kind: 'ref'; id: string; name: string };
const REF_RE = /\[\[([a-zA-Z0-9_-]+)\|([^\]]+)\]\]/g;

// Escape a name so it can be safely embedded in a regex.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace bare full names in text with placeholder marker tokens, then parse.
// This catches "Sienna Cole" in "1. **Sienna Cole** — Email: …" and turns it
// into a clickable pill that highlights the node on the graph.
function parseSegments(text: string, people: GraphPerson[]): Seg[] {
  // First, normalize any explicit [[id|name]] markers into a placeholder form
  // we'll re-detect at the end. Then strip simple Markdown bold around names so
  // matching is easier.
  let working = text;

  // Capture explicit markers and replace with a sentinel pattern that survives
  // markdown stripping.
  const explicit: Array<{ id: string; name: string }> = [];
  working = working.replace(REF_RE, (_m, id, name) => {
    const i = explicit.length;
    explicit.push({ id, name });
    return `\x01REF${i}\x01`;
  });

  // Strip markdown bold so the matcher sees "Sienna Cole" not "**Sienna Cole**".
  working = working.replace(/\*\*([^*]+)\*\*/g, '$1');

  // For every distinct name in the people list, replace occurrences with a
  // sentinel. Sort longest-first so "Sarah Ahmed" wins over "Sarah".
  const sorted = [...people].sort((a, b) => b.name.length - a.name.length);
  for (const p of sorted) {
    // Word boundaries so "Carlos" doesn't match inside "Carlos Lee" twice.
    const re = new RegExp(`(?<![\\w])${escapeRe(p.name)}(?![\\w])`, 'gi');
    working = working.replace(re, () => {
      const i = explicit.length;
      explicit.push({ id: p.id, name: p.name });
      return `\x01REF${i}\x01`;
    });
  }

  // Split by the sentinel.
  const out: Seg[] = [];
  const parts = working.split(/\x01REF(\d+)\x01/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) out.push({ kind: 'text', body: parts[i]! });
    } else {
      const ref = explicit[parseInt(parts[i]!, 10)];
      if (ref) out.push({ kind: 'ref', id: ref.id, name: ref.name });
    }
  }
  return out;
}

function extractRefIds(text: string, people: GraphPerson[]): string[] {
  const segments = parseSegments(text, people);
  const ids = new Set<string>();
  for (const s of segments) {
    if (s.kind === 'ref') ids.add(s.id);
  }
  return Array.from(ids);
}

function ExplorePage() {
  const { data } = useFetch<GraphData>('/api/graph/entities');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [hoveredRef, setHoveredRef] = useState<string | null>(null);
  const [topK, setTopK] = useState(4);
  const [minStrength, setMinStrength] = useState(0.6);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const {
    messages,
    isStreaming,
    error,
    sendMessage,
    reset,
  } = useAgUiStream('/api/agents/orgiq-search/invoke');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isStreaming]);

  const filteredEdges = useMemo(
    () => (data ? filterEdges(data.edges, topK, minStrength) : []),
    [data, topK, minStrength],
  );

  // IDs the agent cited in its last assistant turn → drives the spotlight.
  const citedIds = useMemo(() => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant || !data) return new Set<string>();
    return new Set(extractRefIds(lastAssistant.content, data.nodes));
  }, [messages, data]);

  // Combine cited + hovered ref into a spotlight set.
  const spotlight = useMemo(() => {
    const s = new Set(citedIds);
    if (hoveredRef) s.add(hoveredRef);
    return s;
  }, [citedIds, hoveredRef]);

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
  }

  function askAboutSelection() {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    sendMessage(`What do these people have in common, and what's a good question to ask them as a group?`, {
      selection: { peopleIds: ids },
    });
  }

  function handleSend() {
    if (!input.trim() || isStreaming) return;
    const ids = Array.from(selectedIds);
    sendMessage(input.trim(), ids.length > 0 ? { selection: { peopleIds: ids } } : undefined);
    setInput('');
  }

  if (!data) {
    return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading graph...</div>;
  }

  return (
    <div style={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
      {/* Top controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '8px 16px', borderBottom: '1px solid var(--color-border)', fontSize: 12 }}>
        <span style={{ fontWeight: 600 }}>Explore</span>
        <span style={{ color: 'var(--color-text-tertiary)' }}>
          <b>{data.nodes.length}</b> people · <b>{filteredEdges.length}</b> / {data.edges.length} edges shown
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)' }}>
          Top-K
          <input type="range" min={1} max={10} value={topK} onChange={e => setTopK(parseInt(e.target.value, 10))} style={{ width: 80 }} />
          <span style={{ width: 16, textAlign: 'right' }}>{topK}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)' }}>
          Min strength
          <input type="range" min={0} max={100} value={Math.round(minStrength * 100)} onChange={e => setMinStrength(parseInt(e.target.value, 10) / 100)} style={{ width: 80 }} />
          <span style={{ width: 28, textAlign: 'right' }}>{minStrength.toFixed(2)}</span>
        </span>
        <span style={{ flex: 1 }} />
        {selectedIds.size > 0 && (
          <>
            <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>{selectedIds.size} selected</span>
            <button onClick={clearSelection} style={btn()}>Clear</button>
            <button onClick={askAboutSelection} style={btn(true)}>Ask about selection</button>
          </>
        )}
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Graph */}
        <div style={{ flex: 1, position: 'relative' }}>
          <OrgGraph
            people={data.nodes}
            relationships={filteredEdges}
            departments={data.departments}
            multiSelectIds={selectedIds}
            onToggleMultiSelect={toggleSelect}
            spotlightIds={spotlight}
          />
        </div>

        {/* Chat */}
        <div style={{ width: 460, borderLeft: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', background: 'var(--color-surface)' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Search Agent
            </span>
            <button onClick={reset} style={btn()}>+ New</button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {messages.length === 0 && !isStreaming && (
              <div style={{ padding: 16, fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
                <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--color-text-secondary)' }}>Two ways to interrogate the graph:</div>
                <ol style={{ paddingLeft: 18, marginTop: 0 }}>
                  <li><b>Click nodes</b> to build a selection, then "Ask about selection".</li>
                  <li><b>Free-form ask</b> below — the agent's people references will highlight on the graph.</li>
                </ol>
                <div style={{ marginTop: 12, padding: 8, background: 'var(--color-surface-hover)', borderRadius: 4 }}>
                  <div style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>Try:</div>
                  <button onClick={() => sendMessage('Who are the top 5 Kubernetes experts? Use query_graph.')} style={{ ...exampleBtn(), marginTop: 4 }}>
                    Top 5 Kubernetes experts
                  </button>
                  <button onClick={() => sendMessage('Find a strong cross-team pairing between Platform Engineering and Data Platform.')} style={exampleBtn()}>
                    Strong cross-team pairing
                  </button>
                  <button onClick={() => sendMessage('List the 3 most influential people overall by composite_score.')} style={exampleBtn()}>
                    Most influential overall
                  </button>
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={m.id} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                  {m.role === 'user' ? 'You' : 'Search'}
                </div>
                {m.role === 'user' ? (
                  <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{m.content}</div>
                ) : (
                  <AssistantMessage
                    text={m.content}
                    people={data?.nodes ?? []}
                    onHoverRef={setHoveredRef}
                    onClickRef={toggleSelect}
                    isLast={i === messages.length - 1}
                  />
                )}
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    {m.toolCalls.map(tc => (
                      <div key={tc.id} style={{ fontSize: 10, padding: '2px 6px', background: 'var(--color-info-bg, #eff6ff)', borderRadius: 3, fontFamily: 'monospace', display: 'inline-block', marginRight: 4 }}>
                        {tc.name}{tc.result && ' ✓'}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {isStreaming && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Thinking…</div>}
            {error && <div style={{ fontSize: 12, color: 'var(--color-danger)' }}>Error: {error}</div>}
            <div ref={bottomRef} />
          </div>

          <div style={{ display: 'flex', gap: 6, padding: 12, borderTop: '1px solid var(--color-border)' }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              placeholder={selectedIds.size > 0 ? `Ask about ${selectedIds.size} selected…` : 'Ask about the org…'}
              disabled={isStreaming}
              style={{ flex: 1, padding: '8px 10px', fontSize: 13, border: '1px solid var(--color-border)', borderRadius: 4, outline: 'none' }}
            />
            <button onClick={handleSend} disabled={isStreaming || !input.trim()} style={btn(true)}>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantMessage({
  text,
  people,
  onHoverRef,
  onClickRef,
  isLast,
}: {
  text: string;
  people: GraphPerson[];
  onHoverRef: (id: string | null) => void;
  onClickRef: (id: string) => void;
  isLast: boolean;
}) {
  const segments = parseSegments(text, people);
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
      {segments.map((s, i) =>
        s.kind === 'text' ? (
          <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{s.body}</span>
        ) : (
          <span
            key={i}
            onMouseEnter={() => onHoverRef(s.id)}
            onMouseLeave={() => onHoverRef(null)}
            onClick={() => onClickRef(s.id)}
            style={{
              display: 'inline-block',
              padding: '0 6px',
              margin: '0 2px',
              borderRadius: 10,
              background: isLast ? 'var(--color-primary, #6366f1)' : 'var(--color-surface-hover, #eef2ff)',
              color: isLast ? '#fff' : 'var(--color-primary, #6366f1)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              border: isLast ? 'none' : '1px solid var(--color-primary, #6366f1)',
            }}
            title={`${s.id} — click to select on graph`}
          >
            {s.name}
          </span>
        ),
      )}
    </div>
  );
}

function btn(primary = false): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '4px 10px',
    background: primary ? 'var(--color-primary, #6366f1)' : 'var(--color-surface)',
    color: primary ? '#fff' : 'var(--color-text-primary)',
    border: primary ? 'none' : '1px solid var(--color-border)',
    borderRadius: 4,
    cursor: 'pointer',
  };
}

function exampleBtn(): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    fontSize: 11,
    padding: '4px 8px',
    background: 'var(--color-surface)',
    color: 'var(--color-primary, #6366f1)',
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    cursor: 'pointer',
    marginTop: 4,
  };
}

export default ExplorePage;
