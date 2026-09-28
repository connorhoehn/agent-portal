import { useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from '@connorhoehnslalom/ui-components/shared';
import { RichChatComposer, type RichChatComposerHandle, type RichChatDraft } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { recordKey, SEARCH_LABELS, type SearchRecord } from './searchTypes';
import { parseSearchCommand, type SearchAgent } from './searchCommands';

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
export function SearchComposer({ value, onChange, onSubmit, disabled, agents, references, onRemoveReference, onSearchContext, contextSuggestions, onAddReference }: SearchComposerProps) {
  const editorRef = useRef<RichChatComposerHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<RichChatDraft>(() => draftOf(value));
  const [error, setError] = useState('');
  const lastText = useRef(value);
  const knownRecords = useRef(new Map<string, SearchRecord>());
  for (const record of [...references, ...contextSuggestions]) knownRecords.current.set(recordKey(record), record);
  useEffect(() => {
    if (value !== lastText.current) { lastText.current = value; setDraft(draftOf(value)); setError(''); }
  }, [value]);
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const labelEditor = () => {
      const editor = root.querySelector('[contenteditable]');
      editor?.setAttribute('aria-label', 'Search question');
      editor?.setAttribute('role', 'textbox');
      editor?.setAttribute('aria-multiline', 'true');
    };
    labelEditor();
    const observer = new MutationObserver(labelEditor);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  const commands = useMemo(() => [{ trigger: '/agent', label: 'Ask a specific agent', description: 'Choose an available agent for this message.',
    argument: { placeholder: 'Choose an agent', search: (query: string) => agents.filter(agent => `${agent.name} ${agent.id}`.toLowerCase().includes(query.toLowerCase())).map(agent => ({ id: agent.id, label: agent.name, hint: agent.id })) },
  }], [agents]);
  const attachDraftReferences = () => {
    editorRef.current?.editor?.state.doc.descendants(node => {
      if (node.type.name !== 'docref') return;
      const key = String(node.attrs.id ?? '');
      const record = knownRecords.current.get(key);
      if (record && !references.some(ref => recordKey(ref) === key)) onAddReference(record);
    });
  };
  return <div ref={containerRef} data-testid="search-composer" className="search-composer shrink-0 border-t border-border bg-surface px-4 py-3">
    {error && <Banner variant="error" className="mb-2">{error}</Banner>}
    <RichChatComposer ref={editorRef} data-testid="search-rich-composer" fixedMode="agent" modeControl="menu" hideModeMenu
      backdropTone="none" layout="auto" toolbar="editor" density="compact" allowAttachments={false} allowEmoji={false}
      disabled={disabled} draft={draft} commands={commands} submitLabel={{ agent: 'Send' }}
      modePlaceholders={{ agent: 'Ask a question, use # for context, or /agent to choose an agent…' }}
      maxInputHeight="min(10rem, 25dvh)" documentMenu={{ title: 'Add context', emptyLabel: 'No matching records' }}
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
      onSend={async message => {
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
  </div>;
}
