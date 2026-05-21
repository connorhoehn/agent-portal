// Org-graph exploration with an embedded search panel.
// The graph and chat live side-by-side: click people to select them,
// open the chat panel to ask questions, and the graph stays visible
// throughout so you can visualise the connections as you explore.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAgentStream } from '@connorhoehn/realtime-modules/agent-streaming/client';
import { OrgGraph } from '../components/org-graph';
import type { GraphPerson, GraphRelationship, GraphDepartment } from '../components/org-graph';
import type { LayoutMode } from '../components/org-graph/useForceLayout';
import { MultiEntityGraph } from '../components/multi-entity-graph/MultiEntityGraph';
import type { MENode, MEEdge } from '../components/multi-entity-graph/types';
import { useFetch } from '../hooks/useFetch';
import { Markdown } from '../components/Markdown';

const SEARCH_AGENT_ID = 'orgiq-search';

interface GraphData {
  nodes: GraphPerson[];
  edges: GraphRelationship[];
  departments: GraphDepartment[];
}

interface SkillsGraphData {
  domains: { id: string; name: string; skillCount: number }[];
  skills: { id: string; name: string; domain: string; personCount: number }[];
  people: GraphPerson[];
  personSkillEdges: { personId: string; skillId: string; weight: number }[];
}

interface ProjectsGraphData {
  projects: { id: string; name: string; status: string; contributorCount: number }[];
  people: GraphPerson[];
  personProjectEdges: { personId: string; projectId: string; weight: number }[];
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function findMentionedPeople(text: string, people: GraphPerson[]): GraphPerson[] {
  if (!text || people.length === 0) return [];
  const sorted = [...people].sort((a, b) => b.name.length - a.name.length);
  const stripped = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  const matched = new Map<string, GraphPerson>();
  for (const p of sorted) {
    const re = new RegExp(`(?<![\\w])${escapeRe(p.name)}(?![\\w])`, 'i');
    if (re.test(stripped)) matched.set(p.id, p);
  }
  return Array.from(matched.values());
}

// Cap edges to the strongest-K per node so the canvas stays readable.
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

function ThinkingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 3, verticalAlign: 'middle' }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
          background: 'var(--color-text-tertiary, #94a3b8)', opacity: 0.4,
          animation: `exploreDot 1.2s ${i * 0.2}s infinite ease-in-out`,
        }} />
      ))}
      <style>{`
        @keyframes exploreDot { 0%,80%,100%{opacity:.4;transform:scale(1)} 40%{opacity:1;transform:scale(1.3)} }
        @keyframes meGraphSpin { to{transform:rotate(360deg)} }
      `}</style>
    </span>
  );
}

function buildSkillsMEGraph(d: SkillsGraphData): { nodes: MENode[]; edges: MEEdge[] } {
  const nodes: MENode[] = [];
  const edges: MEEdge[] = [];
  const maxPeople = Math.max(...d.skills.map(s => s.personCount), 1);

  for (const dom of d.domains) {
    nodes.push({ id: dom.id, kind: 'skill_domain', label: dom.name, group: dom.name, weight: dom.skillCount / 10, x: 0, y: 0 });
  }
  for (const sk of d.skills) {
    nodes.push({ id: sk.id, kind: 'skill', label: sk.name, group: sk.domain, weight: sk.personCount / maxPeople, personCount: sk.personCount, x: 0, y: 0 });
    edges.push({ source: sk.id, target: `domain:${sk.domain}`, type: 'belongs_to', strength: 1 });
  }
  const personIds = new Set(d.personSkillEdges.map(e => e.personId));
  const maxInfluence = Math.max(...d.people.map(p => p.influenceScore), 0.01);
  for (const p of d.people) {
    if (!personIds.has(p.id)) continue;
    nodes.push({ id: p.id, kind: 'person', label: p.name, department: p.department, weight: p.influenceScore / maxInfluence, x: 0, y: 0 });
  }
  for (const e of d.personSkillEdges) {
    edges.push({ source: e.personId, target: e.skillId, type: 'has_skill', strength: e.weight });
  }
  return { nodes, edges };
}

