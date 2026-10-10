import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { useNavigate } from 'react-router';
import { useAgentStream } from '@connorhoehnslalom/realtime-modules/agent-streaming/client';
import { Button, Chip, Inline, InlineAlert, MessageBubble, Stack, StatusPill, T } from '@connorhoehnslalom/ui-components/shared';
import { Markdown } from '../../components/Markdown';
import { agentInvokeFetch } from '../../components/chat/agentInvokeFetch';
import { deriveSources, extractSources } from '../../components/chat/answerSources';
import { coalesceAssistantMessages } from '../../components/chat/coalesceMessages';
import { SourceChips } from '../../components/chat/SourceChips';
import { friendlyToolName } from '../../components/chat/toolCallSummary';
import { linkSearchCitations, readSearchEvidence } from '../search/searchModel';
import { createTurnGate } from '../search/turnGate';
import { initiativeAgentBody, presentationReadReceipt, type InitiativeAgentRequest } from './initiativeAgentRequest';

export interface InitiativeAgentHandle {
  submit(request: InitiativeAgentRequest): boolean | string;
}

function stepLabel(name: string): string {
  return ({ search: 'Find relevant context', scoring: 'Find people who can help', advisor: 'Analyze next steps' } as Record<string, string>)[name] ?? friendlyToolName(name);
}

