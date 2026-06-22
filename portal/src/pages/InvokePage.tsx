import { useEffect, useRef, useState, useMemo, useCallback, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useAgentStream } from '@connorhoehnslalom/realtime-modules/agent-streaming/client';
import type { Message as AgentMessage } from '@connorhoehnslalom/realtime-modules/agent-streaming/client';
import {
  ChatComposer,
  MessageBubble,
  QuickPromptGrid,
  FollowUpChips,
  ThinkingBlock,
} from '@connorhoehnslalom/ui-components/shared';
import { ChatPanel } from '@connorhoehnslalom/ui-components/social';
import { useFetch } from '../hooks/useFetch';
import { Markdown } from '../components/Markdown';
import { usePresence, useChat } from '@connorhoehnslalom/realtime-modules/client';
import { PresenceAvatarGroup } from '../components/shell/PresenceAvatarGroup';

// Feature flag: set VITE_ORGIQ_CHAT_ENABLED=true to show the session chat sidebar.
// We avoid import.meta.env typing concerns (no vite-env.d.ts in this repo) by
// using the same cast pattern as GatewayStatusBadge.tsx.
const CHAT_ENABLED =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_ORGIQ_CHAT_ENABLED === 'true';

// ─── <thinking> block renderer ───────────────────────────────────────────────
//
// Splits assistant content on <thinking>…</thinking> tags and renders each
// segment appropriately: completed thinking blocks as collapsible ThinkingBlock
// components, any open (streaming) block as an active ThinkingBlock, and all
// plain text through the Markdown renderer.

const THINKING_RE = /(<thinking>[\s\S]*?<\/thinking>)/g;
const THINKING_OPEN = '<thinking>';
const THINKING_CLOSE = '</thinking>';

function renderMessageContent(content: string, streaming: boolean): ReactNode {
  // While streaming: detect an unclosed <thinking> tag at the end.
  if (streaming) {
    const lastOpen = content.lastIndexOf(THINKING_OPEN);
    const lastClose = content.lastIndexOf(THINKING_CLOSE);
    if (lastOpen !== -1 && lastOpen > lastClose) {
      const before = content.slice(0, lastOpen);
      const partial = content.slice(lastOpen + THINKING_OPEN.length);
      return (
        <>
          {before.trim() && <Markdown>{before}</Markdown>}
          <ThinkingBlock content={partial} streaming defaultOpen />
        </>
      );
    }
  }

  // Normal path: split completed <thinking> blocks out of the content.
  const parts = content.split(THINKING_RE);
  return (
    <>
      {parts.map((part, i) => {
        const m = part.match(/^<thinking>([\s\S]*?)<\/thinking>$/);
        if (m) {
          return <ThinkingBlock key={i} content={m[1].trim()} />;
        }
        if (part.trim()) {
          return <Markdown key={i}>{part}</Markdown>;
        }
        return null;
      })}
    </>
  );
}

interface AgentDef {
  id: string;
  name: string;
  status: string;
  protocol: string;
  model: string;
  tools: string[];
}

interface SessionSummary {
  sessionId: string;
  actorId: string;
  createdAt: string;
  title?: string;
}

interface MemoryEvent {
  eventId: string;
  sessionId: string;
  timestamp: string;
  role: 'USER' | 'ASSISTANT' | 'OTHER';
  text: string;
}

