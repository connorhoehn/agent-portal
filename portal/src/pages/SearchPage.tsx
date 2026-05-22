// Focused conversational org-search experience.
//
// Differs from /invoke (multi-agent debug surface) and /explore (graph-first):
// here the chat is full-width, pinned to the orgiq-search agent so the KB
// and graph tool surfaces are predictable. Sessions are accessible via the
// subnav History section; follow-up suggestions are generated from responses.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAgentStream } from '@connorhoehn/realtime-modules/agent-streaming/client';
import type { Message as AgentMessage } from '@connorhoehn/realtime-modules/agent-streaming/client';
import {
  ChatComposer,
  MessageBubble,
  QuickPromptGrid,
  FollowUpChips,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { Markdown } from '../components/Markdown';
import type { GraphPerson } from '../components/org-graph';
import { useSessionPresence } from '../hooks/useSessionPresence';
import { PresenceAvatarGroup } from '../components/shell/PresenceAvatarGroup';

// ── Types ────────────────────────────────────────────────────────────────────

interface GraphEntities {
  nodes: GraphPerson[];
}

interface MemoryEvent {
  eventId: string;
  sessionId: string;
  timestamp: string;
  role: 'USER' | 'ASSISTANT' | 'OTHER';
  text: string;
}

// ── Related-people extraction ────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMentionedPeople(
  text: string,
  sortedPeople: GraphPerson[],
  regexes: Map<string, RegExp>,
): GraphPerson[] {
  if (!text || sortedPeople.length === 0) return [];
  const stripped = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  const matched = new Map<string, GraphPerson>();
  for (const p of sortedPeople) {
    const re = regexes.get(p.id);
    if (re && re.test(stripped)) matched.set(p.id, p);
  }
  return Array.from(matched.values());
}

// ── Follow-up suggestion generation ─────────────────────────────────────────

const KNOWN_PROJECTS = [
  'Auth Migration', 'Observability Platform', 'RAG Knowledge Search',
  'LLM Application Platform', 'ML Feature Store', 'Mobile App Redesign',
  'Design System v3', 'Zero Trust Network', 'SOC2 Compliance',
  'Cost Optimization', 'Real-time Analytics Pipeline', 'Data Lake Migration',
  'Inference Platform', 'Design System API',
];

function generateFollowUps(content: string, mentionedPeople: GraphPerson[]): string[] {
  const suggestions: string[] = [];

  if (mentionedPeople.length >= 2) {
    const first = mentionedPeople[0].name;
    suggestions.push(`What departments do these ${mentionedPeople.length} people work in?`);
    suggestions.push(`Who among them has the highest expertise score?`);
    suggestions.push(`Who collaborates most closely with ${first}?`);
    suggestions.push(`Which of these people are still active at the company?`);
  } else if (mentionedPeople.length === 1) {
    const name = mentionedPeople[0].name;
    suggestions.push(`What projects is ${name} currently working on?`);
    suggestions.push(`Who does ${name} collaborate with most closely?`);
    suggestions.push(`What decisions has ${name} participated in?`);
    suggestions.push(`What skills does ${name} have?`);
  }

  const mentionedProject = KNOWN_PROJECTS.find(p => content.includes(p));
  if (mentionedProject && suggestions.length < 4) {
    suggestions.push(`Who led the ${mentionedProject}?`);
    suggestions.push(`What decisions did the ${mentionedProject} team make?`);
  }

  const generics = [
    'Who in the org has the most cross-team connections?',
    'Which team has the highest average expertise score?',
    'What were the most recent architectural decisions?',
    'Who are the top experts in ML and AI?',
  ];
  for (const g of generics) {
    if (suggestions.length >= 4) break;
    suggestions.push(g);
  }

  return suggestions.slice(0, 4);
}

// ── Quick prompts ────────────────────────────────────────────────────────────

interface QuickPrompt {
  label: string;
  prompt: string;
}

const QUICK_PROMPTS: QuickPrompt[] = [
  { label: 'Who knows X?',          prompt: 'Who in the organization has the deepest expertise in Kubernetes?' },
  { label: 'Decisions about X',     prompt: 'What recent decisions has the platform team made about authentication?' },
  { label: 'Who works on Y',        prompt: 'Which people contributed to the org-graph builder project, and what were their roles?' },
  { label: 'Compare two people',    prompt: 'Compare the expertise profiles of any two senior engineers and suggest who to ask about scaling Postgres.' },
];

// ── Page ─────────────────────────────────────────────────────────────────────

const SEARCH_AGENT_ID = 'orgiq-search';

