import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { patchSharedComposer } from '../../../patches/sharedComposer.ts';

const dist = new URL('../../../node_modules/@connorhoehnslalom/ui-components/dist/', import.meta.url);
const filename = readdirSync(dist).find(name => /^RichChatComposer-.*\.js$/.test(name))!;
const source = readFileSync(new URL(filename, dist), 'utf8');
const patched = patchSharedComposer(source, `/@connorhoehnslalom/ui-components/dist/${filename}`)!;
const start = patched.indexOf('function wa(');
const end = patched.indexOf('\nvar Ta = ', start);
const hiddenPrefix = runInNewContext(`(${patched.slice(start, end)})`, {
  le: (text: string, commands: { trigger: string }[]) => commands.find(command => text.trimStart().startsWith(`${command.trigger} `)),
});
const doc = (text: string, following?: string) => {
  const block = (value: string) => ({ isTextblock: true, content: { size: value.length }, nodeSize: value.length + 2, textBetween: () => value });
  return { firstChild: block(text), childCount: following === undefined ? 1 : 2, child: () => block(following!) };
};

test('a command chip hides its prefix in full composers without changing the submitted text', () => {
  const text = '/comment Review the dependency map.';
  const document = doc(text);
  const range = hiddenPrefix(document, [{ trigger: '/comment' }], null, false);
  assert.equal(text.slice(range.to - 1), 'Review the dependency map.');
  assert.equal(document.firstChild.textBetween(), text);
});

test('selected arguments and multiline command prefixes retain their caret boundary', () => {
  const text = '/workflow Draft criteria acceptance test';
  const range = hiddenPrefix(doc(text), [{ trigger: '/workflow' }], { trigger: '/workflow', item: { label: 'Draft criteria' } }, false);
  assert.equal(text.slice(range.to - 1), 'acceptance test');
  const multiline = hiddenPrefix(doc('/comment ', 'The next paragraph'), [{ trigger: '/comment' }], null, false);
  assert.equal(multiline.kind, 'block');
  assert.equal(multiline.caret, doc('/comment ').firstChild.nodeSize + 1);
});

test('ordinary text and unknown commands remain visible; changed library builds require review', () => {
  assert.equal(hiddenPrefix(doc('Review this /comment'), [{ trigger: '/comment' }], null, false), null);
  assert.equal(hiddenPrefix(doc('/unknown Review'), [{ trigger: '/comment' }], null, false), null);
  assert.throws(() => patchSharedComposer('new library format', `/@connorhoehnslalom/ui-components/dist/${filename}`), /needs review/);
});

test('suggestions stay above the composer when the hidden trigger has no bounds', () => {
  const menuStart = patched.indexOf('function ga() {');
  const menuEnd = patched.indexOf('\nfunction _a(', menuStart);
  const mountMenu = runInNewContext(`(${patched.slice(menuStart, menuEnd)})`, {
    document: { body: { appendChild() {} } },
    window: { innerWidth: 1440, innerHeight: 900, scrollX: 0, scrollY: 0 },
    cancelAnimationFrame() {}, requestAnimationFrame: () => 1,
  });
  const style: Record<string, string> = {};
  const host = { style, offsetWidth: 320, remove() {} };
  const boundary = { closest: () => null, getBoundingClientRect: () => ({ left: 100, right: 950, top: 740, bottom: 780, width: 850, height: 40 }) };
  const menu = mountMenu();
  menu.attach(host);
  menu.place({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }, boundary);
  assert.equal(style.left, '100px');
  assert.equal(style.top, '734px');
  assert.equal(style.transform, 'translateY(-100%)');
  menu.place({ left: 500, right: 500, top: 750, bottom: 770, width: 0, height: 20 }, boundary);
  assert.equal(style.left, '500px');
  assert.equal(style.top, '744px');
});
