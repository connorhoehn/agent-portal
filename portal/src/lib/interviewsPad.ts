// The interview's shared code pad on the portal side (docs/interviews-tenant-plan.md, decision 11, row I4.2,
// "I0.7 answer"): the pad's names on the wire, the shared language, the block "Insert a question" adds, the
// caret colour per person and the connection state the pad shows. Pure, apart from the two functions that read
// and write the shared language on a Y.Doc. The component is pages/interviews/pad/InterviewPad.tsx.
//
// The names mirror middleware/src/lib/interviews/pad/channel.ts (the server's), and a unit test pins them by
// value: document `ivpad:<interviewId>` on channel `doc:ivpad:<interviewId>`, text `code`, and the pad's own
// map `pad` whose `language` key every pad on that document follows.
import type * as Y from 'yjs';
import { PAD_LANGUAGES, type PadLanguage } from './interviewsKit.ts';

export const PAD_DOCUMENT_PREFIX = 'ivpad:';
export const PAD_TEXT_NAME = 'code';
export const PAD_META_NAME = 'pad';
export const PAD_LANGUAGE_KEY = 'language';
/** The language a new pad starts in, before anyone picks one. */
export const PAD_DEFAULT_LANGUAGE: PadLanguage = 'python';
const INTERVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** The pad's document id (what `useYjsDoc({ documentId })` takes), or null for an id that cannot name one. */
export function padDocumentId(interviewId: string): string | null {
  return INTERVIEW_ID.test(interviewId) ? `${PAD_DOCUMENT_PREFIX}${interviewId}` : null;
}

/** The channel the gateway carries the pad on, `doc:ivpad:<interviewId>`, or null. */
export function padChannel(interviewId: string): string | null {
  const id = padDocumentId(interviewId);
  return id ? `doc:${id}` : null;
}

/** The language guard: one of the seven the kit and the editor share. */
export function isPadLanguage(value: unknown): value is PadLanguage {
  return typeof value === 'string' && (PAD_LANGUAGES as readonly string[]).includes(value);
}

/** The shared language as a pad should show it: what the document says, or the default when it says nothing usable. */
export function padLanguageOf(value: unknown): PadLanguage {
  return isPadLanguage(value) ? value : PAD_DEFAULT_LANGUAGE;
}

/** The document's language now. */
export function readSharedLanguage(ydoc: Y.Doc): PadLanguage {
  return padLanguageOf(ydoc.getMap(PAD_META_NAME).get(PAD_LANGUAGE_KEY));
}

/** Change the language for everyone on the document. Returns whether anything changed. */
export function writeSharedLanguage(ydoc: Y.Doc, language: PadLanguage): boolean {
  const map = ydoc.getMap(PAD_META_NAME);
  if (map.get(PAD_LANGUAGE_KEY) === language) return false;
  map.set(PAD_LANGUAGE_KEY, language);
  return true;
}

/** How a line comment starts in each language. */
export const PAD_LINE_COMMENT: Readonly<Record<PadLanguage, string>> = {
  python: '#', swift: '//', javascript: '//', typescript: '//', java: '//', go: '//', cpp: '//',
};

/** How wide an inserted comment line may be, marker included: it reads in the room's pane without scrolling sideways. */
export const PAD_COMMENT_WIDTH = 60;

