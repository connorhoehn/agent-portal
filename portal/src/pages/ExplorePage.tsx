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
  indexBusFactorFindings,
  type PathHop,
  type FindingLike,
} from '../components/org-graph/ExplorePanels';
import type { MENode, MEEdge } from '../components/multi-entity-graph/types';
import {
  Banner,
  Button,
  Card,
  ChatComposer,
  DropdownMenu,
  EmptyState,
  ErrorState,
  FilterChip,
  IconButton,
  Inline,
  LoadingState,
  MessageBubble,
  PageSection,
  SegmentedControl,
  Spinner,
  Stack,
  StatusDot,
  Toolbar,
  ToolbarGroup,
  ToolbarLabel,
  Tooltip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { useSession } from '../lib/auth';
import { parseFocusIds } from '../components/org-graph/graphInsights';
import { Markdown } from '../components/Markdown';
import { T } from './Text';
import { RangeSliderFrame } from './RangeSliderFrame';
import { fetchSessionMessages, rememberSession, recallSession, forgetSession, stripThinking } from '../lib/chatSessions';
import { ChatSessionPicker } from '../components/ChatSessionPicker';
import { deriveSources, extractSources } from '../components/chat/answerSources';
import { SourceChips } from '../components/chat/SourceChips';
import { summarizeToolCalls } from '../components/chat/toolCallSummary';
import { coalesceAssistantMessages } from '../components/chat/coalesceMessages';

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

  // Influence is leadership analytics (ViewLeaderboard tier) — same gate
  // OrgGraphTooltip and PersonDetailCard already apply, mirrored here so node
  // SIZE can't leak the number to a role that can't see it in either of those.
  const { session } = useSession();
  const showInfluence =
    session?.role === 'org-leader' || session?.role === 'hr-admin' || session?.role === 'admin';

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Most recently selected person — drives the detail side panel.
  const [detailId, setDetailId] = useState<string | null>(null);
  // Department focus chip — highlights one department's people.
  const [activeDepartment, setActiveDepartment] = useState<string | null>(null);
  // "Rare skills" toolbar toggle — the org-wide bus-factor strip, shown
  // without first picking a department. A department chip takes priority
  // when both are active (see the strip render below).
  const [rareSkillsOpen, setRareSkillsOpen] = useState(false);
  const [topK, setTopK] = useState(4);
  const [minStrength, setMinStrength] = useState(0.6);
  const [chatOpen, setChatOpen] = useState(false);
  const [filterToSelection, setFilterToSelection] = useState(true);
  const [activeStatuses, setActiveStatuses] = useState<Set<string> | null>(null);
  const [presenceFilter, setPresenceFilter] = useState<'office' | 'remote' | 'away' | null>(null);

  // ?layout= and ?entities= params driven by the sub-nav catalog
  const rawLayout = searchParams.get('layout');
  const layoutMode: LayoutMode = rawLayout === 'radial' ? 'radial' : 'force';

  // entityFilter: 'all' | 'people' | 'skills' | 'projects' | 'hierarchy'
  const entityFilter = searchParams.get('entities') ?? 'all';

  // Fetch multi-entity graph data only when that view is active (lazy)
  const { data: skillsData, isLoading: skillsLoading, error: skillsError, refresh: refreshSkills } = useFetch<SkillsGraphData>(
    entityFilter === 'skills' ? '/api/graph/skills-graph' : null,
  );
  const { data: projectsData, isLoading: projectsLoading, error: projectsError, refresh: refreshProjects } = useFetch<ProjectsGraphData>(
    entityFilter === 'projects' ? '/api/graph/projects-graph' : null,
  );

  // The rare-skill strip's server-side opinion: the scheduled bus-factor
  // sweep's OPEN findings, fetched only while the strip that needs them is
  // actually on screen. `sweep=bus_factor` is the narrowest filter the route
  // supports (GET /api/work/findings?status=&sweep=) — status=open on top of
  // that keeps the read to what a reader would actually act on, not the
  // full history.
  const { data: busFactorFindingsData, error: busFactorFindingsError } = useFetch<{ findings: FindingLike[] }>(
    (activeDepartment || rareSkillsOpen) ? '/api/work/findings?status=open&sweep=bus_factor&limit=200' : null,
  );
  const busFactorFindingsIndex = useMemo(
    () => busFactorFindingsData ? indexBusFactorFindings(busFactorFindingsData.findings) : null,
    [busFactorFindingsData],
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
    setRareSkillsOpen(false);
  }, [entityFilter]);

  // ?focus=<id>[,<id>…] arrives from related-people cards on /search (one id)
  // and from Ask's "Show all N in Explore" link (comma-joined). Union every
  // id into the selection either way.
  useEffect(() => {
    const ids = parseFocusIds(searchParams.get('focus'));
    if (ids.length === 0) return;
    setSelectedIds(prev => { const n = new Set(prev); for (const id of ids) n.add(id); return n; });
    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // ── Graph filtering ────────────────────────────────────────────────────────

  // entityFilter controls which relationship types are shown.
  // Each view surfaces a distinct slice of the org graph:
  //   skills    → shared expertise connections only (expert_in_common)
  //   projects  → collaboration edges only (collaborates)
  //   hierarchy → reporting/mentoring structure (mentors + reports_to) — this
  //               is NOT the decision layer. /api/graph/entities carries no
  //               decision nodes at all (decisions only weight collaboration
  //               edges), and the 8 seeded ADR rows behind /api/graph/decisions
  //               carry no project_id, so there is no honest way to surface
  //               them here or on the initiative Decisions tab. See
  //               middleware/src/routes/decisions.ts for the full story.
  //   people / all → all edge types
  const entityFilteredEdges = useMemo(() => {
    if (!data) return [] as GraphRelationship[];
    if (entityFilter === 'skills') return data.edges.filter(e => e.type === 'expert_in_common');
    if (entityFilter === 'projects') return data.edges.filter(e => e.type === 'collaborates');
    if (entityFilter === 'hierarchy') return data.edges.filter(e => e.type === 'mentors' || e.type === 'reports_to');
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

  // When a specific edge type is active (skills/projects/hierarchy), skip the
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

  // The hook flushes an assistant message at every TEXT_MESSAGE_END, so one
  // supervisor turn (text → tool → more text) arrives as several adjacent
  // assistant messages — each MessageBubble printing its own "Search agent"
  // label. Coalesce them so the label appears once per turn.
  const displayMessages = useMemo(() => coalesceAssistantMessages(messages), [messages]);

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

  // Shared by the "Ask about selection →" chat button AND the "Open in Ask →"
  // link, so the two can never disagree about what question the selection asks.
  function buildAskForSelection(ids: string[]): { question: string; personIds: string[] } | null {
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
    if (allLabels.length === 0) return null;

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

    return { question, personIds: personIds.length > 0 ? personIds : ids };
  }

  function openAndAsk(ids?: string[]) {
    setChatOpen(true);
    if (!ids || ids.length === 0 || isStreaming) return;
    const built = buildAskForSelection(ids);
    if (!built) return;
    pendingSelectionRef.current = { peopleIds: built.personIds };
    void sendMessage(built.question);
  }

  // Same question, as a deep link to the full-width Ask page instead of the
  // side panel — for a selection worth more room than 380px, or for sharing
  // the link itself. `focus` is comma-joined ids; InvokePage resolves them
  // into names before sending, same as the chat panel does here.
  const askSelectionUrl = useMemo(() => {
    if (selectedIds.size === 0) return null;
    const built = buildAskForSelection(Array.from(selectedIds));
    if (!built) return null;
    const params = new URLSearchParams({ prompt: built.question, focus: built.personIds.join(',') });
    return `/iq/invoke?${params.toString()}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, data, meGraph]);

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
        <Stack gap="sm" className="max-w-2xl" align="start">
          <Banner variant="error" title="Could not load the org graph">
            {graphError}. People, skills, projects and reporting structure all come from Aurora, so
            this usually means the database is unreachable rather than that the graph is empty.
          </Banner>
          <Button variant="secondary" size="sm" onClick={() => refreshGraph()}>Try again</Button>
        </Stack>
      </PageSection>
    );
  }

  if (!data) {
    return (
      <PageSection title="Explore">
        <LoadingState label="Loading graph…" />
      </PageSection>
    );
  }

  const hasMessages = messages.length > 0 || isStreaming;

  return (
    <Stack gap="none" className="h-full min-h-0">
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <Toolbar
        wrap
        aria-label="Explore controls"
        end={
          <>
            {selectedIds.size > 0 && (
              <ToolbarGroup aria-label="Selection actions">
                <T className="text-primary font-semibold text-[12px]">{selectedIds.size} selected</T>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setSelectedIds(new Set()); setActiveDepartment(null); setFilterToSelection(true); }}
                >
                  Clear
                </Button>
                <Button variant="primary" size="sm" onClick={() => openAndAsk(Array.from(selectedIds))}>
                  Ask about selection →
                </Button>
                {askSelectionUrl && (
                  <Link
                    to={askSelectionUrl}
                    title="Ask the same question full-width on the Ask page"
                    className="text-[12px] text-primary no-underline hover:underline"
                  >
                    Open in Ask →
                  </Link>
                )}
              </ToolbarGroup>
            )}
            <Button variant="secondary" size="sm" onClick={() => chatOpen ? handleClose() : setChatOpen(true)}>
              {chatOpen ? 'Close search' : messages.length > 0 ? `Search (${messages.length})` : 'Search'}
            </Button>
          </>
        }
      >
        <ToolbarLabel>Explore</ToolbarLabel>
        {/* Layout is a rendering choice, not a place — it used to live in the
            sub-nav rail as two pseudo-pages (Force / Radial). */}
        <SegmentedControl
          size="sm"
          value={layoutMode}
          onChange={(v) => {
            const next = new URLSearchParams(searchParams);
            next.set('layout', v);
            setSearchParams(next, { replace: true });
          }}
          options={[
            { label: 'Force', value: 'force' },
            { label: 'Radial', value: 'radial' },
          ]}
        />
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
        <T className="text-text-tertiary">
          {meGraph
            // `T` is a flex row, and a flex container trims the spaces at the
            // edges of a bare text run — "56people · 131edges". Non-breaking
            // spaces survive it.
            ? <><b>{meGraph.nodes.filter(n => n.kind !== 'skill_domain').length}</b>&nbsp;nodes&nbsp;·&nbsp;<b>{meGraph.edges.filter(e => e.type !== 'belongs_to').length}</b>&nbsp;{entityFilter}&nbsp;edges</>
            : <><b>{visibleNodes.length}</b>{isFiltered ? ` / ${data?.nodes.length ?? 0}` : ''}&nbsp;people&nbsp;·&nbsp;<b>{filteredEdges.length}</b>{isEntityFiltered ? ` ${entityFilter}` : ''}&nbsp;edges</>
          }
        </T>
        {isFiltered && (
          <Button variant="primary" size="sm" onClick={() => setFilterToSelection(false)}>✕ Show full graph</Button>
        )}
        <RangeSliderFrame
          label="Top-K"
          ariaLabel="Top K results"
          min={1}
          max={10}
          value={topK}
          onChange={v => setTopK(v)}
          valueLabel={topK}
        />
        <RangeSliderFrame
          label="Min strength"
          ariaLabel="Minimum relationship strength"
          min={0}
          max={100}
          value={Math.round(minStrength * 100)}
          onChange={v => setMinStrength(v / 100)}
          valueLabel={minStrength.toFixed(2)}
          disabled={isSpecificFilter}
          title={isSpecificFilter ? 'Min strength ignored when a specific view is active' : undefined}
        />
        {entityFilter === 'projects' && meGraph?.allStatuses && meGraph.allStatuses.length > 0 && (
          <Inline gap="xs" align="center">
            <T className="text-text-secondary">Status</T>
            {meGraph.allStatuses.map(s => {
              const isActive = activeStatuses === null || activeStatuses.has(s);
              return (
                <FilterChip
                  key={s}
                  active={isActive}
                  size="sm"
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
                >
                  {projectStatusLabel(s)}
                </FilterChip>
              );
            })}
          </Inline>
        )}

        {/* Presence dropdown — only relevant for person-based views */}
        {(entityFilter === 'all' || entityFilter === 'people' || entityFilter === 'hierarchy') && (() => {
          const FACETS = [
            { key: 'office' as const, label: 'In Office', dot: 'var(--color-success)' },
            { key: 'remote' as const, label: 'Remote',    dot: 'var(--color-info)' },
            { key: 'away'   as const, label: 'Away',      dot: 'var(--color-warning)' },
          ];
          const activeFacet = FACETS.find(f => f.key === presenceFilter);
          return (
            <DropdownMenu
              triggerLabel="Filter by presence"
              triggerTitle="Filter by presence"
              trigger={
                <Inline as="span" gap="xs" align="center">
                  {activeFacet && <StatusDot color={activeFacet.dot} size="xs" />}
                  <T>{activeFacet ? activeFacet.label : 'Today'}</T>
                </Inline>
              }
              sections={[{
                items: FACETS.map(({ key, label, dot }) => {
                  const count = data?.nodes.filter(n => {
                    const p = n.presence ?? 'unknown';
                    if (key === 'office') return p === 'office';
                    if (key === 'remote') return p === 'wfh' || p === 'travel';
                    return p === 'pto' || p === 'vacation' || p === 'sick';
                  }).length ?? 0;
                  const active = presenceFilter === key;
                  return {
                    label: `${label} · ${count}`,
                    icon: <StatusDot color={dot} size="xs" />,
                    active,
                    onSelect: () => setPresenceFilter(active ? null : key),
                  };
                }),
              }]}
            />
          );
        })()}

        {(entityFilter === 'all' || entityFilter === 'people' || entityFilter === 'hierarchy') && (
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
        {(entityFilter === 'all' || entityFilter === 'people' || entityFilter === 'hierarchy') && (
          <FilterChip
            active={rareSkillsOpen}
            size="sm"
            onClick={() => setRareSkillsOpen(v => !v)}
          >
            ⚠ Rare skills · org-wide
          </FilterChip>
        )}
      </Toolbar>

      {/* ── Rare-skill insight strip — an active department chip wins over the
             org-wide toggle, since a department is a more specific view. ── */}
      {(activeDepartment || rareSkillsOpen) && (
        <DepartmentInsightStrip
          department={activeDepartment}
          people={data.nodes}
          busFactorFindings={busFactorFindingsIndex}
          busFactorFindingsUnavailable={!!busFactorFindingsError}
          onFocusPerson={(id) => {
            setActiveDepartment(null);
            setRareSkillsOpen(false);
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
      <Inline gap="none" align="stretch" wrap={false} className="flex-1 min-h-0">
        {/* Graph */}
        <Stack gap="none" className="flex-1 relative min-w-0">
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
                <Stack align="center" justify="center" className="h-full">
                  {meLoading ? (
                    <Card padding="md" className="flex flex-col items-center gap-2 text-[13px] text-text-secondary">
                      <Spinner size="sm" />
                      <T>Loading {entityFilter} graph…</T>
                    </Card>
                  ) : meError ? (
                    <ErrorState
                      title={`Failed to load ${entityFilter} graph`}
                      description={meError}
                      actionLabel="Retry"
                      onAction={meRefresh}
                    />
                  ) : null}
                </Stack>
              );
            }

            // Hierarchy filter: show empty state when no hierarchy edges exist
            if (entityFilter === 'hierarchy' && filteredEdges.length === 0 && selectedIds.size === 0) {
              return (
                <Stack align="center" justify="center" className="h-full">
                  <EmptyState
                    icon="🏛"
                    title="No hierarchy data"
                    description={
                      <Stack gap="sm" align="center" className="max-w-[420px] text-center">
                        <T className="text-[12px] text-text-secondary leading-relaxed">
                          The Hierarchy view shows mentoring and reporting relationships — who reports to whom and who mentors whom across the org.
                        </T>
                        <T className="text-[12px] text-text-tertiary leading-snug">
                          No <code>mentors</code> or <code>reports_to</code> edges are in the graph yet. Run the ingestion pipeline to extract org hierarchy from 1:1 notes and performance reviews, or select <b>All</b> to explore the full collaboration network.
                        </T>
                      </Stack>
                    }
                    actionLabel="Switch to All"
                    onAction={() => setSearchParams(new URLSearchParams({ entities: 'all' }))}
                  />
                </Stack>
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
                  showInfluence={showInfluence}
                />
                {selectedIds.size === 0 && !chatOpen && (
                  <T className="absolute bottom-3 left-3 px-2.5 py-1.5 bg-surface border border-border rounded text-[11px] text-text-tertiary">
                    Click people to select them, then&nbsp;<b>Ask about selection</b>&nbsp;to query with the graph in view.
                  </T>
                )}
              </>
            );
          })()}
        </Stack>

        {/* Chat panel */}
        {chatOpen && (
          <Stack gap="none" className="w-[380px] shrink-0 border-l border-border bg-surface min-h-0">
            {/* Panel header */}
            <Inline align="center" justify="between" className="px-3 py-2 border-b border-border shrink-0">
              <T className="font-semibold text-[12px]">Search</T>
              <Inline align="center" gap="sm">
                {/* This panel is Ask embedded beside the graph, not a second
                    chat product — hand the session over when the conversation
                    outgrows a side panel. */}
                <Link
                  to={`/iq/invoke${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`}
                  title="Continue this conversation full-width in Ask"
                  className="text-[11px] text-primary no-underline"
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
                  <IconButton
                    aria-label="New conversation"
                    title="New conversation"
                    variant="ghost"
                    size="sm"
                    onClick={handleNewConversation}
                    icon={<T>↺</T>}
                  />
                )}
              </Inline>
            </Inline>

            {/* Messages */}
            <Stack
              gap="md"
              className="flex-1 overflow-y-auto px-3 pt-3 pb-0"
              role="log"
              aria-live="polite"
              aria-relevant="additions text"
            >
              {!hasMessages && (
                <T className="text-text-tertiary text-[12px] leading-relaxed py-2">
                  Ask anything about your org — people, skills, connections, reporting lines.
                </T>
              )}
              {displayMessages.map(msg => {
                // Compose: strip <thinking> blocks (no ThinkingBlock renderer
                // here) → derive sources from the turn's tool calls and drop
                // the model's unverifiable citations from the prose → resolve
                // raw person IDs (e.g. "Person with ID p-007") to names.
                const { cleaned, sources, provenance } = msg.role === 'assistant'
                  ? deriveSources({ content: stripThinking(msg.content), toolCalls: msg.toolCalls })
                  : { cleaned: msg.content, sources: [], provenance: undefined };
                const resolvedContent = msg.role === 'assistant' && data
                  ? resolvePersonIds(cleaned, data.nodes)
                  : cleaned;
                const mentioned = msg.role === 'assistant' && data
                  ? findMentionedPeople(resolvedContent, data.nodes)
                  : [];
                // Behind-the-scenes semantics: what this turn actually did,
                // from the tool calls the stream captured (if any).
                const toolSummary = msg.role === 'assistant' ? summarizeToolCalls(msg.toolCalls) : null;
                return (
                  <Stack key={msg.id} gap="xs">
                    <MessageBubble
                      role={msg.role}
                      content={resolvedContent}
                      agentName="Search agent"
                      renderMarkdown={(content) => <Markdown>{content}</Markdown>}
                    />
                    {toolSummary && (
                      <T className="text-[11px] text-text-tertiary mt-0.5">{toolSummary}</T>
                    )}
                    <SourceChips sources={sources} {...(provenance ? { provenance } : {})} />
                    {mentioned.length > 0 && (
                      <Inline gap="xs" wrap className="mt-1.5">
                        {mentioned.map(p => (
                          <Tooltip
                            key={p.id}
                            content={selectedIds.has(p.id) ? 'Click to deselect on graph' : 'Click to highlight on graph'}
                          >
                            <FilterChip active={selectedIds.has(p.id)} onClick={() => toggleSelect(p.id)} size="xs">
                              {p.name}
                            </FilterChip>
                          </Tooltip>
                        ))}
                      </Inline>
                    )}
                  </Stack>
                );
              })}
              {isStreaming && (
                <Stack gap="xs">
                  <MessageBubble
                    role="assistant"
                    content={streamingText ? (() => {
                      // Same composition as completed messages, applied live so
                      // raw s3:// URIs never flash into the streaming prose.
                      const live = extractSources(stripThinking(streamingText)).cleaned;
                      return data ? resolvePersonIds(live, data.nodes) : live;
                    })() : ''}
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
                      <Inline gap="xs" wrap className="mt-1.5">
                        {live.map(p => (
                          <Tooltip
                            key={p.id}
                            content={selectedIds.has(p.id) ? 'Click to deselect on graph' : 'Click to highlight on graph'}
                          >
                            <FilterChip active={selectedIds.has(p.id)} onClick={() => toggleSelect(p.id)} size="xs">
                              {p.name}
                            </FilterChip>
                          </Tooltip>
                        ))}
                      </Inline>
                    ) : null;
                  })()}
                </Stack>
              )}
              {error && <Banner variant="error">Error: {error}</Banner>}
              <div ref={bottomRef} />
            </Stack>

            {/* Composer */}
            <Stack gap="none" className="p-3 border-t border-border shrink-0">
              <ChatComposer
                value={input}
                onChange={setInput}
                onSubmit={handleSend}
                disabled={isStreaming}
                multiline
                placeholder="Ask about people, skills, connections…"
              />
            </Stack>
          </Stack>
        )}
      </Inline>
    </Stack>
  );
}

export default ExplorePage;