function InvokePage() {
  const { roster: peers } = usePresence('invoke');
  const { data: agents } = useFetch<AgentDef[]>('/api/agents');

  const [selectedId, setSelectedId] = useState('orgiq-supervisor');
  const {
    messages,
    isStreaming,
    streamingText,
    activeToolCalls,
    error,
    sessionId,
    sendMessage,
    reset,
    loadHistory,
  } = useAgentStream({
    url: `/api/agents/${selectedId}/invoke`,
    // Library hook's loadHistory(sid) calls this fetcher. The old hand-rolled
    // loadHistory(sid, msgs) accepted pre-fetched messages; we lift that
    // /api/sessions/<sid>/events fetch + USER/ASSISTANT filter + mapping into
    // here so the page-side loadSession is a 1-line loadHistory(sid) call.
    historyFetch: async (sid: string): Promise<AgentMessage[]> => {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/events`);
      if (!r.ok) return [];
      const body = (await r.json()) as { events: MemoryEvent[] };
      return body.events
        .filter(e => e.role === 'USER' || e.role === 'ASSISTANT')
        .map<AgentMessage>(e => ({
          id: e.eventId + ':' + e.role,
          role: e.role === 'USER' ? 'user' : 'assistant',
          content: e.text,
          toolCalls: [],
        }));
    },
  });
  const [input, setInput] = useState('');
  const [suggestionSeed, setSuggestionSeed] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { data: sessionList, refresh: refreshSessions } = useFetch<{ sessions: SessionSummary[] }>(
    '/api/sessions',
    15000,
  );
  const [searchParams, setSearchParams] = useSearchParams();

  // Session-scoped chat sidebar (feature-flagged via VITE_ORGIQ_CHAT_ENABLED).
  // Channel is `orgiq:session:<sessionId>` when a session is active, otherwise
  // falls back to a generic invoke channel so the hook is never called with an
  // empty string. When CHAT_ENABLED is false the hook still runs (hooks can't
  // be conditional) but the sidebar is not rendered.
  const chatChannel = sessionId ? `orgiq:session:${sessionId}` : 'orgiq:invoke';
  const chat = useChat(chatChannel);

  const selectedAgent = agents?.find(a => a.id === selectedId);

  // Honor deep-links like /invoke?session=<id> from Memory / Sessions pages.
  // Load once on mount (or whenever the param changes), then strip the param
  // so a manual reload doesn't keep re-loading the same session over fresh state.
  useEffect(() => {
    const sid = searchParams.get('session');
    if (!sid) return;
    void loadSession(sid);
    const next = new URLSearchParams(searchParams);
    next.delete('session');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('session')]);

  useEffect(() => {
    if (!isStreaming) {
      const t = setTimeout(() => refreshSessions(), 1500);
      return () => clearTimeout(t);
    }
  }, [isStreaming, refreshSessions]);

  // Auto-scroll to bottom whenever new content arrives during streaming
  useEffect(() => {
    if (isStreaming) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [streamingText, activeToolCalls, isStreaming]);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    void sendMessage(input.trim());
    setInput('');
  };

  // Library hook's loadHistory(sid) handles the fetch via the historyFetch
  // option above (configured at the useAgentStream() call site).
  async function loadSession(sid: string) {
    await loadHistory(sid);
  }

  const sessions = sessionList?.sessions ?? [];

  // Contextual follow-up suggestions derived from conversation + refreshed on demand
  const suggestions = useMemo(
    () => buildSuggestions(messages, selectedId, suggestionSeed),
    [messages, selectedId, suggestionSeed],
  );

  const handleSuggestion = useCallback((s: string) => {
    setInput(s);
  }, []);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Session sidebar */}
      <div style={{ width: 220, borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sessions</span>
            <PresenceAvatarGroup peers={peers} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Agent selector — only shown when multiple agents are available */}
            {agents && agents.length > 1 && (
              <select
                value={selectedId}
                onChange={e => {
                  setSelectedId(e.target.value);
                  reset();  // clear current conversation when switching agents
                }}
                aria-label="Select agent"
                style={{
                  fontSize: 11,
                  border: '1px solid var(--color-border)',
                  borderRadius: 4,
                  background: 'var(--color-surface)',
                  color: 'var(--color-text-primary)',
                  padding: '2px 6px',
                  cursor: 'pointer',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            )}
            <button
              onClick={reset}
              title="New session"
              style={{ fontSize: 11, padding: '4px 10px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              + New
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {sessions.length === 0 && (
            <div style={{ padding: '12px 16px', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              No sessions yet — send a message to start one.
            </div>
          )}
          {sessions.map(s => {
            const selected = s.sessionId === sessionId;
            return (
              <button
                type="button"
                key={s.sessionId}
                onClick={() => loadSession(s.sessionId)}
                aria-current={selected ? 'page' : undefined}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 14px',
                  border: 'none',
                  background: selected ? 'var(--color-surface-hover)' : 'transparent',
                  borderLeft: selected ? '3px solid var(--color-primary)' : '3px solid transparent',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.title || <span style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>Untitled session</span>}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                  {new Date(s.createdAt).toLocaleString()}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Chat area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 24 }}>
        <div
          role="log"
          aria-live="polite"
          aria-atomic="false"
          aria-relevant="additions text"
          style={{ flex: 1, overflow: 'auto', marginBottom: 16 }}
        >
          {messages.length === 0 && !isStreaming && (
            <div style={{ padding: 40, color: 'var(--color-text-tertiary)' }}>
              <div style={{ fontSize: 18, marginBottom: 4, textAlign: 'center' }}>Invoke {selectedAgent?.name ?? 'Agent'}</div>
              <div style={{ fontSize: 13, marginBottom: 24, textAlign: 'center' }}>Send a message or try a quick prompt below</div>
              <QuickPromptGrid
                prompts={quickPromptsFor(selectedId).map(p => ({ label: p.label, hint: p.prompt }))}
                onSelect={(label) => {
                  const found = quickPromptsFor(selectedId).find(p => p.label === label);
                  if (found) sendMessage(found.prompt);
                }}
                title="Try asking:"
              />
            </div>
          )}
          {messages.map(msg => (
            <MessageBubble
              key={msg.id}
              role={msg.role}
              content={msg.content}
              toolCalls={(msg.toolCalls ?? []).map(tc => ({
                id: tc.id,
                name: tc.name,
                done: Boolean(tc.result),
              }))}
              agentName={selectedAgent?.name ?? 'Agent'}
              renderMarkdown={(content) => renderMessageContent(content, false)}
            />
          ))}
          {isStreaming && (
            <MessageBubble
              role="assistant"
              content={streamingText}
              toolCalls={activeToolCalls.map(tc => ({
                id: tc.id,
                name: tc.name,
                done: tc.done,
                args: tc.args,
              }))}
              streaming
              agentName={selectedAgent?.name ?? 'Agent'}
              renderMarkdown={(content) => renderMessageContent(content, true)}
            />
          )}
          {error && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>Error: {error}</div>}
          <div ref={bottomRef} />
        </div>

        {/* Suggested search bubbles — shown when conversation has messages */}
        {messages.length > 0 && !isStreaming && suggestions.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <FollowUpChips
              suggestions={suggestions}
              onSelect={handleSuggestion}
              onRefresh={() => setSuggestionSeed(k => k + 1)}
            />
          </div>
        )}

        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={handleSend}
          disabled={isStreaming}
          placeholder={`Ask ${selectedAgent?.name ?? 'agent'}...`}
        />
      </div>

      {/* Session chat sidebar — shown when VITE_ORGIQ_CHAT_ENABLED=true and a session is active */}
      {CHAT_ENABLED && sessionId && (
        <aside style={{
          width: 300,
          borderLeft: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
        }}>
          <div style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--color-border)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            Session Chat
          </div>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <ChatPanel
              messages={chat.messages.map(m => ({
                id: m.id,
                clientId: m.clientId,
                content: m.message,
                timestamp: m.timestamp,
                displayName: (m.metadata?.displayName as string | undefined) ?? m.clientId,
              }))}
              onSend={chat.sendMessage}
            />
          </div>
        </aside>
      )}
    </div>
  );
}

interface QuickPrompt {
  label: string;
  prompt: string;
  badge?: string;
  badgeColor?: string;
}

// Per-agent quick-prompt suggestions. The Browse 🌐 entry on the search agent
// is the discoverable doorway into the fetch_web_page tool we added earlier —
// the agent will pick it up because of the prompt's wording.
function quickPromptsFor(agentId: string): QuickPrompt[] {
  if (agentId.endsWith('search')) {
    return [
      { label: 'Browse a webpage', badge: '🌐', badgeColor: '#0ea5e9', prompt: 'Use the fetch_web_page tool to load https://example.com and tell me the page title and the first 200 characters of body text.' },
      { label: 'Live news scrape', badge: '🌐', badgeColor: '#0ea5e9', prompt: 'Browse https://news.ycombinator.com and summarize the top 3 stories with their points and titles.' },
      { label: 'Find Kubernetes experts', prompt: 'Who in the org has the most Kubernetes expertise? Use query_graph to find people with that skill.' },
      { label: 'Team breakdown', prompt: 'List the size of each team using a SQL query on team_memberships.' },
    ];
  }
  if (agentId.endsWith('scoring')) {
    return [
      { label: 'Top 10 by composite', prompt: 'Show the top 10 people by composite score across all teams.' },
      { label: 'Run Python sandbox', badge: '🐍', badgeColor: '#16a34a', prompt: 'Use run_in_sandbox to execute: import statistics; nums=[12,47,23,91,56,34,78,19,65,88]; print(f"mean={statistics.mean(nums):.2f}, stdev={statistics.stdev(nums):.2f}")' },
    ];
  }
  if (agentId.endsWith('advisor')) {
    return [
      { label: 'Pairing recommendations', prompt: 'Recommend two cross-team pairings that would strengthen the org. Explain the rationale.' },
      { label: 'Skill gap analysis', prompt: 'What are the biggest skill gaps in the org? Identify areas where we lack depth.' },
    ];
  }
  if (agentId.endsWith('supervisor')) {
    return [
      { label: 'Find an expert', prompt: 'Who is the best person to talk to about scaling Kubernetes? Use the search sub-agent.' },
      { label: 'Strategic question', prompt: 'What should our hiring priorities be for Q3? Use the advisor sub-agent.' },
      { label: 'Test the guardrail', badge: '🛡', badgeColor: '#dc2626', prompt: 'What is Raj Mehta\'s exact salary in dollars?' },
    ];
  }
  return [
    { label: 'Capabilities check', prompt: 'What can you help me with?' },
  ];
}

// ─── Contextual suggestion engine ────────────────────────────────────────────
//
// Derives short follow-up bubbles from the last assistant message. On refresh
// the seed rotates through a pool of agent-specific + org-graph queries.
// No LLM call — purely client-side so it's instant and free.

// Minimal shape needed for suggestion building (compatible with realtime-modules Message)
type SuggestionMessage = { role: 'user' | 'assistant'; content: string };

const SUPERVISOR_POOL = [
  'Who are the top Kubernetes experts?',
  'Which teams have the most cross-team collaboration?',
  'What skill gaps exist in Platform Engineering?',
  'Who should I pair with for a security audit?',
  'Show all escalated decisions this week',
  'Who owns the most critical in-progress work items?',
  'Find people with both Rust and distributed-systems skills',
  'Which projects are at risk of missing their deadline?',
  'Summarize what the Data Platform team shipped this month',
  'Who is the best person to review my Kafka PR?',
];

const SEARCH_POOL = [
  'Who has the deepest expertise in Kubernetes?',
  'List all people with Python AND AWS skills',
  'Find the top 5 engineers in the Data Platform team',
  'Which team has the most ML expertise?',
  'Who worked on the last observability incident?',
  'Who are the go-to people for React performance?',
  'Find engineers with both Terraform and Go experience',
  'Who has the highest PageRank in the org graph?',
  'Which department has the most senior engineers?',
];

const SCORING_POOL = [
  'Show top 10 by composite score',
  'Who has risen the most in expertise score this quarter?',
  'List the most influential engineers by PageRank',
  'Which team has the highest average expertise score?',
  'Show engineers with high influence but low formal seniority',
  'Find people with expertise score > 80 in Kubernetes',
];

const ADVISOR_POOL = [
  'Recommend two cross-team pairings that build org resilience',
  'What are the biggest skill gaps in the organization?',
  'Who is at risk of becoming a single-point-of-failure expert?',
  'Which teams should collaborate more based on project overlap?',
  'What hiring priorities would most strengthen the org graph?',
  'Who could mentor junior engineers in distributed systems?',
];

function poolFor(agentId: string): string[] {
  if (agentId.endsWith('search'))   return SEARCH_POOL;
  if (agentId.endsWith('scoring'))  return SCORING_POOL;
  if (agentId.endsWith('advisor'))  return ADVISOR_POOL;
  return SUPERVISOR_POOL;
}

function buildSuggestions(messages: SuggestionMessage[], agentId: string, seed: number): string[] {
  const pool = poolFor(agentId);

  // Extract people names from the last assistant message to generate contextual follow-ups
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const content = lastAssistant?.content ?? '';

  // Simple proper-noun extraction: two-word capitalized sequences
  const nameMatches = content.match(/\b([A-Z][a-z]{1,14} [A-Z][a-z]{1,14})\b/g) ?? [];
  // Deduplicate and filter out common sentence-starters
  const SKIP = new Set(['The Agent', 'Source Organization', 'Knowledge Base', 'Platform Engineering']);
  const uniqueNames = [...new Set(nameMatches)].filter(n => !SKIP.has(n)).slice(0, 2);

  const contextual: string[] = uniqueNames.flatMap(name => [
    `What projects is ${name.split(' ')[0]} working on?`,
    `Show ${name.split(' ')[0]}'s skill profile and expertise score`,
  ]).slice(0, 3);

  // Build final list: contextual first, then rotate through pool
  const offset = seed % Math.max(pool.length - 4, 1);
  const fromPool = [
    ...pool.slice(offset, offset + 4),
    ...pool.slice(0, Math.max(0, 4 - (pool.length - offset))),
  ].slice(0, 4);

  const combined = [...contextual, ...fromPool];
  // Deduplicate and limit to 5
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of combined) {
    if (!seen.has(s) && out.length < 5) { seen.add(s); out.push(s); }
  }
  return out;
}

export default InvokePage;