/** One line of prose broken at spaces so each piece fits `width` (a word longer than that stays whole). */
function wrapWords(line: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of line.trim().split(/\s+/)) {
    if (cur && cur.length + 1 + word.length > width) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

/** The prompt as a comment block: every line commented and wrapped to `width`, blank lines kept as a bare comment marker. */
export function commentBlock(prompt: string, language: PadLanguage, width = PAD_COMMENT_WIDTH): string {
  const mark = PAD_LINE_COMMENT[language];
  const room = Math.max(16, width - mark.length - 1);
  return prompt.replace(/\r\n?/g, '\n').trim().split('\n')
    .flatMap((line) => (line.trim() ? wrapWords(line, room).map((piece) => `${mark} ${piece}`) : [mark])).join('\n');
}

/** A question as the pad takes it (U2's `PadQuestion`; the room's `RoomQuestion` fits it as it is). */
export interface PadQuestion { id: string; prompt: string; starter: ReadonlyArray<{ language: string; code: string }> }

/** What inserting a question does: the text to add at the end, and the language the pad is in afterwards. */
export interface QuestionInsertion { text: string; language: PadLanguage; switched: boolean }

/**
 * Decision 11's insert. The prompt as a comment in the pad's current language, then that language's starter
 * code; when the question has none in it, the first language it has (and the pad switches to that). It goes
 * at the end of what is there, on its own lines after a blank line, and never replaces anything.
 */
export function questionInsertion(q: PadQuestion, current: PadLanguage, existing: string): QuestionInsertion {
  const starters = q.starter.filter((s): s is { language: PadLanguage; code: string } => isPadLanguage(s.language));
  const starter = starters.find((s) => s.language === current) ?? starters[0] ?? null;
  const language = starter?.language ?? current;
  const code = starter?.code.replace(/\r\n?/g, '\n').replace(/\s+$/, '') ?? '';
  const block = `${commentBlock(q.prompt, language)}\n${code ? `${code}\n` : ''}`;
  const lead = existing === '' ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${lead}${block}`, language, switched: language !== current };
}

/**
 * Insert a question into a shared pad: switch the shared language if the insertion needs it, then add the
 * block at the end as one edit through `insert` (the editor's handle, so it is reported as this person's
 * insert); with no editor mounted, straight into the shared text. Returns what was inserted.
 */
export function applyQuestion(ydoc: Y.Doc, q: PadQuestion, insert?: ((text: string) => void) | null): QuestionInsertion {
  const text = ydoc.getText(PAD_TEXT_NAME);
  const plan = questionInsertion(q, readSharedLanguage(ydoc), text.toString());
  if (plan.switched) writeSharedLanguage(ydoc, plan.language);
  if (insert) insert(plan.text);
  else text.insert(text.length, plan.text);
  return plan;
}

/** Caret colours: distinct at a glance on light and dark editors. */
export const PAD_CARET_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#65a30d'] as const;

/** A stable caret colour per person: the same person is the same colour on every pad and every reload. */
export function caretColor(personId: string): string {
  let h = 2166136261;
  for (let i = 0; i < personId.length; i++) h = Math.imul(h ^ personId.charCodeAt(i), 16777619);
  return PAD_CARET_COLORS[(h >>> 0) % PAD_CARET_COLORS.length]!;
}

/** The name on a person's caret: the candidate is always "Candidate". */
export function caretName(seat: 'lead' | 'panel' | 'candidate', displayName: string): string {
  return seat === 'candidate' ? 'Candidate' : displayName.trim() || 'Interviewer';
}

/** What the pad shows about its connection. */
export type PadConnection = 'offline' | 'refused' | 'connecting' | 'synced' | 'down';

/** The pad's state from the socket and the document. A refusal wins; with no gateway configured nothing else applies. */
export function padConnection(f: { configured: boolean; connectionState: string; synced: boolean; refused: boolean }): PadConnection {
  if (!f.configured) return 'offline';
  if (f.refused) return 'refused';
  if (f.connectionState === 'reconnecting' || f.connectionState === 'disconnected') return f.synced ? 'down' : 'connecting';
  return f.synced ? 'synced' : 'connecting';
}

/** Is this gateway frame the pad's channel being refused (a subscribe, an edit or a caret)? */
export function isPadRefusal(frame: unknown, channel: string): boolean {
  if (!frame || typeof frame !== 'object') return false;
  const f = frame as { type?: unknown; channel?: unknown; service?: unknown };
  if (f.type !== 'error' && f.type !== 'crdt:error') return false;
  return f.channel === channel || (f.channel === undefined && f.service === 'crdt');
}

/** Is this frame the pad's document arriving (its snapshot)? A refusal is lifted by it. */
export function isPadSnapshot(frame: unknown, channel: string): boolean {
  if (!frame || typeof frame !== 'object') return false;
  const f = frame as { type?: unknown; channel?: unknown };
  return f.type === 'crdt:snapshot' && f.channel === channel;
}

/** A menu label for a question: its first line, shortened. */
export function questionLabel(q: Pick<PadQuestion, 'prompt'>, max = 64): string {
  const first = q.prompt.trim().split('\n')[0]!.trim();
  return first.length <= max ? first : `${first.slice(0, max - 1).trimEnd()}…`;
}
