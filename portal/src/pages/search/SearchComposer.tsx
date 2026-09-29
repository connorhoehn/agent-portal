// The Search composer (goal decision 6): the shared `AgentComposerDock` — the
// same shell as the initiative pages — in its `document` presentation. Agent ⌄
// is the only live mode; Chat and Terminal are listed with the reason they are
// off. Workflow ⌄ rows and their `/ commands` are the `searchWorkflows` prompt
// templates; `/agent <name>` picks an agent explicitly, anything else routes to
// the supervisor. `#` attaches records as context. Attachments stay in the
// draft and are not forwarded (as on the initiative composer).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Stack } from '@connorhoehnslalom/ui-components/shared';
import { AgentComposerDock, type RichChatComposerHandle, type RichChatDraft } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { recordKey, SEARCH_LABELS, type SearchRecord } from './searchTypes';
import { parseSearchCommand, type SearchAgent } from './searchCommands';
import { searchWorkflowCommands, searchWorkflowIn, type SearchWorkflowRow } from './searchWorkflows';

export interface SearchComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (text: string, agentId?: string) => void | boolean | Promise<boolean>;
  disabled?: boolean;
  agents: SearchAgent[];
  references: SearchRecord[];
  onRemoveReference: (key: string) => void;
  onSearchContext: (query: string) => void | Promise<SearchRecord[]>;
  contextSuggestions: SearchRecord[];
  onAddReference: (record: SearchRecord) => void;
  /** Workflow ⌄ rows and their /commands (searchWorkflows). */
  workflows?: SearchWorkflowRow[];
  onWorkflow?: (row: SearchWorkflowRow) => void;
}
function draftOf(text: string): RichChatDraft {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return { html: escaped ? `<p>${escaped.replace(/\n/g, '<br>')}</p>` : '', files: [] };
}
/** Preserve the formatting controls in the text-based agent protocol. */
function markdownOf(html: string): string {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  function render(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    const content = Array.from(node.childNodes).map(render).join('');
    switch (node.tagName) {
      case 'STRONG': case 'B': return `**${content}**`;
      case 'EM': case 'I': return `*${content}*`;
      case 'S': return `~~${content}~~`;
      case 'CODE': return node.parentElement?.tagName === 'PRE' ? content : `\`${content}\``;
      case 'PRE': return `\n\`\`\`\n${content}\n\`\`\`\n`;
      case 'A': { const href = node.getAttribute('href') ?? ''; return /^(https?:\/\/|mailto:|\/)/i.test(href) ? `[${content}](${href})` : content; }
      case 'BR': return '\n';
      case 'P': return `${content}\n\n`;
      case 'LI': return `${node.parentElement?.tagName === 'OL' ? '1.' : '-'} ${content.trim()}\n`;
      case 'BLOCKQUOTE': return content.trim().split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
      default: return content;
    }
  }
  return Array.from(body.childNodes).map(render).join('').trim();
}
export function SearchComposer({ value, onChange, onSubmit, disabled, agents, references, onRemoveReference, onSearchContext, contextSuggestions, onAddReference, workflows = [], onWorkflow }: SearchComposerProps) {
  const editorRef = useRef<RichChatComposerHandle>(null);
  const [draft, setDraft] = useState<RichChatDraft>(() => draftOf(value));
  const [error, setError] = useState('');
  const lastText = useRef(value);
  const knownRecords = useRef(new Map<string, SearchRecord>());
  for (const record of [...references, ...contextSuggestions]) knownRecords.current.set(recordKey(record), record);
  useEffect(() => {
    if (value !== lastText.current) { lastText.current = value; setDraft(draftOf(value)); setError(''); }
  }, [value]);
  const commands = useMemo(() => [{ trigger: '/agent', label: 'Ask a specific agent', description: 'Choose an available agent for this message.',
    argument: { placeholder: 'Choose an agent', search: (query: string) => agents.filter(agent => `${agent.name} ${agent.id}`.toLowerCase().includes(query.toLowerCase())).map(agent => ({ id: agent.id, label: agent.name, hint: agent.id })) },
  }, ...searchWorkflowCommands(workflows)], [agents, workflows]);
  const attachDraftReferences = () => {
    editorRef.current?.editor?.state.doc.descendants(node => {
      if (node.type.name !== 'docref') return;
      const key = String(node.attrs.id ?? '');
      const record = knownRecords.current.get(key);
      if (record && !references.some(ref => recordKey(ref) === key)) onAddReference(record);
    });
  };
  return <Stack gap="none" className="min-w-0">
    <AgentComposerDock presentation="document" label="Search composer" inputLabel="Search question" data-testid="search-composer" composerTestId="search-rich-composer"
      composerRef={editorRef} allowEmoji={false} disabled={disabled}
      disabledModes={['chat', 'terminal']}
      modeUnavailableReasons={{ chat: 'Search has no discussion thread — ask the agent', terminal: 'Search has no terminal' }}
      modePlaceholders={{ agent: 'Search, or ask a question — # for context, /agent to choose an agent…' }}
      submitLabel={{ agent: 'Send' }} maxInputHeight="min(10rem, 25dvh)"
      status={error ? { text: error, tone: 'danger', onDismiss: () => setError(''), 'data-testid': 'search-composer-error' } : null}
      draft={draft} commands={commands}
      workflows={workflows.map(({ id, label, description, disabled: off, disabledReason }) => ({ id, label, description, disabled: off, disabledReason }))}
      // A pick puts the row's prompt (not `/<id> `) in the draft: the page sets
      // its input and the controlled draft follows.
      onWorkflow={id => { const row = workflows.find(w => w.id === id); if (row && !row.disabled) onWorkflow?.(row); }}
      documentMenu={{ title: 'Add context', emptyLabel: 'No matching records' }}
      references={references.map(record => ({ id: recordKey(record), label: record.title }))}
      onRemoveReference={key => {
        const editor = editorRef.current?.editor;
        const ranges: Array<{ from: number; to: number }> = [];
        editor?.state.doc.descendants((node, pos) => {
          if (node.type.name === 'docref' && node.attrs.id === key) ranges.push({ from: pos, to: pos + node.nodeSize });
        });
        for (const range of ranges.reverse()) editor?.commands.deleteRange(range);
        onRemoveReference(key);
      }}
      onSearchDocuments={async query => {
        try {
          const fresh = await onSearchContext(query);
          const records = Array.isArray(fresh) ? fresh : contextSuggestions;
          for (const record of records) knownRecords.current.set(recordKey(record), record);
          return records.map(record => ({ id: recordKey(record), label: record.title, hint: SEARCH_LABELS[record.type] }));
        } catch {
          setError('Context search is unavailable. Try again.');
          return [];
        }
      }}
      onDraftChange={next => {
        setDraft(next); setError(''); attachDraftReferences();
        const text = editorRef.current?.editor?.getText() ?? new DOMParser().parseFromString(next.html, 'text/html').body.textContent ?? '';
        lastText.current = text; onChange(text);
      }}
      // The dock hands over what was TYPED (its Agent-mode `/agent ` prefix
      // removed), so `/agent <name> …` here is always the user's own command.
      onSend={async message => {
        const workflow = searchWorkflowIn(message.text, workflows);
        if (workflow?.disabled) { setError(workflow.disabledReason ?? `${workflow.label} does not apply here.`); return false; }
        if (workflow) {
          const rest = message.text.trim().replace(/^\/[\w-]+\s*/, '').trim();
          setError(''); return (await onSubmit(rest ? `${workflow.prompt}\n\n${rest}` : workflow.prompt)) !== false;
        }
        const parsed = parseSearchCommand(message.text, agents, message.command?.argument?.id);
        if (parsed.error) { setError(parsed.error); return false; }
        if (!parsed.text?.trim()) return false;
        for (const doc of message.documents ?? []) {
          const record = knownRecords.current.get(doc.id);
          if (record && !references.some(ref => recordKey(ref) === doc.id)) onAddReference(record);
        }
        const formatted = markdownOf(message.html);
        const text = parsed.prefix ? (formatted.startsWith(parsed.prefix) ? formatted.slice(parsed.prefix.length).trim() : parsed.text) : formatted || parsed.text;
        setError(''); return (await onSubmit(text, parsed.agentId)) !== false;
      }} />
  </Stack>;
}