const STATUS_LABEL_MAP: Record<string, string> = {
  in_progress: 'In Progress',
  planning: 'Planning',
  active: 'Active',
  archived: 'Archived',
};
function projectStatusLabel(s: string): string {
  return STATUS_LABEL_MAP[s] ?? (s.charAt(0).toUpperCase() + s.slice(1));
}

function buildProjectsMEGraph(
  d: ProjectsGraphData,
  activeStatuses?: Set<string>,
): { nodes: MENode[]; edges: MEEdge[]; allStatuses: string[] } {
  const nodes: MENode[] = [];
  const edges: MEEdge[] = [];

  // All non-archived statuses for toolbar chips
  const allProjects = d.projects.filter(p => p.status !== 'completed' && p.status !== 'archived');
  const allStatuses = [...new Set(allProjects.map(p => p.status))].sort();

  // Apply optional status filter
  const activeProjects = activeStatuses
    ? allProjects.filter(p => activeStatuses.has(p.status))
    : allProjects;
  const activeProjectIds = new Set(activeProjects.map(p => p.id));

  const maxContrib = Math.max(...activeProjects.map(p => p.contributorCount), 1);
  for (const proj of activeProjects) {
    nodes.push({ id: proj.id, kind: 'project', label: proj.name, group: proj.status, weight: proj.contributorCount / maxContrib, personCount: proj.contributorCount, x: 0, y: 0 });
  }

  const activeEdges = d.personProjectEdges.filter(e => activeProjectIds.has(e.projectId));
  const personIds = new Set(activeEdges.map(e => e.personId));
  const maxInfluence = Math.max(...d.people.map(p => p.influenceScore), 0.001);
  for (const p of d.people) {
    if (!personIds.has(p.id)) continue;
    nodes.push({ id: p.id, kind: 'person', label: p.name, department: p.department, weight: p.influenceScore / maxInfluence, x: 0, y: 0 });
  }
  for (const e of activeEdges) {
    edges.push({ source: e.personId, target: e.projectId, type: 'contributes_to', strength: e.weight });
  }
  return { nodes, edges, allStatuses };
}

