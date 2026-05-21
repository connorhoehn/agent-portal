import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { useAgentStream } from '@connorhoehn/realtime-modules/agent-streaming/client';
import type { ToolCall as LiveToolCall, Message as AgentMessage } from '@connorhoehn/realtime-modules/agent-streaming/client';
import { useFetch } from '../hooks/useFetch';
import { Markdown } from '../components/Markdown';
import { useSessionPresence } from '../hooks/useSessionPresence';
import { PresenceAvatarGroup } from '../components/shell/PresenceAvatarGroup';

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
  const { peers } = useSessionPresence('invoke');
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
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sessions</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              onClick={reset}
              title="New session"
              style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', cursor: 'pointer' }}
            >
              + New
            </button>
            <PresenceAvatarGroup peers={peers} />
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
              <div
                key={s.sessionId}
                onClick={() => loadSession(s.sessionId)}
                style={{
                  padding: '8px 14px',
                  cursor: 'pointer',
                  background: selected ? 'var(--color-surface-hover)' : undefined,
                  borderLeft: selected ? '3px solid var(--color-primary)' : '3px solid transparent',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.title || <span style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>Untitled session</span>}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                  {new Date(s.createdAt).toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Chat area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 24 }}>
        <div style={{ flex: 1, overflow: 'auto', marginBottom: 16 }}>
          {messages.length === 0 && !isStreaming && (
            <div style={{ padding: 40, color: 'var(--color-text-tertiary)' }}>
              <div style={{ fontSize: 18, marginBottom: 4, textAlign: 'center' }}>Invoke {selectedAgent?.name ?? 'Agent'}</div>
              <div style={{ fontSize: 13, marginBottom: 24, textAlign: 'center' }}>Send a message or try a quick prompt below</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8, maxWidth: 760, margin: '0 auto' }}>
                {quickPromptsFor(selectedId).map(p => (
                  <button
                    key={p.label}
                    onClick={() => { sendMessage(p.prompt); }}
                    style={{
                      textAlign: 'left',
                      padding: 12,
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 6,
                      cursor: 'pointer',
                      color: 'var(--color-text-primary)',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, color: p.badgeColor ?? 'var(--color-text-primary)', marginBottom: 4 }}>
                      {p.badge ? <span style={{ marginRight: 6 }}>{p.badge}</span> : null}{p.label}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.4 }}>{p.prompt}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map(msg => (
            <div key={msg.id} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                {msg.role === 'user' ? 'You' : selectedAgent?.name ?? 'Agent'}
              </div>
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  {msg.toolCalls.map(tc => (
                    <div key={tc.id} style={{ fontSize: 11, padding: '3px 8px', background: 'var(--color-info-bg, #eff6ff)', borderRadius: 4, marginBottom: 3, fontFamily: 'monospace' }}>
                      {tc.name} {tc.result && <span style={{ color: 'var(--color-success)' }}>✓</span>}
                    </div>
                  ))}
                </div>
              )}
              <MessageContent content={msg.content} role={msg.role} />
            </div>
          ))}
          {isStreaming && (
            <StreamingMessage
              agentName={selectedAgent?.name ?? 'Agent'}
              activeToolCalls={activeToolCalls}
              text={streamingText}
            />
          )}
          {error && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>Error: {error}</div>}
          <div ref={bottomRef} />
        </div>

        {/* Suggested search bubbles — shown when conversation has messages */}
        {messages.length > 0 && !isStreaming && suggestions.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => handleSuggestion(s)}
                style={{
                  padding: '5px 12px',
                  borderRadius: 9999,
                  border: '1px solid var(--color-border, #e5e7eb)',
                  background: 'var(--color-surface, #fff)',
                  color: 'var(--color-text-secondary, #4b5563)',
                  fontSize: 12, fontWeight: 500, cursor: 'pointer',
                  transition: 'all 0.12s',
                  whiteSpace: 'nowrap',
                  maxWidth: 260,
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-hover, #f3f4f6)';
                  (e.currentTarget as HTMLElement).style.borderColor = '#6366f1';
                  (e.currentTarget as HTMLElement).style.color = '#6366f1';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = 'var(--color-surface, #fff)';
                  (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border, #e5e7eb)';
                  (e.currentTarget as HTMLElement).style.color = 'var(--color-text-secondary, #4b5563)';
                }}
              >
                {s}
              </button>
            ))}
            {/* Refresh button */}
            <button
              onClick={() => setSuggestionSeed(k => k + 1)}
              title="Refresh suggestions"
              style={{
                width: 28, height: 28,
                borderRadius: '50%',
                border: '1px solid var(--color-border, #e5e7eb)',
                background: 'var(--color-surface, #fff)',
                color: 'var(--color-text-tertiary, #9ca3af)',
                fontSize: 14, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
                transition: 'all 0.12s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.borderColor = '#6366f1';
                (e.currentTarget as HTMLElement).style.color = '#6366f1';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border, #e5e7eb)';
                (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary, #9ca3af)';
              }}
            >
              ↻
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder={`Ask ${selectedAgent?.name ?? 'agent'}...`}
            disabled={isStreaming}
            style={{ flex: 1, padding: '10px 14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 14, outline: 'none' }}
          />
          <button onClick={handleSend} disabled={isStreaming || !input.trim()} style={{
            padding: '10px 20px', background: 'var(--color-primary)', color: 'white',
            border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 500,
            opacity: isStreaming || !input.trim() ? 0.6 : 1,
          }}>Send</button>
        </div>
      </div>
    </div>
  );
}

// Split assistant content on <thinking>…</thinking> so the chain-of-thought
// renders as a collapsed detail block instead of cluttering the response.
type Segment = { kind: 'text' | 'thinking'; body: string };

function parseSegments(content: string): Segment[] {
  const out: Segment[] = [];
  const re = /<thinking>([\s\S]*?)<\/thinking>/gi;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > cursor) {
      out.push({ kind: 'text', body: content.slice(cursor, m.index) });
    }
    out.push({ kind: 'thinking', body: m[1] ?? '' });
    cursor = m.index + m[0].length;
  }
  if (cursor < content.length) {
    out.push({ kind: 'text', body: content.slice(cursor) });
  }
  // Handle an unclosed <thinking> tag during streaming
  const openIdx = content.lastIndexOf('<thinking>');
  const closeIdx = content.lastIndexOf('</thinking>');
  if (openIdx > closeIdx) {
    const partial = content.slice(openIdx + '<thinking>'.length);
    const before = content.slice(0, openIdx);
    return [
      ...(before ? [{ kind: 'text' as const, body: before }] : []),
      { kind: 'thinking', body: partial },
    ];
  }
  return out;
}

