import { ComposerSurface } from '@connorhoehn/ui-components/shared';
// The Search composer (goal decision 6): the library `ConversationComposer` —
// the same composer as the initiative pages — in its `document` presentation,
// Agent asks Search; a joined huddle enables Chat on the same central input.
// Workflow ⌄ rows and their `/ commands` are the `searchWorkflows` prompt
// templates; `/agent <name>` picks an agent explicitly, anything else routes to
// the supervisor. `#` attaches records as context. Attachments stay in the
// draft and are not forwarded (as on the initiative composer).
//
// Calls (docs/social-calls-plan.md step 6): with people in the selection
// (`?selection=person:…`, e.g. picked on the connections tab) or attached as
// context, the dock row offers Start call — the initiative composer's
// usePeopleCall, ringing those people's Work sign-ins in the dm lobby of you +
// them. While that call is on, the row is the call shelf; a ring anywhere in
// /iq is answered by the shell's toast (the library's call block host, ShellCallHost).
// Beside it, Message opens a social DM with the one selected person
// (./peopleMessage.tsx — lane E, docs/social-tenant-design.md §4.6).

import { Inline, T } from '@connorhoehn/ui-components/shared';
import type { ComposedMessage, ConversationCommand, RichChatComposerHandle, RichChatDraft } from '@connorhoehn/ui-components/social/rich-composer';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ComposerAdvisories, type ComposerAdvisory } from '../../components/chat/ComposerAdvisories';
import { useHuddleComposerRecipient } from '../../components/shell/HuddleComposerDock';
import { useCallBlock, useCallHost } from '../../lib/conversationCall';
import { peopleFromRecordKeys, searchCallChannel } from '../../lib/conversationCallModel';
import { ConversationComposer } from '../../lib/conversationComposer';
import { usePeopleCall } from '../projects/peopleCall';
import { usePeopleMessage } from './peopleMessage';
import { parseSearchCommand, type SearchAgent } from './searchCommands';
import { recordKey, SEARCH_LABELS, type SearchRecord } from './searchTypes';
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
  /** Names for selected people that no result carries (the people view has no
   *  query): the org graph's roster, used for names only, never as people. */
  knownPeople?: { id: string; name: string }[];
  onAddReference: (record: SearchRecord) => void;
  /** Workflow ⌄ rows and their /commands (searchWorkflows). */
  workflows?: SearchWorkflowRow[];
  onWorkflow?: (row: SearchWorkflowRow) => void;
  /** Draw the Start call / Message row (default). The shell's right pane
   *  passes false: the footer owns calls there (decision 9 amendment). */
  calls?: boolean;
  advisories?: readonly ComposerAdvisory[];
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
export function SearchComposer({ value, onChange, onSubmit, disabled, agents, references, onRemoveReference, onSearchContext, contextSuggestions, knownPeople = [], onAddReference, workflows = [], onWorkflow, calls = true, advisories = [] }: SearchComposerProps) {
  const { chat: huddle, recipient: huddleRecipient } = useHuddleComposerRecipient();
  const host = useCallHost();
  const huddleDock = useCallBlock(huddle?.callId ? host?.lobby?.channel ?? null : null, { compact: true });
  const [mode, setMode] = useState<'agent' | 'chat'>('agent');
  const chatting = mode === 'chat' && !!huddleRecipient;
  const editorRef = useRef<RichChatComposerHandle>(null);
  const [draft, setDraft] = useState<RichChatDraft>(() => draftOf(value));
  const [error, setError] = useState('');
  const lastText = useRef(value);
  const knownRecords = useRef(new Map<string, SearchRecord>());
  for (const record of [...references, ...contextSuggestions]) knownRecords.current.set(recordKey(record), record);
  useEffect(() => {
    if (value !== lastText.current) { lastText.current = value; setDraft(draftOf(value)); setError(''); }
  }, [value]);
  // Every send — a workflow `/<id>`, `/agent <name> …` or plain words — goes through `submit` (the latest props).
  const submitRef = useRef<(message: ComposedMessage) => Promise<boolean>>(async () => false);
  const commands = useMemo<ConversationCommand[]>(() => [{ trigger: '/agent', label: 'Ask a specific agent', description: 'Choose an available agent for this message.',
    argument: { placeholder: 'Choose an agent', search: (query: string) => agents.filter(agent => `${agent.name} ${agent.id}`.toLowerCase().includes(query.toLowerCase())).map(agent => ({ id: agent.id, label: agent.name, hint: agent.id })) },
    run: input => submitRef.current(input.message),
  }, ...searchWorkflowCommands(workflows).map(c => ({ ...c, run: (input: { message: ComposedMessage }) => submitRef.current(input.message) }))], [agents, workflows]);
  const [params, setParams] = useSearchParams();
  const selection = params.get('selection') ?? '';
  const personRefs = references.filter(r => r.type === 'person').map(r => `${r.id}=${r.title}`).join('|');
  // Names for selected people come from the results as well as the attached
  // references (2026-09-29: a person selected on the graph but not attached
  // showed as a raw `p-051` in the Start call tooltip).
  const resultPeople = contextSuggestions.filter(r => r.type === 'person').map(r => `${r.id}=${r.title}`).join('|');
  const rosterPeople = knownPeople.map(p => `${p.id}=${p.name}`).join('|');
  const people = useMemo(() => peopleFromRecordKeys(selection.split(',').filter(Boolean), references,
    [...contextSuggestions, ...knownPeople.map(p => ({ type: 'person', id: p.id, title: p.name }))]),
    [selection, personRefs, resultPeople, rosterPeople]); // keyed on the people, not the array identity
  const named = people.filter(p => p.name !== p.personId).map(p => p.name);
  const call = usePeopleCall({
    bindFooter: !huddle?.callId,
    people,
    channel: searchCallChannel(people.map(p => p.personId)),
    title: named.length ? named.join(', ') : 'Call from Search',
    nobodyReason: 'Nobody selected here has an Work sign-in to call',
    onOpenPeople: () => setParams(prev => { const next = new URLSearchParams(prev); next.set('tab', 'connections'); return next; }),
    startTestId: 'search-start-call',
    dockTestId: 'search-call-dock',
  });
  // Message (lane E, design §4.6): a DM in Social with the one selected
  // person — drawn only for a session holding a social grant.
  const message = usePeopleMessage(people);
  const dock = huddle?.callId ? huddleDock.block : !calls ? null : call.dock ?? (people.length > 0 && (call.startButton || message)
    ? <Inline justify="end" gap="xs" className="px-2 py-1" data-testid="search-call-row">{message}{call.startButton}</Inline>
    : null);
  const attachDraftReferences = () => {
    editorRef.current?.editor?.state.doc.descendants(node => {
      if (node.type.name !== 'docref') return;
      const key = String(node.attrs.id ?? '');
      const record = knownRecords.current.get(key);
      if (record && !references.some(ref => recordKey(ref) === key)) onAddReference(record);
    });
  };
  // The composer hands over what was TYPED (Agent mode's `/agent ` prefix removed only
  // when the router added it), so `/agent <name> …` here is always the user's own command.
  submitRef.current = async message => {
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
  };
  return <ComposerSurface>
    <ConversationComposer channel={null} context={chatting && huddle ? { kind: 'conversation', id: huddle.callId!, title: '',
      reference: huddle.page ? { id: `${huddle.page.kind}:${huddle.page.id}`, label: `${huddle.page.kind === 'work-item' ? 'Work item' : 'Initiative'} context`, page: huddle.page } : null,
    } : { kind: 'search', id: 'search', title: 'Search' }}
      // Agent remains read-only; Chat posts only to the accepted huddle.
      capabilities={{ maySend: !!huddle?.canSend, agent: { allowed: true } }}
      offModes={{ ...(!huddleRecipient ? { chat: 'Join a huddle to chat from Search' } : {}), terminal: 'Search has no terminal' }}
      recipients={huddleRecipient ? [huddleRecipient] : []} recipient={huddleRecipient?.id ?? null} answersFocus
      claim={{ label: 'the Search composer' }}
      mode={chatting ? 'chat' : 'agent'} onModeChange={next => { if (next === 'agent' || next === 'chat') setMode(next); }}
      modeRowStart={chatting ? <Inline gap="xs" wrap={false}><T size="xs" tone="secondary">To:</T><T size="xs" weight="medium">Huddle</T></Inline> : <ComposerAdvisories notices={advisories} />}
      presentation="document" label="Search composer" inputLabel="Search question" data-testid="search-composer" composerTestId="search-rich-composer"
      className={`@container ${chatting ? '' : 'search-composer-advisories'}`}
      composerRef={editorRef} allowEmoji={false} disabled={!chatting && !!disabled} callBlock={dock} defaultMode="agent"
      modePlaceholders={{ agent: 'Search, or ask a question — # for context, /agent to choose an agent…' }}
      submitLabel={{ agent: 'Send' }} maxInputHeight="min(10rem, 25dvh)"
      status={error ? { text: error, tone: 'danger', onDismiss: () => setError(''), 'data-testid': 'search-composer-error' } : null}
      draft={chatting ? huddle!.draft : draft} persistDraft={false} commands={commands.map(command => ({ ...command, modes: ['agent'] }))}
      onAgent={(_text, input) => submitRef.current(input.message)}
      workflows={workflows.map(({ id, label, description, disabled: off, disabledReason }) => ({ id, label, description, disabled: off, disabledReason }))}
      // A pick puts the row's prompt (not `/<id> `) in the draft: the page sets
      // its input and the controlled draft follows.
      onWorkflow={id => { const row = workflows.find(w => w.id === id); if (row && !row.disabled) onWorkflow?.(row); }}
      documentMenu={{ title: 'Add context', emptyLabel: 'No matching records' }}
      references={chatting ? [] : references.map(record => ({ id: recordKey(record), label: record.title }))}
      onRemoveReference={key => {
        if (chatting) { huddle?.setPage(null); return; }
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
        if (chatting) { huddle?.setDraft(next); return; }
        setDraft(next); setError(''); attachDraftReferences();
        const text = editorRef.current?.editor?.getText() ?? new DOMParser().parseFromString(next.html, 'text/html').body.textContent ?? '';
        lastText.current = text; onChange(text);
      }}
    />
  </ComposerSurface>;
}
