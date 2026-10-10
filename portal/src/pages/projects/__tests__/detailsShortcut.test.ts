import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDetailsShortcut } from '../detailsShortcut.ts';
const event = (patch = {}) => ({ key: 'I', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false,
  repeat: false, isComposing: false, defaultPrevented: false, target: null, ...patch });

test('opens with Shift+I outside editing, without consuming other keys or browser shortcuts', () => {
  assert.equal(isDetailsShortcut(event()), true);
  assert.equal(isDetailsShortcut(event({ key: 'i' })), true);
  for (const patch of [{ shiftKey: false }, { key: '1' }, { key: 'J' }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
    { repeat: true }, { isComposing: true }, { defaultPrevented: true }]) assert.equal(isDetailsShortcut(event(patch)), false);
});

test('typing in form fields, rich text and textbox widgets retains Shift+I', () => {
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'textarea' }, { tagName: 'SELECT' }, { isContentEditable: true },
    { tagName: 'SPAN', closest: () => ({}) }]) {
    assert.equal(isDetailsShortcut(event({ target }) as unknown as KeyboardEvent), false);
  }
  assert.equal(isDetailsShortcut(event({ target: { tagName: 'BUTTON', closest: () => null } }) as unknown as KeyboardEvent), true);
});

test('an editable composed path prevents a global shortcut across a shadow boundary', () => {
  assert.equal(isDetailsShortcut({ ...event(), composedPath: () => [{ tagName: 'DIV' }, { tagName: 'INPUT' }] } as unknown as KeyboardEvent), false);
});
