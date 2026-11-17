// The code pad's helpers (lib/interviewsPad.ts; docs/interviews-tenant-plan.md decision 11, row I4.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  PAD_CARET_COLORS, PAD_DOCUMENT_PREFIX, PAD_LANGUAGE_KEY, PAD_META_NAME, PAD_TEXT_NAME, applyQuestion, caretColor, caretName, commentBlock,
  isPadLanguage, isPadRefusal, isPadSnapshot, padChannel, padConnection, padDocumentId, padLanguageOf, questionInsertion, questionLabel,
  readSharedLanguage, writeSharedLanguage, type PadQuestion,
} from '../interviewsPad.ts';
import * as server from '../../../../middleware/src/lib/interviews/pad/channel.ts';

test('the names match the server\'s, by value', () => {
  assert.equal(PAD_DOCUMENT_PREFIX, server.PAD_DOCUMENT_PREFIX);
  assert.equal(PAD_DOCUMENT_PREFIX, 'ivpad:');
  for (const id of ['iv-k1p5w8ra', '0f8fad5b-d9cb-469f-a165-70867728950e', 'x'.repeat(40), 'x'.repeat(41), '', '-lead', 'a:b', 'a b']) {
    assert.equal(padDocumentId(id), server.padDocumentId(id), id);
    assert.equal(padChannel(id), server.padChannel(id), id);
  }
  assert.equal(padChannel('iv-k1p5w8ra'), 'doc:ivpad:iv-k1p5w8ra');
  // The proof's text name and the pad's map (pad-proof.test.ts reads `doc.getText('code')`).
  assert.equal(PAD_TEXT_NAME, 'code');
  assert.equal(PAD_META_NAME, 'pad');
  assert.equal(PAD_LANGUAGE_KEY, 'language');
});

test('the language guard takes the seven and nothing else', () => {
  for (const l of ['python', 'swift', 'javascript', 'typescript', 'java', 'go', 'cpp']) assert.equal(isPadLanguage(l), true, l);
  for (const l of ['rust', 'Python', '', null, 3, undefined]) assert.equal(isPadLanguage(l), false, String(l));
  assert.equal(padLanguageOf('go'), 'go');
  assert.equal(padLanguageOf('cobol'), 'python');
  assert.equal(padLanguageOf(undefined), 'python');
});

test('a prompt becomes a comment block in the language\'s comment syntax', () => {
  assert.equal(commentBlock('Reverse a list.\n\nKeep it O(n).  ', 'python'), '# Reverse a list.\n#\n# Keep it O(n).');
  assert.equal(commentBlock('Reverse a list.', 'go'), '// Reverse a list.');
  assert.equal(commentBlock('A\r\nB', 'cpp'), '// A\n// B');
});

const Q: PadQuestion = { id: 'q1', prompt: 'Merge two sorted lists.', starter: [
  { language: 'go', code: 'func merge(a, b []int) []int {\n}\n\n' },
  { language: 'python', code: 'def merge(a, b):\n    pass' },
] };

test('the insert uses the current language\'s starter, after what is there, and never replaces it', () => {
  assert.deepEqual(questionInsertion(Q, 'python', ''), { text: '# Merge two sorted lists.\ndef merge(a, b):\n    pass\n', language: 'python', switched: false });
  assert.equal(questionInsertion(Q, 'python', 'x = 1').text.startsWith('\n\n# Merge'), true);
  assert.equal(questionInsertion(Q, 'python', 'x = 1\n').text.startsWith('\n# Merge'), true);
  assert.equal(questionInsertion(Q, 'python', 'x = 1\n\n').text.startsWith('# Merge'), true);
});

test('with no starter in the current language it switches to the question\'s first, and with none at all it stays', () => {
  assert.deepEqual(questionInsertion(Q, 'java', ''), { text: '// Merge two sorted lists.\nfunc merge(a, b []int) []int {\n}\n', language: 'go', switched: true });
  assert.deepEqual(questionInsertion({ id: 'q2', prompt: 'Talk it through.', starter: [] }, 'swift', ''), { text: '// Talk it through.\n', language: 'swift', switched: false });
  // A starter in a language the pad does not have is skipped.
  assert.equal(questionInsertion({ id: 'q3', prompt: 'P', starter: [{ language: 'rust', code: 'fn main() {}' }] }, 'python', '').language, 'python');
});

