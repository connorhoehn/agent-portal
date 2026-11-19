// The interview's shared code pad (docs/interviews-tenant-plan.md decision 11, row I4.2; contract U2).
//
// One Yjs document per technical interview, `ivpad:<interviewId>`, carried by the BFF's own gateway on the
// socket that is already mounted: the shell's for the panel, GuestCallHost's for the candidate. It opens no
// socket of its own, draws no run button and posts to no route: the run controls (`toolbarEnd`), the output
// (`below`) and the pad log (the four callbacks) belong to whoever mounts it.
//
// Inside: the library's CodePad bound to `ydoc.getText('code')` with the provider's awareness (a named caret
// per person, one colour each), and above it one compact row: the language, shared through
// `ydoc.getMap('pad').get('language')` so a change reaches everyone and their highlighter, and the lead's
// "Insert a question" menu (decision 11), which adds the prompt as a comment and the starter code at the end
// as one edit and never clears anything.
import { useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { GatewayContext, useYjsDoc, type GatewayContextValue } from '@connorhoehn/realtime-modules/client';
import { CodePad, type CodePadEdit, type CodePadHandle, type CodePadPaste } from '@connorhoehn/ui-components/code-pad';
import { Chip, DropdownMenu, InlineAlert, Select, Stack, Toolbar } from '@connorhoehn/ui-components/shared';
import { offlineGateway } from '../../../components/OptionalGatewayProvider';
import { PAD_LANGUAGES, PAD_LANGUAGE_LABELS, type PadLanguage } from '../../../lib/interviewsKit';
import {
  PAD_DEFAULT_LANGUAGE, PAD_META_NAME, PAD_TEXT_NAME, applyQuestion, caretColor, caretName, isPadLanguage, isPadRefusal, isPadSnapshot,
  padChannel, padConnection, padDocumentId, readSharedLanguage, writeSharedLanguage, questionLabel, type PadConnection, type PadQuestion,
} from '../../../lib/interviewsPad';

export type { PadQuestion } from '../../../lib/interviewsPad';
import { onPadQuestion, takePadQuestion } from '../../../lib/interviewsRoom';
export type PadSeat = 'lead' | 'panel' | 'candidate';
export interface InterviewPadHandle { getText(): string; getLanguage(): string; insertQuestion(q: PadQuestion): void; focus(): void }
export interface InterviewPadProps {
  interviewId: string;
  self: { userId: string; displayName: string };
  seat: PadSeat;
  /** The lead's "Insert a question" menu; omitted for everyone else. */
  questions?: readonly PadQuestion[];
  /** Run, Cancel, the run's status (the mounting page's). */
  toolbarEnd?: ReactNode;
  /** The run output, under the editor (the mounting page's). */
  below?: ReactNode;
  onPaste?(p: CodePadPaste): void;
  onLocalEdit?(e: CodePadEdit): void;
  onLanguageChange?(language: string): void;
  onInsert?(q: PadQuestion): void;
  ref?: Ref<InterviewPadHandle>;
}

const LANGUAGE_OPTIONS = PAD_LANGUAGES.map((l) => ({ value: l, label: PAD_LANGUAGE_LABELS[l] }));

const NOTICES: Readonly<Partial<Record<PadConnection, { tone: 'info' | 'warning' | 'error'; text: string }>>> = {
  offline: { tone: 'info', text: 'The shared code pad needs the live connection, and it is not set up here.' },
  refused: { tone: 'error', text: 'This code pad is not open to you.' },
  down: { tone: 'warning', text: 'The connection dropped. The code stays here and catches up when it is back.' },
};

export function InterviewPad(props: InterviewPadProps) {
  const gateway = useContext(GatewayContext);
  const documentId = padDocumentId(props.interviewId);
  if (!gateway || gateway === offlineGateway || !documentId) return <PadUnavailable {...props} connection={documentId ? 'offline' : 'refused'} />;
  return <SharedPad {...props} gateway={gateway} documentId={documentId} channel={padChannel(props.interviewId)!} />;
}

/** No gateway (or no pad by that name): the notice, the slots, and a handle that answers. */
function PadUnavailable({ ref, toolbarEnd, below, connection }: InterviewPadProps & { connection: PadConnection }) {
  useImperativeHandle(ref, () => ({ getText: () => '', getLanguage: () => PAD_DEFAULT_LANGUAGE, insertQuestion: () => {}, focus: () => {} }), []);
  return <PadFrame connection={connection} toolbar={toolbarEnd ? <Toolbar size="sm" end={toolbarEnd} className="px-4" /> : null} below={below} />;
}

function SharedPad({ interviewId, self, seat, questions, toolbarEnd, below, onPaste, onLocalEdit, onLanguageChange, onInsert, ref, gateway, documentId, channel }:
  InterviewPadProps & { gateway: GatewayContextValue; documentId: string; channel: string }) {
  const doc = useYjsDoc({ documentId, ws: gateway, onMessage: gateway.onMessage });
  const { ydoc, provider, synced } = doc;
  const editor = useRef<CodePadHandle | null>(null);

  // A refusal (subscribe, edit or caret) holds until the pad's document arrives again.
  const [refused, setRefused] = useState(false);
  useEffect(() => gateway.onMessage((msg) => {
    if (isPadRefusal(msg, channel)) setRefused(true);
    else if (isPadSnapshot(msg, channel)) setRefused(false);
  }), [gateway, channel]);
  const connection = padConnection({ configured: true, connectionState: String(gateway.connectionState), synced, refused });

  // The shared language: what the document says, followed live.
  const [language, setLanguage] = useState<PadLanguage>(PAD_DEFAULT_LANGUAGE);
  useEffect(() => {
    if (!ydoc) return;
    const map = ydoc.getMap(PAD_META_NAME);
    const read = () => setLanguage(readSharedLanguage(ydoc));
    read();
    map.observe(read);
    return () => map.unobserve(read);
  }, [ydoc]);

  // This person's caret: their name (the candidate's is "Candidate") and one colour each.
  const user = useMemo(() => ({ name: caretName(seat, self.displayName), color: caretColor(self.userId) }), [seat, self.displayName, self.userId]);

  const chooseLanguage = useCallback((next: string) => {
    if (!ydoc || !isPadLanguage(next)) return;
    if (writeSharedLanguage(ydoc, next)) onLanguageChange?.(next);
  }, [ydoc, onLanguageChange]);

  const insertQuestion = useCallback((q: PadQuestion) => {
    if (!ydoc) return;
    const pad = editor.current;
    const plan = applyQuestion(ydoc, q, pad ? (text) => pad.insertText(text, 'end') : null);
    if (plan.switched) onLanguageChange?.(plan.language);
    onInsert?.(q);
  }, [ydoc, onInsert, onLanguageChange]);

  // Row I3.5 (lane SPEAK): a kit question "Have Milo ask" queued from the Questions tab goes in once the lead's pad is in sync.
  useEffect(() => { if (seat !== 'lead' || connection !== 'synced') return undefined; const take = () => { const q = takePadQuestion(interviewId); if (q) insertQuestion(q); }; take(); return onPadQuestion(take); }, [seat, connection, interviewId, insertQuestion]);

  useImperativeHandle(ref, () => ({
    getText: () => editor.current?.getText() ?? ydoc?.getText(PAD_TEXT_NAME).toString() ?? '',
    getLanguage: () => language,
    insertQuestion,
    focus: () => editor.current?.focus(),
  }), [ydoc, language, insertQuestion]);

  const ready = !!ydoc && connection !== 'refused';
  const editable = connection === 'synced';
  const lead = seat === 'lead' && !!questions?.length;
  // The board's row pattern: the actions on the left, the connection chip right-aligned ahead of the run controls.
  const status = connection === 'connecting' ? <Chip size="sm" tone="neutral" data-testid="interview-pad-status">Connecting…</Chip>
    : connection === 'synced' ? <Chip size="sm" tone="success" data-testid="interview-pad-status">In sync</Chip> : null;
  const end = status || toolbarEnd ? <>{status}{toolbarEnd}</> : undefined;
  const toolbar = <Toolbar size="sm" aria-label="Code pad" end={end} className="px-4" data-testid="interview-pad-toolbar">
    <Select size="sm" value={language} options={LANGUAGE_OPTIONS} aria-label="Language" disabled={!editable} wrapperClassName="w-28 shrink-0"
      onChange={(e) => chooseLanguage(e.target.value)} data-testid="interview-pad-language" />
    {lead && <DropdownMenu trigger="Insert a question" triggerLabel="Insert a question" triggerVariant="default" triggerClassName="whitespace-nowrap" disabled={!editable}
      triggerTestId="interview-pad-insert" sections={[{ scroll: true, items: questions!.map((q, n) => ({
        id: q.id, label: `Question ${n + 1}`, description: questionLabel(q), onSelect: () => insertQuestion(q),
      })) }]} />}
  </Toolbar>;

  return <PadFrame connection={connection} toolbar={toolbar} below={below}
    editor={ready ? <CodePad key={documentId} ref={editor} ydoc={ydoc!} textName={PAD_TEXT_NAME} provider={provider} user={user}
      language={language} variant="flush" readOnly={!editable} aria-label="Shared code" className="h-full min-h-0"
      placeholder={seat === 'candidate' ? 'Write your code here. The interviewer sees it as you type.' : 'The candidate’s code appears here as they type.'}
      onPaste={onPaste} onLocalEdit={onLocalEdit} /> : null} />;
}

/** The pad's column: the row, a notice when there is one, the editor taking the rest, then `below`. */
function PadFrame({ connection, toolbar, editor, below }: { connection: PadConnection; toolbar: ReactNode; editor?: ReactNode; below?: ReactNode }) {
  const notice = NOTICES[connection];
  return <Stack gap="none" className="h-full min-h-0 min-w-0 flex-1" data-testid="interview-pad" data-connection={connection}>
    {toolbar}
    {notice && <InlineAlert tone={notice.tone} data-testid="interview-pad-notice">{notice.text}</InlineAlert>}
    {editor && <Stack gap="none" className="min-h-0 flex-1 overflow-hidden">{editor}</Stack>}
    {below}
  </Stack>;
}