function ExplorePage() {
  const { data } = useFetch<GraphData>('/api/graph/entities');
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [topK, setTopK] = useState(4);
  const [minStrength, setMinStrength] = useState(0.6);
  const [chatOpen, setChatOpen] = useState(false);
  const [filterToSelection, setFilterToSelection] = useState(true);
  const [activeStatuses, setActiveStatuses] = useState<Set<string> | null>(null);

  // ?layout= and ?entities= params driven by the sub-nav catalog
  const rawLayout = searchParams.get('layout');
  const layoutMode: LayoutMode = rawLayout === 'radial' ? 'radial' : 'force';

  // entityFilter: 'all' | 'people' | 'skills' | 'projects' | 'decisions'
  const entityFilter = searchParams.get('entities') ?? 'all';

  // Fetch multi-entity graph data only when that view is active (lazy)
  const { data: skillsData, isLoading: skillsLoading, error: skillsError, refresh: refreshSkills } = useFetch<SkillsGraphData>(
    entityFilter === 'skills' ? '/api/graph/skills-graph' : null,
  );
  const { data: projectsData, isLoading: projectsLoading, error: projectsError, refresh: refreshProjects } = useFetch<ProjectsGraphData>(
    entityFilter === 'projects' ? '/api/graph/projects-graph' : null,
  );

  const meGraph = useMemo<{ nodes: MENode[]; edges: MEEdge[]; allStatuses?: string[] } | null>(() => {
    if (entityFilter === 'skills' && skillsData) return buildSkillsMEGraph(skillsData);
    if (entityFilter === 'projects' && projectsData) return buildProjectsMEGraph(projectsData, activeStatuses ?? undefined);
    return null;
  }, [entityFilter, skillsData, projectsData, activeStatuses]);

  // Clear selection and status filter when switching entity filter.
  useEffect(() => {
    setSelectedIds(new Set());
    setActiveStatuses(null);
  }, [entityFilter]);

  // ?focus=<id> arrives from related-people cards on /search.
  useEffect(() => {
    const focus = searchParams.get('focus');
    if (!focus) return;
    setSelectedIds(prev => { const n = new Set(prev); n.add(focus); return n; });
    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // ── Graph filtering ────────────────────────────────────────────────────────

  // entityFilter controls which relationship types are shown.
  // Each view surfaces a distinct slice of the org graph:
  //   skills    → shared expertise connections only (expert_in_common)
  //   projects  → collaboration edges only (collaborates)
  //   decisions → reporting/mentoring hierarchy (mentors + reports_to)
  //   people / all → all edge types
  const entityFilteredEdges = useMemo(() => {
    if (!data) return [] as GraphRelationship[];
    if (entityFilter === 'skills') return data.edges.filter(e => e.type === 'expert_in_common');
    if (entityFilter === 'projects') return data.edges.filter(e => e.type === 'collaborates');
    if (entityFilter === 'decisions') return data.edges.filter(e => e.type === 'mentors' || e.type === 'reports_to');
    return data.edges; // 'people' or 'all'
  }, [data, entityFilter]);

  const { visibleNodes, baseEdges } = useMemo(() => {
    if (!data) return { visibleNodes: [] as GraphPerson[], baseEdges: [] as GraphRelationship[] };
    const baseNodes = data.nodes;
    const baseEdgeSet = entityFilteredEdges;
    if (!filterToSelection || selectedIds.size === 0) return { visibleNodes: baseNodes, baseEdges: baseEdgeSet };
    const neighbors = new Set<string>();
    for (const e of baseEdgeSet) {
      if (selectedIds.has(e.source)) neighbors.add(e.target);
      if (selectedIds.has(e.target)) neighbors.add(e.source);
    }
    const keep = new Set([...selectedIds, ...neighbors]);
    return {
      visibleNodes: baseNodes.filter(n => keep.has(n.id)),
      baseEdges: baseEdgeSet.filter(e => keep.has(e.source) && keep.has(e.target)),
    };
  }, [data, entityFilteredEdges, filterToSelection, selectedIds]);

  // When a specific edge type is active (skills/projects/decisions), skip the
  // minStrength gate — the user explicitly chose that view so show all of those edges.
  const isSpecificFilter = entityFilter !== 'all' && entityFilter !== 'people';
  const activeMinStrength = isSpecificFilter ? 0 : minStrength;
  const filteredEdges = useMemo(
    () => filterEdges(baseEdges, topK, activeMinStrength),
    [baseEdges, topK, activeMinStrength],
  );
  const isEntityFiltered = data && entityFilter !== 'all' && entityFilter !== 'people' && (!filterToSelection || selectedIds.size === 0);
  const isFiltered = filterToSelection && selectedIds.size > 0 && data && visibleNodes.length < data.nodes.length;

  function toggleSelect(id: string) {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  // ── Embedded chat ──────────────────────────────────────────────────────────

  const pendingSelectionRef = useRef<{ peopleIds: string[] } | null>(null);
  const { messages, isStreaming, streamingText, activeToolCalls, error, sendMessage, reset } = useAgentStream({
    url: `/api/agents/${SEARCH_AGENT_ID}/invoke`,
    buildBody: (text, { sessionId }) => {
      const sel = pendingSelectionRef.current;
      pendingSelectionRef.current = null;
      return { message: text, ...(sessionId ? { sessionId } : {}), ...(sel ? { selection: sel } : {}) };
    },
  });

  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamingText]);

  function openAndAsk(ids?: string[]) {
    setChatOpen(true);
    if (!ids || ids.length === 0 || isStreaming) return;

    // Resolve display labels for each selected ID. For person nodes use data.nodes
    // (which has real names); for skill/domain/project nodes fall back to meGraph.nodes.
    const resolveLabel = (id: string): string | undefined => {
      const person = data?.nodes.find(n => n.id === id);
      if (person) return person.name;
      return meGraph?.nodes.find(n => n.id === id)?.label;
    };

    const allLabels = ids.map(resolveLabel).filter(Boolean) as string[];
    const personIds = ids.filter(id => data?.nodes.some(n => n.id === id));
    const nonPersonNodes = ids
      .filter(id => !data?.nodes.some(n => n.id === id))
      .map(id => meGraph?.nodes.find(n => n.id === id))
      .filter(Boolean)
      .filter(n => n!.kind !== 'skill_domain') as NonNullable<typeof meGraph>['nodes'];
    const nonPersonLabels = nonPersonNodes.map(n => n.label);

    // Bail gracefully if we couldn't resolve any labels.
    if (allLabels.length === 0) return;

    let question: string;
    if (nonPersonLabels.length > 0 && personIds.length === 0) {
      // Pure non-person selection (skills, projects)
      if (nonPersonLabels.length === 1) {
        const node = nonPersonNodes[0];
        if (node.kind === 'project') {
          question = `Who is contributing to the "${nonPersonLabels[0]}" project? List the team members and describe what each person is working on.`;
        } else {
          question = `Who in the org has expertise in ${nonPersonLabels[0]}? List the top people with this skill and describe how they use it.`;
        }
      } else {
        const allProjects = nonPersonNodes.every(n => n.kind === 'project');
        const last = nonPersonLabels[nonPersonLabels.length - 1];
        const rest = nonPersonLabels.slice(0, -1).join(', ');
        if (allProjects) {
          question = `Who contributes to both ${rest} and ${last}? Find people working across these projects and describe their roles.`;
        } else {
          question = `Who works across ${rest} and ${last}? Find people with expertise spanning these areas and describe the overlap.`;
        }
      }
    } else if (allLabels.length === 1) {
      question = `Tell me about ${allLabels[0]} — their skills, key projects, and who they collaborate with most.`;
    } else if (allLabels.length === 2) {
      question = `What is the connection between ${allLabels[0]} and ${allLabels[1]}? Do they collaborate, share skills, or work on the same projects?`;
    } else {
      const last = allLabels[allLabels.length - 1];
      const rest = allLabels.slice(0, -1).join(', ');
      question = `What connects ${rest} and ${last}? Describe their shared skills, collaborations, and any overlapping projects.`;
    }

    pendingSelectionRef.current = { peopleIds: personIds.length > 0 ? personIds : ids };
    void sendMessage(question);
  }

  function handleSend() {
    if (!input.trim() || isStreaming) return;
    void sendMessage(input.trim());
    setInput('');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  function handleClose() {
    setChatOpen(false);
    reset();
    setInput('');
  }

  if (!data) {
    return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading graph…</div>;
  }

  const hasMessages = messages.length > 0 || isStreaming;

  return (
    <div style={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div style={toolbarStyle}>
        <span style={{ fontWeight: 600 }}>Explore</span>
        <span style={{ color: 'var(--color-text-tertiary)' }}>
          {meGraph
            ? <><b>{meGraph.nodes.filter(n => n.kind !== 'skill_domain').length}</b> nodes · <b>{meGraph.edges.filter(e => e.type !== 'belongs_to').length}</b> {entityFilter} edges</>
            : <><b>{visibleNodes.length}</b>{isFiltered ? ` / ${data?.nodes.length ?? 0}` : ''} people · <b>{filteredEdges.length}</b>{isEntityFiltered ? ` ${entityFilter}` : ''} edges</>
          }
        </span>
        {isFiltered && (
          <button onClick={() => setFilterToSelection(false)} style={primaryBtn()}>✕ Show full graph</button>
        )}
        <span style={controlStyle}>
          Top-K
          <input type="range" min={1} max={10} value={topK} onChange={e => setTopK(parseInt(e.target.value, 10))} style={{ width: 80 }} />
          <span style={{ width: 16, textAlign: 'right' }}>{topK}</span>
        </span>
        <span style={{ ...controlStyle, opacity: isSpecificFilter ? 0.35 : 1 }} title={isSpecificFilter ? 'Min strength ignored when a specific view is active' : undefined}>
          Min strength
          <input type="range" min={0} max={100} value={Math.round(minStrength * 100)}
            onChange={e => setMinStrength(parseInt(e.target.value, 10) / 100)} style={{ width: 80 }}
            disabled={isSpecificFilter} />
          <span style={{ width: 28, textAlign: 'right' }}>{minStrength.toFixed(2)}</span>
        </span>
        {entityFilter === 'projects' && meGraph?.allStatuses && meGraph.allStatuses.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ color: 'var(--color-text-secondary)' }}>Status</span>
            {meGraph.allStatuses.map(s => {
              const isActive = activeStatuses === null || activeStatuses.has(s);
              return (
                <button
                  key={s}
                  onClick={() => setActiveStatuses(prev => {
                    const all = new Set(meGraph.allStatuses!);
                    if (prev === null) {
                      const next = new Set(all);
                      next.delete(s);
                      return next;
                    }
                    const next = new Set(prev);
                    if (next.has(s)) {
                      next.delete(s);
                      return next.size === 0 ? new Set(all) : next;
                    }
                    next.add(s);
                    return next.size === all.size ? null : next;
                  })}
                  style={statusChipStyle(isActive)}
                >
                  {projectStatusLabel(s)}
                </button>
              );
            })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {selectedIds.size > 0 && (
          <>
            <span style={{ color: 'var(--color-primary)', fontWeight: 600, fontSize: 12 }}>
              {selectedIds.size} selected
            </span>
            <button onClick={() => { setSelectedIds(new Set()); setFilterToSelection(true); }} style={ghostBtn()}>Clear</button>
            <button onClick={() => openAndAsk(Array.from(selectedIds))} style={primaryBtn()}>Ask about selection →</button>
          </>
        )}
        <button onClick={() => chatOpen ? handleClose() : setChatOpen(true)} style={ghostBtn()}>
          {chatOpen ? 'Close search' : 'Search'}
        </button>
      </div>

      {/* ── Graph + Chat split ───────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Graph */}
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          {(() => {
            const meActive = entityFilter === 'skills' || entityFilter === 'projects';
            const meLoading = meActive && (entityFilter === 'skills' ? skillsLoading : projectsLoading);
            const meError = meActive && (entityFilter === 'skills' ? skillsError : projectsError);
            const meRefresh = entityFilter === 'skills' ? refreshSkills : refreshProjects;

            if (meGraph) {
              return (
                <MultiEntityGraph
                  nodes={meGraph.nodes}
                  edges={meGraph.edges}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  maxEdgesPerPerson={topK}
                />
              );
            }

            if (meActive) {
              return (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                  {meLoading ? (
                    <div style={meStateCardStyle}>
                      <div style={meStateSpinnerStyle} />
                      <span>Loading {entityFilter} graph…</span>
                    </div>
                  ) : meError ? (
                    <div style={meStateCardStyle}>
                      <span style={{ color: 'var(--color-error, #ef4444)' }}>Failed to load {entityFilter} graph</span>
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{meError}</span>
                      <button onClick={meRefresh} style={{ fontSize: 11, padding: '4px 10px', marginTop: 4, borderRadius: 4, border: '1px solid var(--color-border)', background: 'var(--color-bg)', cursor: 'pointer' }}>
                        Retry
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            }

            // Decisions filter: show empty state when no hierarchy edges exist
            if (entityFilter === 'decisions' && filteredEdges.length === 0 && selectedIds.size === 0) {
              return (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                  <div style={{ ...meStateCardStyle, maxWidth: 420, textAlign: 'center', gap: 10 }}>
                    <span style={{ fontSize: 22 }}>🏛</span>
                    <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>No hierarchy data</span>
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                      The Decisions view shows mentoring and reporting relationships — who reports to whom and who mentors whom across the org.
                    </p>
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                      No <code>mentors</code> or <code>reports_to</code> edges are in the graph yet. Run the ingestion pipeline to extract org hierarchy from 1:1 notes and performance reviews, or select <b>All</b> to explore the full collaboration network.
                    </p>
                    <button
                      onClick={() => setSearchParams(new URLSearchParams({ entities: 'all' }))}
                      style={{ fontSize: 11, padding: '5px 14px', borderRadius: 4, border: 'none', background: 'var(--color-primary, #6366f1)', color: '#fff', cursor: 'pointer', marginTop: 4 }}
                    >
                      Switch to All
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <>
                <OrgGraph
                  people={visibleNodes}
                  relationships={filteredEdges}
                  departments={data.departments}
                  multiSelectIds={selectedIds}
                  onToggleMultiSelect={toggleSelect}
                  spotlightIds={selectedIds}
                  layout={layoutMode}
                />
                {selectedIds.size === 0 && !chatOpen && (
                  <div style={hintStyle}>
                    Click people to select them, then <b>Ask about selection</b> to query with the graph in view.
                  </div>
                )}
              </>
            );
          })()}
        </div>

        {/* Chat panel */}
        {chatOpen && (
          <div style={chatPanelStyle}>
            {/* Panel header */}
            <div style={chatHeaderStyle}>
              <span style={{ fontWeight: 600, fontSize: 12 }}>Search</span>
              {hasMessages && (
                <button onClick={() => { reset(); setInput(''); }} style={iconBtn()} title="New conversation">↺</button>
              )}
            </div>

            {/* Messages */}
            <div style={chatMessagesStyle}>
              {!hasMessages && (
                <div style={chatEmptyStyle}>
                  Ask anything about your org — people, skills, connections, decisions.
                </div>
              )}
              {messages.map(msg => {
                const mentioned = msg.role === 'assistant' && data
                  ? findMentionedPeople(msg.content, data.nodes)
                  : [];
                return (
                  <div key={msg.id} style={msgWrapStyle}>
                    <div style={msgRoleStyle}>{msg.role === 'user' ? 'You' : 'Search agent'}</div>
                    {msg.role === 'assistant'
                      ? <div style={msgBodyStyle}><Markdown>{msg.content}</Markdown></div>
                      : <div style={{ ...msgBodyStyle, color: 'var(--color-text-primary)' }}>{msg.content}</div>
                    }
                    {mentioned.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                        {mentioned.map(p => (
                          <button
                            key={p.id}
                            onClick={() => toggleSelect(p.id)}
                            style={personChipStyle(selectedIds.has(p.id))}
                            title={selectedIds.has(p.id) ? 'Click to deselect on graph' : 'Click to highlight on graph'}
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {isStreaming && (
                <div style={msgWrapStyle}>
                  <div style={msgRoleStyle}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      Search agent <ThinkingDots />
                    </span>
                  </div>
                  {activeToolCalls.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                      {activeToolCalls.map(tc => (
                        <span key={tc.id} style={toolPillStyle(tc.done === true)}>
                          {tc.name}{tc.done ? ' ✓' : '…'}
                        </span>
                      ))}
                    </div>
                  )}
                  {streamingText
                    ? <div style={msgBodyStyle}><Markdown>{streamingText}</Markdown></div>
                    : null
                  }
                  {streamingText && data && (() => {
                    const live = findMentionedPeople(streamingText, data.nodes);
                    return live.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                        {live.map(p => (
                          <button key={p.id} onClick={() => toggleSelect(p.id)}
                            style={personChipStyle(selectedIds.has(p.id))}
                            title={selectedIds.has(p.id) ? 'Click to deselect on graph' : 'Click to highlight on graph'}>
                            {p.name}
                          </button>
                        ))}
                      </div>
                    ) : null;
                  })()}
                </div>
              )}
              {error && <div style={errorStyle}>Error: {error}</div>}
              <div ref={bottomRef} />
            </div>

            {/* Composer */}
            <div style={composerStyle}>
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about people, skills, connections…"
                rows={2}
                disabled={isStreaming}
                style={textareaStyle}
              />
              <button onClick={handleSend} disabled={isStreaming || !input.trim()} style={sendBtnStyle}>
                {isStreaming ? <ThinkingDots /> : '→'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const toolbarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 16,
  padding: '8px 16px', borderBottom: '1px solid var(--color-border)',
  fontSize: 12, background: 'var(--color-surface)', flexShrink: 0,
};
const controlStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)',
};
const hintStyle: React.CSSProperties = {
  position: 'absolute', bottom: 12, left: 12, padding: '6px 10px',
  background: 'var(--color-surface)', border: '1px solid var(--color-border)',
  borderRadius: 4, fontSize: 11, color: 'var(--color-text-tertiary)',
};
const meStateCardStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
  padding: '20px 28px', background: 'var(--color-surface)',
  border: '1px solid var(--color-border)', borderRadius: 8,
  fontSize: 13, color: 'var(--color-text-secondary)',
};
const meStateSpinnerStyle: React.CSSProperties = {
  width: 20, height: 20, borderRadius: '50%',
  border: '2px solid var(--color-border)',
  borderTopColor: 'var(--color-primary, #6366f1)',
  animation: 'meGraphSpin 0.8s linear infinite',
};
const chatPanelStyle: React.CSSProperties = {
  width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column',
  borderLeft: '1px solid var(--color-border)', background: 'var(--color-surface)',
  minHeight: 0,
};
const chatHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '8px 12px', borderBottom: '1px solid var(--color-border)', flexShrink: 0,
};
const chatMessagesStyle: React.CSSProperties = {
  flex: 1, overflowY: 'auto', padding: '12px 12px 0', display: 'flex', flexDirection: 'column', gap: 12,
};
const chatEmptyStyle: React.CSSProperties = {
  color: 'var(--color-text-tertiary)', fontSize: 12, lineHeight: 1.6, padding: '8px 0',
};
const msgWrapStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
const msgRoleStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
  textTransform: 'uppercase', color: 'var(--color-text-tertiary)',
};
const msgBodyStyle: React.CSSProperties = { fontSize: 13, lineHeight: 1.6 };
const composerStyle: React.CSSProperties = {
  display: 'flex', gap: 6, padding: 12,
  borderTop: '1px solid var(--color-border)', flexShrink: 0,
};
const textareaStyle: React.CSSProperties = {
  flex: 1, resize: 'none', fontSize: 12, padding: '6px 8px',
  border: '1px solid var(--color-border)', borderRadius: 4,
  background: 'var(--color-bg)', color: 'var(--color-text-primary)',
  fontFamily: 'inherit', lineHeight: 1.5,
};
const sendBtnStyle: React.CSSProperties = {
  width: 36, height: 36, alignSelf: 'flex-end', flexShrink: 0,
  background: 'var(--color-primary, #6366f1)', color: '#fff',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 16,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const errorStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--color-error, #ef4444)', padding: '4px 0',
};

function statusChipStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 11, padding: '2px 8px', borderRadius: 10, cursor: 'pointer',
    fontFamily: 'inherit', fontWeight: active ? 600 : 400,
    background: active ? 'var(--color-primary-subtle, #eef2ff)' : 'var(--color-surface)',
    color: active ? 'var(--color-primary, #6366f1)' : 'var(--color-text-tertiary)',
    border: `1px solid ${active ? 'var(--color-primary-border, #c7d2fe)' : 'var(--color-border)'}`,
    transition: 'all 0.1s',
  };
}

function personChipStyle(selected: boolean): React.CSSProperties {
  return {
    fontSize: 11, padding: '3px 8px', borderRadius: 12, cursor: 'pointer',
    fontFamily: 'inherit', fontWeight: selected ? 600 : 400,
    background: selected ? 'var(--color-primary, #6366f1)' : 'var(--color-bg)',
    color: selected ? '#fff' : 'var(--color-text-secondary)',
    border: `1px solid ${selected ? 'var(--color-primary, #6366f1)' : 'var(--color-border)'}`,
    transition: 'all 0.1s',
  };
}

function toolPillStyle(done: boolean): React.CSSProperties {
  return {
    fontSize: 10, padding: '2px 6px', borderRadius: 3,
    background: done ? 'var(--color-success-bg, #dcfce7)' : 'var(--color-warning-bg, #fef9c3)',
    color: done ? 'var(--color-success, #16a34a)' : 'var(--color-warning, #ca8a04)',
    border: `1px solid ${done ? 'var(--color-success-border, #bbf7d0)' : 'var(--color-warning-border, #fde68a)'}`,
  };
}

function primaryBtn(): React.CSSProperties {
  return {
    fontSize: 11, padding: '4px 10px',
    background: 'var(--color-primary, #6366f1)', color: '#fff',
    border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
  };
}
function ghostBtn(): React.CSSProperties {
  return {
    fontSize: 11, padding: '4px 10px',
    background: 'var(--color-surface)', color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
  };
}
function iconBtn(): React.CSSProperties {
  return {
    background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
    color: 'var(--color-text-tertiary)', padding: '2px 4px', borderRadius: 3,
  };
}

export default ExplorePage;