function MessageContent({ content, role }: { content: string; role: 'user' | 'assistant' }) {
  // User messages: render verbatim (no markdown interpretation — user typed
  // it, they expect it back as-is). Assistant messages: render markdown for
  // headings, lists, tables, code blocks — common in Nova Pro output.
  if (role === 'user') {
    return <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{content}</div>;
  }

  const segments = parseSegments(content);
  if (segments.length === 0) {
    return <Markdown>{content}</Markdown>;
  }
  return (
    <div style={{ fontSize: 14, lineHeight: 1.6 }}>
      {segments.map((seg, i) =>
        seg.kind === 'thinking' ? (
          <details
            key={i}
            style={{
              margin: '6px 0',
              padding: '6px 10px',
              background: 'var(--color-surface-hover, #f3f4f6)',
              borderLeft: '3px solid var(--color-text-tertiary, #94a3b8)',
              borderRadius: 4,
              fontSize: 12,
              color: 'var(--color-text-tertiary, #64748b)',
            }}
          >
            <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 500 }}>
              thinking
            </summary>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 6, fontStyle: 'italic' }}>
              {seg.body.trim()}
            </div>
          </details>
        ) : (
          <Markdown key={i}>{seg.body}</Markdown>
        ),
      )}
    </div>
  );
}

function StreamingMessage({ agentName, activeToolCalls, text }: {
  agentName: string;
  activeToolCalls: LiveToolCall[];
  text: string;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
        {agentName}
      </div>
      {activeToolCalls.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {activeToolCalls.map(tc => (
            <div
              key={tc.id}
              style={{
                fontSize: 11,
                padding: '5px 10px',
                background: tc.done ? 'var(--color-info-bg, #eff6ff)' : '#fef9c3',
                border: `1px solid ${tc.done ? '#bfdbfe' : '#fde68a'}`,
                borderRadius: 4,
                marginBottom: 4,
                fontFamily: 'monospace',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
              }}
            >
              <span style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: tc.done ? '#22c55e' : '#f59e0b',
                flexShrink: 0,
                marginTop: 2,
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontWeight: 600 }}>{tc.name}</span>
                  {tc.done
                    ? <span style={{ color: '#16a34a', fontSize: 10 }}>done</span>
                    : <span style={{ color: '#92400e', fontSize: 10 }}>running…</span>}
                </div>
                {tc.args && (
                  <div style={{ color: 'var(--color-text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                    {tc.args.length > 120 ? tc.args.slice(0, 120) + '…' : tc.args}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {text ? (
        <MessageContent content={text} role="assistant" />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-tertiary)', fontSize: 13 }}>
          <ThinkingDots />
          <span>Thinking…</span>
        </div>
      )}
    </div>
  );
}

function ThinkingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {[0, 1, 2].map(i => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: 'var(--color-text-tertiary)',
            opacity: 0.4,
            animation: `thinkingDot 1.2s ${i * 0.2}s infinite ease-in-out`,
          }}
        />
      ))}
      <style>{`
        @keyframes thinkingDot {
          0%, 80%, 100% { opacity: 0.4; transform: scale(1); }
          40% { opacity: 1; transform: scale(1.3); }
        }
      `}</style>
    </span>
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