// The central composer owns input; this pane owns the run and its output.
// Mounted even while hidden and keyed by initiative + identity, never by leaf.
export function InitiativeAgentPanel({ ref, projectId, onOpenWorkItem, assistantTitle = 'Work Assistant', emptyTitle = 'Run an Agent task beside your work' }: {
  ref?: Ref<InitiativeAgentHandle>;
  projectId: string;
  onOpenWorkItem: (id: string) => void;
  assistantTitle?: string;
  emptyTitle?: string;
}) {
  const navigate = useNavigate();
  const gate = useMemo(createTurnGate, []);
  const currentRequest = useRef<InitiativeAgentRequest | null>(null);
  const requests = useRef(new Map<string, InitiativeAgentRequest>());
  const abort = useRef<AbortController | null>(null);
  const [latest, setLatest] = useState<InitiativeAgentRequest | null>(null);
  const [stopped, setStopped] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const followOutput = useRef(true);
  const stream = useAgentStream({
    url: '/api/agents/orgiq-supervisor/invoke',
    fetch: (input, init) => agentInvokeFetch(input, {
      ...init,
      signal: abort.current
        ? AbortSignal.any([abort.current.signal, ...(init?.signal ? [init.signal] : [])])
        : init?.signal,
    }),
    buildBody: (message, { sessionId }) => initiativeAgentBody(message, currentRequest.current, sessionId ?? undefined),
  });
  const { messages, steps, activeToolCalls, streamingText, isStreaming, error, sendMessage } = stream;

  const submit = (request: InitiativeAgentRequest): boolean | string => {
    const token = gate.tryBegin();
    if (token === null) return 'An Agent run is already in progress. Wait for it to finish or stop it in the Agent pane.';
    const captured = { ...request, records: request.records.map(record => ({ ...record })) };
    currentRequest.current = captured;
    requests.current.set(captured.prompt, captured);
    abort.current = new AbortController();
    setLatest(captured);
    setStopped(false);
    setStartedAt(Date.now());
    setElapsed(0);
    followOutput.current = true;
    // Keep the captured prompt as the transcript key: repeating the same
    // question on another slide cannot relabel the earlier turn. buildBody
    // sends only the raw question plus typed IDs to the server.
    void sendMessage(captured.prompt).finally(() => { gate.end(token); abort.current = null; });
    return true;
  };
  useImperativeHandle(ref, () => ({ submit }));
  useEffect(() => () => { abort.current?.abort(); }, []);
  useEffect(() => {
    if (!isStreaming) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming, startedAt]);
  useEffect(() => {
    const element = transcriptRef.current;
    if (element && followOutput.current) element.scrollTop = element.scrollHeight;
  }, [messages, streamingText, steps, error]);

  const displayMessages = coalesceAssistantMessages(messages);
  const lastQuestion = messages.map(message => message.role).lastIndexOf('user');
  const turnMessages = messages.slice(lastQuestion + 1);
  const hasAnswer = turnMessages.some(message => message.role === 'assistant' && !!message.content.trim());
  const turnTools = [...new Map([...turnMessages.flatMap(message => message.toolCalls ?? []), ...activeToolCalls].map(tool => [tool.id, tool])).values()];
  // A tool is complete when its result arrives, not when argument streaming
  // ends. Named phases and attached-context reads are observed stream events.
  const progress = [
    ...turnTools.filter(tool => !steps.length || ['search_context', 'presentation_context'].includes(tool.name)).map(tool => ({
      name: tool.name === 'presentation_context' ? 'Read selected presentation content' : tool.name === 'search_context' ? 'Read attached context' : friendlyToolName(tool.name),
      done: tool.result !== undefined,
    })),
    ...steps.map(step => ({ name: stepLabel(step.name), done: step.status === 'done' })),
  ];
  const status = isStreaming ? stopped ? 'Stopping' : 'Running' : stopped ? 'Stopped' : error ? 'Failed' : latest ? hasAnswer ? 'Complete' : 'No result' : 'Ready';
  const lastStep = [...steps].reverse().find(step => step.status === 'running');
  const progressLabel = lastStep ? stepLabel(lastStep.name) : streamingText ? 'Writing the result' : activeToolCalls.length ? 'Reading the results' : 'Starting the run';

  return <Stack gap="none" className="min-h-0 flex-1 h-full" data-testid="initiative-agent-panel">
    <Stack gap="xs" className="border-b border-border px-4 py-3 shrink-0 bg-surface-secondary/40">
      <Inline align="center" justify="between" gap="sm">
        <T size="sm" weight="semibold">{assistantTitle}</T>
        <StatusPill label={status} tone={error ? 'danger' : stopped ? 'warning' : isStreaming ? 'info' : latest && hasAnswer ? 'success' : 'neutral'} />
      </Inline>
      {latest?.contextLabel && <T size="xs" tone="secondary" className="truncate" title={latest.contextLabel}>{latest.contextLabel}</T>}
      {isStreaming && <Inline align="center" justify="between" gap="sm" role="status" aria-live="polite">
        <Inline gap="xs" align="center"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" /><T size="xs">{progressLabel}</T><T size="xs" tone="secondary">{elapsed}s</T></Inline>
        <Button size="sm" variant="ghost" disabled={stopped} onClick={() => { setStopped(true); abort.current?.abort(); }}>Stop</Button>
      </Inline>}
      {!!progress.length && <ol className="grid gap-1 mt-1" aria-label="Agent progress">
        {progress.map((step, index) => <li key={`${step.name}:${index}`} className="flex items-center gap-2 text-xs text-text-secondary">
          <span aria-hidden className={step.done ? 'text-success' : isStreaming && !stopped ? 'text-primary animate-pulse' : 'text-text-tertiary'}>{step.done ? '✓' : '•'}</span>
          <span className="flex-1">{step.name}</span><span>{step.done ? 'Done' : isStreaming && !stopped ? 'In progress' : stopped ? 'Stopped' : 'Incomplete'}</span>
        </li>)}
      </ol>}
    </Stack>
    <Stack ref={transcriptRef} gap="md" className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      onScroll={() => { const element = transcriptRef.current; if (element) followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; }}>
      {!latest && <Stack gap="xs">
        <T size="sm" weight="semibold">{emptyTitle}</T>
        <T size="sm" tone="secondary" wrap>Use Agent in the composer below. Progress, results, and sources appear here while you keep working.</T>
      </Stack>}
      {displayMessages.map(message => {
        const request = requests.current.get(message.content);
        if (message.role === 'user') return <Stack key={message.id} gap="xs" className="border-t border-border pt-3 first:border-t-0 first:pt-0">
          <T size="sm" weight="semibold" wrap>{request?.question ?? message.content}</T>
          {request?.contextLabel && <Chip size="sm" className="max-w-full truncate self-start" title={request.contextLabel}>{request.contextLabel}</Chip>}
        </Stack>;
        const answer = deriveSources({ content: message.content, toolCalls: message.toolCalls });
        const evidence = readSearchEvidence(message.toolCalls);
        const presentation = presentationReadReceipt(message.toolCalls);
        return <Stack key={message.id} gap="sm">
          <Markdown>{linkSearchCitations(answer.cleaned.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/g, ''), evidence)}</Markdown>
          {presentation && <T size="xs" tone="secondary" wrap data-testid="presentation-read-receipt">
            {presentation.provenance === 'visible-draft' ? 'Visible draft read' : 'Saved presentation content read'}: {presentation.title}
            {presentation.scope !== 'deck' ? ` › ${presentation.slideTitles.join(', ')}` : ' · whole presentation'} · {presentation.revisionId}
          </T>}
          {!!evidence.length && <Inline gap="xs" wrap aria-label="Referenced records">
            {evidence.map(record => <Button key={`${record.type}:${record.id}`} size="sm" variant="secondary" className="max-w-full"
              onClick={() => record.type === 'work' && record.href.split('?')[0] === `/iq/projects/${projectId}` ? onOpenWorkItem(record.id) : navigate(record.href)}>
              <span className="truncate">{record.title}</span>
            </Button>)}
          </Inline>}
          <SourceChips sources={answer.sources} provenance={answer.provenance} />
        </Stack>;
      })}
      {isStreaming && <MessageBubble role="assistant" agentName={assistantTitle} streaming
        content={extractSources(streamingText).cleaned.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/g, '')}
        toolCalls={activeToolCalls.map(tool => ({ id: tool.id, name: tool.name === 'presentation_context' ? 'Read selected presentation content' : tool.name === 'search_context' ? 'Read attached context' : friendlyToolName(tool.name), done: tool.done }))}
        renderMarkdown={content => <Markdown>{content}</Markdown>} />}
      {error && <InlineAlert tone="error">
        <Stack gap="sm"><T size="sm" weight="semibold">Agent task failed</T><T size="sm" wrap>{error}</T><Button size="sm" variant="secondary" disabled={isStreaming} onClick={() => { if (latest) submit(latest); }}>Retry this task</Button></Stack>
      </InlineAlert>}
      {stopped && !isStreaming && <InlineAlert tone="info">Run stopped. The output above may be incomplete.</InlineAlert>}
      {latest && !isStreaming && !error && !stopped && !hasAnswer && <InlineAlert tone="warning">
        <Stack gap="sm"><T size="sm">No result received.</T><Button size="sm" variant="secondary" onClick={() => submit(latest)}>Retry this task</Button></Stack>
      </InlineAlert>}
      {latest && !isStreaming && <T size="xs" tone="secondary" wrap>Ask a follow-up using Agent in the composer below.</T>}
    </Stack>
  </Stack>;
}
