// Org-graph exploration with an embedded search panel.
// The graph and chat live side-by-side: click people to select them,
// open the chat panel to ask questions, and the graph stays visible
// throughout so you can visualise the connections as you explore.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAgentStream } from '@connorhoehnslalom/realtime-modules/agent-streaming/client';
import { OrgGraph } from '../components/org-graph';
import type { GraphPerson, GraphRelationship, GraphDepartment } from '../components/org-graph';
import type { LayoutMode } from '../components/org-graph/useForceLayout';
import { MultiEntityGraph } from '../components/multi-entity-graph/MultiEntityGraph';
import {
  GraphSearchBox,
  PersonDetailCard,
  ConnectionPathStrip,
  DepartmentChips,
  DepartmentInsightStrip,
  findConnectionPath,
  type PathHop,
} from '../components/org-graph/ExplorePanels';
import type { MENode, MEEdge } from '../components/multi-entity-graph/types';
import {
  ChatComposer,
  MessageBubble,
  PageSection,
  Spinner,
  Card,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { Markdown } from '../components/Markdown';
import { fetchSessionMessages, rememberSession, recallSession, forgetSession, stripThinking } from '../lib/chatSessions';
import { ChatSessionPicker } from '../components/ChatSessionPicker';

// The supervisor is the conversational entry point: it streams AG-UI events,
// attaches the caller's role guardrail, replays multi-turn history from
// AgentCore Memory, and routes to search/scoring internally. (orgiq-search
// itself is a request/response A2A agent — invoking it directly yields a
// single JSON dict, no AG-UI stream, so chat rendered nothing and no turn
// was ever recorded to Memory.)
const SEARCH_AGENT_ID = 'orgiq-supervisor';

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

/** Replace raw person IDs in agent text with actual names.
 *  Handles patterns like:
 *   - "Person with ID p-007" → "Alex Chen"
 *   - "person_id p-007" → "Alex Chen"
 *   - standalone "p-007" → "Alex Chen"  (word-boundary only)
 */
function resolvePersonIds(text: string, people: GraphPerson[]): string {
  if (!text || people.length === 0) return text;
  const idMap = new Map(people.map(p => [p.id, p.name]));
  // "Person with ID p-NNN" or "person with id p-NNN"
  let out = text.replace(/[Pp]erson(?:\s+with)?\s+(?:ID|id|Id)\s+(p-\d{3,})/g, (_, id: string) => idMap.get(id) ?? id);
  // Standalone IDs with word boundaries
  out = out.replace(/\b(p-\d{3,})\b/g, (id: string) => idMap.get(id) ?? id);
  return out;
}

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
  const { data, error: graphError, refresh: refreshGraph } = useFetch<GraphData>('/api/graph/entities');
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Most recently selected person — drives the detail side panel.
  const [detailId, setDetailId] = useState<string | null>(null);
  // Department focus chip — highlights one department's people.
  const [activeDepartment, setActiveDepartment] = useState<string | null>(null);
  const [topK, setTopK] = useState(4);
  const [minStrength, setMinStrength] = useState(0.6);
  const [chatOpen, setChatOpen] = useState(false);
  const [filterToSelection, setFilterToSelection] = useState(true);
  const [activeStatuses, setActiveStatuses] = useState<Set<string> | null>(null);
  const [presenceFilter, setPresenceFilter] = useState<'office' | 'remote' | 'away' | null>(null);
  const [presenceOpen, setPresenceOpen] = useState(false);
  const presenceRef = useRef<HTMLDivElement>(null);

  // Close presence dropdown on outside click
  useEffect(() => {
    if (!presenceOpen) return;
    const handler = (e: MouseEvent) => {
      if (presenceRef.current && !presenceRef.current.contains(e.target as Node)) {
        setPresenceOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [presenceOpen]);

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
    setActiveDepartment(null);
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

  // Connection path: exactly two selected people → BFS shortest path over the
  // FULL edge set (view filters don't constrain "how are they connected?").
  const connectionPath = useMemo(() => {
    if (!data || selectedIds.size !== 2) return null;
    const [a, b] = Array.from(selectedIds);
    if (!a || !b) return null;
    return findConnectionPath(data.nodes, data.edges, a, b);
  }, [data, selectedIds]);

  // "Show path on graph" replaces the selection with the whole corridor —
  // which would un-satisfy the exactly-2 rule and vanish the strip. Pin the
  // path so the strip stays visible while the corridor selection is intact.
  const [pinnedPath, setPinnedPath] = useState<PathHop[] | null>(null);
  const displayPath = connectionPath ?? (
    pinnedPath &&
    selectedIds.size === pinnedPath.length &&
    pinnedPath.every(h => selectedIds.has(h.person.id))
      ? pinnedPath
      : null
  );

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) {
        n.delete(id);
        setDetailId(d => (d === id ? null : d));
      } else {
        n.add(id);
        // Only person nodes get a detail panel (skills/projects don't).
        if (data?.nodes.some(p => p.id === id)) setDetailId(id);
      }
      return n;
    });
  }

  // ── Embedded chat ──────────────────────────────────────────────────────────

  const pendingSelectionRef = useRef<{ peopleIds: string[] } | null>(null);
  const { messages, isStreaming, streamingText, activeToolCalls, error, sessionId, sendMessage, reset, loadHistory } = useAgentStream({
    url: `/api/agents/${SEARCH_AGENT_ID}/invoke`,
    buildBody: (text, { sessionId }) => {
      const sel = pendingSelectionRef.current;
      pendingSelectionRef.current = null;
      return { message: text, ...(sessionId ? { sessionId } : {}), ...(sel ? { selection: sel } : {}) };
    },
    // Transcript restore from AgentCore Memory. This page has no <thinking>
    // renderer, so thinking blocks are stripped for display.
    historyFetch: (sid) => fetchSessionMessages(sid),
  });

  // Session persistence: resume the last Explore conversation on mount, and
  // remember whichever session the hook is on. `reset` (↺) forgets it.
  useEffect(() => {
    const saved = recallSession('explore');
    if (saved) void loadHistory(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (sessionId) rememberSession('explore', sessionId);
  }, [sessionId]);

  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamingText]);

  // ── Auto-select graph nodes from agent responses ───────────────────────────
  // When streaming ends, extract every person mentioned in the assistant message
  // and automatically highlight them in the graph.
  //
  // Behaviour:
  //   • First response in a conversation → REPLACES any existing graph selection
  //   • Follow-up responses in the same conversation → COMPOUNDS (union)
  //   • Reset (new conversation / ↺) → resets the "first response" flag
  const prevStreamingRef = useRef(false);
  const isFirstAutoSelectRef = useRef(true);

  useEffect(() => {
    const justFinished = prevStreamingRef.current && !isStreaming;
    prevStreamingRef.current = isStreaming;
    if (!justFinished || !data) return;

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant') return;

    const mentioned = findMentionedPeople(lastMsg.content, data.nodes);
    if (mentioned.length === 0) return;

    const mentionedIds = new Set(mentioned.map(p => p.id));
    if (isFirstAutoSelectRef.current) {
      // First response: replace whatever was selected before.
      setSelectedIds(mentionedIds);
      setFilterToSelection(true);
      isFirstAutoSelectRef.current = false;
    } else {
      // Follow-up responses: add to existing selection (compound).
      setSelectedIds(prev => new Set([...prev, ...mentionedIds]));
    }
  }, [isStreaming, messages, data]);

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

  // Closing the panel only hides it — the conversation stays (it's persisted
  // in AgentCore Memory anyway). ↺ in the panel header starts a new one.
  function handleClose() {
    setChatOpen(false);
  }

  function handleNewConversation() {
    forgetSession('explore');
    reset();
    setInput('');
    isFirstAutoSelectRef.current = true;
  }

  // A failed graph load used to render "Loading graph…" forever, which is
  // indistinguishable from a slow one — you wait instead of acting. Say what
  // went wrong and offer the retry.
  if (!data && graphError) {
    return (
      <PageSection title="Explore">
        <Card padding="md" className="max-w-2xl border-danger/40">
          <div className="text-[13px] font-semibold text-danger">Could not load the org graph</div>
          <div className="text-[12px] text-text-secondary mt-1 leading-snug">
            {graphError}. People, skills, projects and decisions all come from Aurora, so
            this usually means the database is unreachable rather than that the graph is empty.
          </div>
          <button
            onClick={() => refreshGraph()}
            className="mt-3 px-3 py-1.5 rounded-md border border-border bg-surface text-[12px] font-semibold text-text-secondary cursor-pointer hover:text-primary hover:border-primary/50 transition-colors"
          >
            Try again
          </button>
        </Card>
      </PageSection>
    );
  }

  if (!data) {
    return (
      <PageSection title="Explore">
        <div style={{ color: 'var(--color-text-tertiary)' }}>Loading graph…</div>
      </PageSection>
    );
  }

  const hasMessages = messages.length > 0 || isStreaming;

  return (
    <div style={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div style={toolbarStyle}>
        <span style={{ fontWeight: 600 }}>Explore</span>
        <GraphSearchBox
          people={data.nodes}
          onPickPerson={(id) => {
            setSelectedIds(new Set([id]));
            setDetailId(id);
            setFilterToSelection(true);
          }}
          onPickSkill={(_skill, personIds) => {
            setSelectedIds(new Set(personIds));
            setDetailId(null);
            setFilterToSelection(true);
          }}
        />
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
          <input type="range" aria-label="Top K results" min={1} max={10} value={topK} onChange={e => setTopK(parseInt(e.target.value, 10))} style={{ width: 80 }} />
          <span style={{ width: 16, textAlign: 'right' }}>{topK}</span>
        </span>
        <span style={{ ...controlStyle, opacity: isSpecificFilter ? 0.35 : 1 }} title={isSpecificFilter ? 'Min strength ignored when a specific view is active' : undefined}>
          Min strength
          <input type="range" aria-label="Minimum relationship strength" min={0} max={100} value={Math.round(minStrength * 100)}
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

        {/* Presence dropdown — only relevant for person-based views */}
        {(entityFilter === 'all' || entityFilter === 'people' || entityFilter === 'decisions') && (() => {
          const FACETS = [
            { key: 'office' as const, label: 'In Office', dot: '#16a34a' },
            { key: 'remote' as const, label: 'Remote',    dot: '#3b82f6' },
            { key: 'away'   as const, label: 'Away',      dot: '#f97316' },
          ];
          const activeFacet = FACETS.find(f => f.key === presenceFilter);
          return (
            <div ref={presenceRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setPresenceOpen(o => !o)}
                aria-expanded={presenceOpen}
                aria-haspopup="listbox"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '3px 9px', borderRadius: 9999,
                  border: presenceFilter
                    ? '1.5px solid var(--color-primary, #6366f1)'
                    : '1.5px solid var(--color-border)',
                  background: presenceFilter ? 'var(--color-primary-subtle, #eef2ff)' : 'transparent',
                  color: presenceFilter ? 'var(--color-primary, #6366f1)' : 'var(--color-text-secondary)',
                  fontSize: 11, fontWeight: presenceFilter ? 600 : 400,
                  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                }}
              >
                {activeFacet
                  ? <><span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: activeFacet.dot, flexShrink: 0 }} />{activeFacet.label}</>
                  : 'Today'
                }
                <span aria-hidden="true" style={{ fontSize: 9, opacity: 0.5, marginLeft: 1 }}>▾</span>
              </button>

              {presenceOpen && (
                <div role="listbox" style={{
                  position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 100,
                  background: 'var(--color-surface, #fff)',
                  border: '1px solid var(--color-border, #e2e8f0)',
                  borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
                  padding: '6px 0', minWidth: 160,
                }}>
                  {FACETS.map(({ key, label, dot }) => {
                    const count = data?.nodes.filter(n => {
                      const p = n.presence ?? 'unknown';
                      if (key === 'office') return p === 'office';
                      if (key === 'remote') return p === 'wfh' || p === 'travel';
                      return p === 'pto' || p === 'vacation' || p === 'sick';
                    }).length ?? 0;
                    const active = presenceFilter === key;
                    return (
                      <button
                        key={key}
                        role="option"
                        aria-selected={active}
                        onClick={() => { setPresenceFilter(active ? null : key); setPresenceOpen(false); }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                          padding: '7px 14px', border: 'none', background: active ? 'var(--color-primary-subtle, #eef2ff)' : 'transparent',
                          color: active ? 'var(--color-primary, #6366f1)' : 'var(--color-text-primary, #0f172a)',
                          fontSize: 12, fontWeight: active ? 600 : 400,
                          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                        }}
                      >
                        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                        <span style={{ flex: 1 }}>{label}</span>
                        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary, #94a3b8)' }}>{count}</span>
                        {active && <span aria-hidden="true" style={{ fontSize: 11, color: 'var(--color-primary, #6366f1)', marginLeft: 2 }}>✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        {(entityFilter === 'all' || entityFilter === 'people' || entityFilter === 'decisions') && (
          <DepartmentChips
            departments={data.departments}
            people={data.nodes}
            activeDepartment={activeDepartment}
            onToggle={(name, memberIds) => {
              setActiveDepartment(name);
              if (name) {
                setSelectedIds(new Set(memberIds));
                setDetailId(null);
                setFilterToSelection(true);
              } else {
                setSelectedIds(new Set());
              }
            }}
          />
        )}

        <span style={{ flex: 1 }} />
        {selectedIds.size > 0 && (
          <>
            <span style={{ color: 'var(--color-primary)', fontWeight: 600, fontSize: 12 }}>
              {selectedIds.size} selected
            </span>
            <button onClick={() => { setSelectedIds(new Set()); setActiveDepartment(null); setFilterToSelection(true); }} style={ghostBtn()}>Clear</button>
            <button onClick={() => openAndAsk(Array.from(selectedIds))} style={primaryBtn()}>Ask about selection →</button>
          </>
        )}
        <button onClick={() => chatOpen ? handleClose() : setChatOpen(true)} style={ghostBtn()}>
          {chatOpen ? 'Close search' : messages.length > 0 ? `Search (${messages.length})` : 'Search'}
        </button>
      </div>

      {/* ── Department insight strip — active department chip ─────────────── */}
      {activeDepartment && (
        <DepartmentInsightStrip
          department={activeDepartment}
          people={data.nodes}
          onFocusPerson={(id) => {
            setActiveDepartment(null);
            setSelectedIds(new Set([id]));
            setDetailId(id);
            setFilterToSelection(true);
          }}
        />
      )}

      {/* ── Connection path strip — two people selected (or pinned corridor) ── */}
      {displayPath && (
        <ConnectionPathStrip
          path={displayPath}
          onHighlightPath={(ids) => {
            setPinnedPath(displayPath);
            setSelectedIds(new Set(ids));
            setDetailId(null);
            setFilterToSelection(true);
          }}
        />
      )}

      {/* ── Graph + Chat split ───────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Graph */}
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          {detailId && selectedIds.has(detailId) && (
            <PersonDetailCard
              personId={detailId}
              onClose={() => setDetailId(null)}
              onFocusPerson={(id) => {
                setSelectedIds(prev => new Set([...prev, id]));
                setDetailId(id);
              }}
              onAsk={(id) => openAndAsk([id])}
            />
          )}
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
                      <Spinner size="sm" />
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
                  presenceFilter={presenceFilter ?? undefined}
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
              <span style={{ flex: 1 }} />
              {/* This panel is Ask embedded beside the graph, not a second
                  chat product — hand the session over when the conversation
                  outgrows a side panel. */}
              <Link
                to={`/iq/invoke${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`}
                title="Continue this conversation full-width in Ask"
                style={{ fontSize: 11, color: 'var(--color-primary)', textDecoration: 'none', marginRight: 6 }}
              >
                Open in Ask →
              </Link>
              <ChatSessionPicker
                activeSessionId={sessionId}
                onPick={(sid) => {
                  rememberSession('explore', sid);
                  void loadHistory(sid);
                }}
              />
              {hasMessages && (
                <button onClick={handleNewConversation} style={iconBtn()} title="New conversation">↺</button>
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
                // Strip <thinking> blocks (no ThinkingBlock renderer here) and
                // resolve raw person IDs (e.g. "Person with ID p-007") to names.
                const resolvedContent = msg.role === 'assistant' && data
                  ? resolvePersonIds(stripThinking(msg.content), data.nodes)
                  : msg.content;
                const mentioned = msg.role === 'assistant' && data
                  ? findMentionedPeople(resolvedContent, data.nodes)
                  : [];
                return (
                  <div key={msg.id}>
                    <MessageBubble
                      role={msg.role}
                      content={resolvedContent}
                      agentName="Search agent"
                      renderMarkdown={(content) => <Markdown>{content}</Markdown>}
                    />
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
                <div>
                  <MessageBubble
                    role="assistant"
                    content={streamingText ? (data ? resolvePersonIds(stripThinking(streamingText), data.nodes) : stripThinking(streamingText)) : ''}
                    toolCalls={activeToolCalls.map(tc => ({
                      id: tc.id,
                      name: tc.name,
                      done: tc.done,
                      args: tc.args,
                    }))}
                    streaming
                    agentName="Search agent"
                    renderMarkdown={(content) => <Markdown>{content}</Markdown>}
                  />
                  {streamingText && data && (() => {
                    const live = findMentionedPeople(resolvePersonIds(streamingText, data.nodes), data.nodes);
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
            <div style={composerWrapStyle}>
              <ChatComposer
                value={input}
                onChange={setInput}
                onSubmit={handleSend}
                disabled={isStreaming}
                multiline
                placeholder="Ask about people, skills, connections…"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const toolbarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
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
const composerWrapStyle: React.CSSProperties = {
  padding: 12, borderTop: '1px solid var(--color-border)', flexShrink: 0,
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

function primaryBtn(): React.CSSProperties {
  return {
    fontSize: 11, padding: '4px 10px',
    background: 'var(--color-primary, #6366f1)', color: '#fff',
    border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
    whiteSpace: 'nowrap',
  };
}
function ghostBtn(): React.CSSProperties {
  return {
    fontSize: 11, padding: '4px 10px',
    background: 'var(--color-surface)', color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
}
function iconBtn(): React.CSSProperties {
  return {
    background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
    color: 'var(--color-text-tertiary)', padding: '2px 4px', borderRadius: 3,
  };
}

export default ExplorePage;