test('caret colours are stable per person and from the palette; the candidate\'s caret says Candidate', () => {
  assert.equal(caretColor('u-hugo'), caretColor('u-hugo'));
  assert.ok((PAD_CARET_COLORS as readonly string[]).includes(caretColor('guest:inv-1')));
  const spread = new Set(['u-hugo', 'u-wen', 'u-greta', 'u-amara', 'u-theo', 'guest:a', 'guest:b', 'guest:c'].map(caretColor));
  assert.ok(spread.size >= 4, 'people spread over the palette');
  assert.equal(caretName('candidate', 'Ana Ruiz'), 'Candidate');
  assert.equal(caretName('lead', 'Hugo'), 'Hugo');
  assert.equal(caretName('panel', '  '), 'Interviewer');
});

test('the pad\'s connection state', () => {
  const base = { configured: true, connectionState: 'connected', synced: false, refused: false };
  assert.equal(padConnection({ ...base, configured: false, refused: true }), 'offline');
  assert.equal(padConnection({ ...base, refused: true, synced: true }), 'refused');
  assert.equal(padConnection(base), 'connecting');
  assert.equal(padConnection({ ...base, synced: true }), 'synced');
  assert.equal(padConnection({ ...base, synced: true, connectionState: 'reconnecting' }), 'down');
  assert.equal(padConnection({ ...base, connectionState: 'disconnected' }), 'connecting');
});

test('a refusal is an error frame on the pad\'s channel (or the CRDT service\'s with no channel)', () => {
  const ch = 'doc:ivpad:iv-1';
  assert.equal(isPadRefusal({ type: 'error', channel: ch, code: 'FORBIDDEN' }, ch), true);
  assert.equal(isPadRefusal({ type: 'error', service: 'crdt', message: 'Document operation denied' }, ch), true);
  assert.equal(isPadRefusal({ type: 'error', channel: 'orgiq:huddle:x' }, ch), false);
  assert.equal(isPadRefusal({ type: 'error', service: 'chat' }, ch), false);
  assert.equal(isPadRefusal({ type: 'crdt:snapshot', channel: ch }, ch), false);
  assert.equal(isPadSnapshot({ type: 'crdt:snapshot', channel: ch }, ch), true);
  assert.equal(isPadSnapshot({ type: 'crdt:snapshot', channel: 'doc:ivpad:other' }, ch), false);
});

test('menu labels are the prompt\'s first line, shortened', () => {
  assert.equal(questionLabel({ prompt: 'Short one\nmore' }), 'Short one');
  assert.equal(questionLabel({ prompt: 'x'.repeat(100) }, 10), `${'x'.repeat(9)}…`);
});

/** Two pads on one document: every update one makes reaches the other, as the gateway relays them. */
function twoPads(): [Y.Doc, Y.Doc] {
  const a = new Y.Doc(), b = new Y.Doc();
  a.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'relay') Y.applyUpdate(b, u, 'relay'); });
  b.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'relay') Y.applyUpdate(a, u, 'relay'); });
  return [a, b];
}

test('two pads share the text, the language follows, and Insert a question adds one block at the end', () => {
  const [lead, candidate] = twoPads();
  candidate.getText(PAD_TEXT_NAME).insert(0, 'print("hi")\n');
  assert.equal(lead.getText(PAD_TEXT_NAME).toString(), 'print("hi")\n');

  assert.equal(readSharedLanguage(candidate), 'python');
  assert.equal(writeSharedLanguage(lead, 'go'), true);
  assert.equal(writeSharedLanguage(lead, 'go'), false, 'no change, no write');
  assert.equal(readSharedLanguage(candidate), 'go');

  // The lead inserts through the editor's handle: one call, one edit.
  const calls: string[] = [];
  const plan = applyQuestion(lead, Q, (text) => { calls.push(text); const t = lead.getText(PAD_TEXT_NAME); t.insert(t.length, text); });
  assert.equal(calls.length, 1);
  assert.equal(plan.language, 'go');
  assert.equal(candidate.getText(PAD_TEXT_NAME).toString(), 'print("hi")\n\n// Merge two sorted lists.\nfunc merge(a, b []int) []int {\n}\n');

  // A question with no starter in the pad's language switches everyone to its first one.
  writeSharedLanguage(candidate, 'java');
  const second = applyQuestion(lead, { id: 'q9', prompt: 'Now in Python.', starter: [{ language: 'python', code: 'pass' }] });
  assert.equal(second.switched, true);
  assert.equal(readSharedLanguage(candidate), 'python');
  assert.ok(candidate.getText(PAD_TEXT_NAME).toString().endsWith('}\n\n# Now in Python.\npass\n'));
  assert.ok(candidate.getText(PAD_TEXT_NAME).toString().startsWith('print("hi")\n'), 'nothing was cleared');
});