function SearchPage() {
  const { peers } = useSessionPresence('search');
  const { data: graph } = useFetch<GraphEntities>('/api/graph/entities');
  // Holds the one-shot selection for the next outgoing message. Set inside
  // handleSend just before sendMessage(), read by buildBody when the hook
  // assembles the POST body. Lives in a ref (not the hook deps) so the
  // memoized sendMessage closure always sees the latest value.
  const pendingSelectionRef = useRef<{ peopleIds: string[] } | null>(null);
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
    url: `/api/agents/${SEARCH_AGENT_ID}/invoke`,
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
    buildBody: (text, { sessionId: sid }) => {
      const sel = pendingSelectionRef.current;
      pendingSelectionRef.current = null;
      return {
        message: text,
        ...(sid ? { sessionId: sid } : {}),
        ...(sel ? { selection: sel } : {}),
      };
    },
  });

  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // Honor deep-links like /search?session=<id> from the subnav History section.
  // ?session=new resets to a fresh conversation; a UUID loads that session.
  useEffect(() => {
    const sid = searchParams.get('session');
    if (!sid) return;
    const next = new URLSearchParams(searchParams);
    next.delete('session');
    setSearchParams(next, { replace: true });
    if (sid === 'new') {
      reset();
    } else {
      void loadHistory(sid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('session')]);

  // ?peopleIds=<csv> arrives from /explore "Ask in Search". Hold them as
  // pinned context that's attached to the next outgoing message.
  const [pinnedPeopleIds, setPinnedPeopleIds] = useState<string[]>(() => {
    const csv = new URLSearchParams(window.location.search).get('peopleIds');
    return csv ? csv.split(',').filter(Boolean) : [];
  });

  // Strip the param once we've captured it so a reload doesn't re-pin.
  useEffect(() => {
    if (!searchParams.get('peopleIds')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('peopleIds');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const pinnedPeople = useMemo<GraphPerson[]>(() => {
    if (!graph?.nodes || pinnedPeopleIds.length === 0) return [];
    const byId = new Map(graph.nodes.map(p => [p.id, p]));
    return pinnedPeopleIds.map(id => byId.get(id)).filter((p): p is GraphPerson => Boolean(p));
  }, [graph, pinnedPeopleIds]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamingText]);

  // Pre-compile one RegExp per person, sorted longest-name first so "Sarah Ahmed"
  // wins over "Sarah". Recomputed only when the people list itself changes —
  // not on every streaming token tick.
  const sortedPeople = useMemo<GraphPerson[]>(() => {
    if (!graph?.nodes) return [];
    return [...graph.nodes].sort((a, b) => b.name.length - a.name.length);
  }, [graph?.nodes]);

  const mentionRegexes = useMemo<Map<string, RegExp>>(
    () => new Map(
      sortedPeople.map(p => [
        p.id,
        new RegExp(`(?<![\\w])${escapeRe(p.name)}(?![\\w])`, 'i'),
      ]),
    ),
    [sortedPeople],
  );

  const mentionedPeople = useMemo<GraphPerson[]>(() => {
    if (!graph?.nodes) return [];
    // Combine the last assistant message + the currently-streaming text so
    // people light up as they're typed.
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    const combined = [lastAssistant?.content ?? '', streamingText].join(' ');
    return findMentionedPeople(combined, sortedPeople, mentionRegexes);
  }, [graph, messages, streamingText, sortedPeople, mentionRegexes]);

  function handleSend() {
    if (!input.trim() || isStreaming) return;
    if (pinnedPeopleIds.length > 0) {
      pendingSelectionRef.current = { peopleIds: pinnedPeopleIds };
    }
    void sendMessage(input.trim());
    setInput('');
    // The pin is one-shot context for this turn; clear so subsequent turns
    // don't keep re-applying a stale selection.
    if (pinnedPeopleIds.length > 0) setPinnedPeopleIds([]);
  }

  const hasAnyMessages = messages.length > 0 || isStreaming;

  // Follow-up suggestions: derived from the last complete assistant message.
  // Cleared when the user sends a new message.
  const lastAssistantMessage = useMemo(() => {
    return [...messages].reverse().find(m => m.role === 'assistant');
  }, [messages]);

  const followUps = useMemo<string[]>(() => {
    if (!lastAssistantMessage || isStreaming) return [];
    return generateFollowUps(lastAssistantMessage.content, mentionedPeople);
  }, [lastAssistantMessage, isStreaming, mentionedPeople]);

  function handleSendFollowUp(prompt: string) {
    void sendMessage(prompt);
  }

  return (
    <div style={containerStyle}>
      {/* ─── Chat column ─────────────────────────────────────────────────── */}
      <div style={chatColumnStyle}>
        <header style={headerStyle}>
          <div>
            <div style={titleStyle}>Search</div>
            <div style={subtitleStyle}>Ask the org-search agent — it reads the knowledge base and the people graph.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PresenceAvatarGroup peers={peers} />
            {hasAnyMessages && (
              <button onClick={reset} style={resetBtnStyle} title="Start a new search session">
                + New search
              </button>
            )}
          </div>
        </header>

        <div style={chatScrollStyle}>
          {!hasAnyMessages && (
            <div style={emptyStyle}>
              <div style={emptyTitleStyle}>Ask anything about the organization.</div>
              <div style={emptyDetailStyle}>
                The agent has access to ingested documents and the people graph. Try one of these:
              </div>
              <QuickPromptGrid
                prompts={QUICK_PROMPTS.map(p => ({ label: p.label, hint: p.prompt }))}
                onSelect={(label) => {
                  const found = QUICK_PROMPTS.find(p => p.label === label);
                  if (found) sendMessage(found.prompt);
                }}
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
                done: Boolean((tc as { done?: boolean; result?: unknown }).done ?? (tc as { result?: unknown }).result),
              }))}
              agentName="Search agent"
              renderMarkdown={(content) => <Markdown>{content}</Markdown>}
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
              agentName="Search agent"
              renderMarkdown={(content) => <Markdown>{content}</Markdown>}
            />
          )}

          {error && <div style={errorStyle}>Error: {error}</div>}
          <div ref={bottomRef} />
        </div>

        {followUps.length > 0 && (
          <div style={followUpStripStyle}>
            <FollowUpChips
              suggestions={followUps}
              onSelect={handleSendFollowUp}
              label="Follow up"
            />
          </div>
        )}

        {pinnedPeople.length > 0 && (
          <div style={pinnedStripStyle}>
            <span style={pinnedLabelStyle}>Asking about</span>
            {pinnedPeople.map(p => (
              <span key={p.id} style={pinnedChipStyle}>
                {p.name}
                <button
                  onClick={() => setPinnedPeopleIds(ids => ids.filter(id => id !== p.id))}
                  style={pinnedChipCloseStyle}
                  aria-label={`Remove ${p.name}`}
                >
                  ✕
                </button>
              </span>
            ))}
            <button onClick={() => setPinnedPeopleIds([])} style={pinnedClearStyle}>
              Clear all
            </button>
          </div>
        )}

        <div style={composerWrapStyle}>
          <ChatComposer
            value={input}
            onChange={setInput}
            onSubmit={handleSend}
            disabled={isStreaming}
            placeholder="Ask about people, projects, decisions…"
          />
        </div>
      </div>

    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  display: 'flex',
  height: '100%',
  background: 'var(--color-bg)',
};
const chatColumnStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  padding: '14px 24px',
  borderBottom: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  gap: 16,
};
const titleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
};
const subtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-tertiary)',
  marginTop: 2,
};
const resetBtnStyle: React.CSSProperties = {
  fontSize: 11,
  padding: '4px 10px',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--color-text-secondary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const chatScrollStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '20px 24px',
};
const emptyStyle: React.CSSProperties = {
  maxWidth: 720,
  margin: '40px auto',
};
const emptyTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  marginBottom: 6,
};
const emptyDetailStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-secondary)',
  marginBottom: 16,
};
const errorStyle: React.CSSProperties = {
  color: 'var(--color-danger)',
  fontSize: 13,
  padding: '8px 0',
};
const followUpStripStyle: React.CSSProperties = {
  padding: '8px 24px 10px',
  borderTop: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
};
const pinnedStripStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  padding: '8px 24px',
  borderTop: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
};
const pinnedLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  fontWeight: 600,
};
const pinnedChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  padding: '3px 4px 3px 10px',
  background: 'var(--color-surface-hover, #eef2ff)',
  color: 'var(--color-primary, #6366f1)',
  border: '1px solid var(--color-primary, #6366f1)',
  borderRadius: 999,
  fontWeight: 500,
};
const pinnedChipCloseStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  padding: '0 4px',
  fontSize: 11,
  fontFamily: 'inherit',
};
const pinnedClearStyle: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  background: 'transparent',
  color: 'var(--color-text-tertiary)',
  border: 'none',
  cursor: 'pointer',
  marginLeft: 'auto',
  fontFamily: 'inherit',
};
const composerWrapStyle: React.CSSProperties = {
  padding: '14px 24px',
  borderTop: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
};
export default SearchPage;
