// Run with:  cd portal && node --test 'src/pages/settings/__tests__/*.test.ts'
//
// Settings › Voice (G38): how the voice catalogue is shaped for the Select,
// what each row says, and when the section is hidden.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  voiceSelect, voiceDescription, putVoiceValue, styleOptions, paceOptions, saveStatusText, putErrorMessage, sectionVisible,
  DEFAULT_VOICE_VALUE, VOICE_NOTE, type VoiceSettingsBody,
} from '../voiceSettingsModel.ts';

const body = (over: Partial<VoiceSettingsBody> = {}): VoiceSettingsBody => ({
  voice: null, style: 'plain', pace: 'normal',
  options: {
    voices: [
      { value: 'vesper', name: 'vesper', label: 'Vesper', language: 'English', region: 'British', presentation: 'masculine' },
      { value: 'willow', name: 'willow', label: 'Willow', language: 'English', region: 'Irish', presentation: 'feminine' },
      { value: 'bossa', name: 'bossa', label: 'Bossa', language: 'Portuguese', region: 'Brazilian', presentation: 'feminine' },
      { value: 'nuri', name: 'nuri', label: 'Nuri', language: 'German', region: null, presentation: 'feminine' },
      { value: 'marin', name: 'marin', label: 'Marin', language: 'English', region: null, presentation: null, bestQuality: true },
      { value: 'cedar', name: 'cedar', label: 'Cedar', language: 'English', region: null, presentation: null, bestQuality: true },
      { value: 'voice_0123456789', id: 'voice_0123456789', label: 'Coastal (designed)', language: null, region: null, presentation: null, custom: true },
    ],
    styles: [
      { id: 'plain', label: 'Plain', hint: 'The voice as it is, no register added.' },
      { id: 'rp', label: 'Received Pronunciation', hint: 'Crisp and clipped.' },
    ],
    paces: [{ id: 'brisk', label: 'Quick' }, { id: 'normal', label: 'Normal' }, { id: 'relaxed', label: 'Slow' }],
  },
  default: { voice: 'marin' },
  ...over,
});

test('the Select groups English presets first, then best quality, other languages, designed voices', () => {
  const m = voiceSelect(body());
  assert.deepEqual(m.groups.map((g) => g.label), ['English', 'Best quality', 'Other languages', 'Designed voices']);
  assert.deepEqual(m.groups[0]!.options.map((o) => o.value), ['vesper', 'willow']);
  assert.deepEqual(m.groups[2]!.options.map((o) => o.value), ['bossa', 'nuri']);
  assert.deepEqual(m.groups[3]!.options, [{ value: 'voice_0123456789', label: 'Coastal (designed)', description: 'designed from a text description' }]);
});

test('each preset says its presentation and region', () => {
  const m = voiceSelect(body());
  assert.equal(m.groups[0]!.options[0]!.description, 'masculine · British');
  assert.equal(m.groups[2]!.options[0]!.description, 'feminine · Brazilian Portuguese');
  assert.equal(m.groups[2]!.options[1]!.description, 'feminine · German');
  assert.equal(m.groups[1]!.options[0]!.description, 'best quality · presentation not described');
});

test('no choice selects "Default (…)", named after the deployment default', () => {
  const m = voiceSelect(body());
  assert.equal(m.value, DEFAULT_VOICE_VALUE);
  assert.equal(m.options[0]!.label, 'Default (Marin)');
  assert.equal(voiceSelect(body({ default: { voice: 'voice_0123456789' } })).options[0]!.label, 'Default (Coastal (designed))');
});

test('a stored voice the list does not offer is still shown', () => {
  const m = voiceSelect(body({ voice: 'alloy' }));
  assert.equal(m.value, 'alloy');
  assert.deepEqual(m.options[1], { value: 'alloy', label: 'Alloy', description: 'no longer offered' });
});

test('the default value is sent as null, anything else as itself', () => {
  assert.equal(putVoiceValue(DEFAULT_VOICE_VALUE), null);
  assert.equal(putVoiceValue('vesper'), 'vesper');
});

test('style and pace options carry the server labels', () => {
  assert.deepEqual(styleOptions(body())[1], { value: 'rp', label: 'Received Pronunciation', description: 'Crisp and clipped.' });
  assert.deepEqual(paceOptions(body()).map((o) => o.value), ['brisk', 'normal', 'relaxed']);
});

test('save states and refusals read as sentences', () => {
  assert.equal(saveStatusText({ state: 'idle' }), null);
  assert.equal(saveStatusText({ state: 'pending' }), 'Saving…');
  assert.match(saveStatusText({ state: 'saved' })!, /^Saved/);
  assert.equal(saveStatusText({ state: 'error', message: 'voice is not one this deployment offers' }), 'Could not save: voice is not one this deployment offers');
  assert.equal(putErrorMessage(400, { error: 'pace is not one of brisk, normal, relaxed', field: 'pace' }), 'pace is not one of brisk, normal, relaxed');
  assert.equal(putErrorMessage(500, null), 'HTTP 500');
});

test('the section hides on 403 and until the first read answers; a failed read is shown', () => {
  assert.equal(sectionVisible({ data: null, forbidden: true, error: '403 Forbidden' }), false);
  assert.equal(sectionVisible({ data: null, forbidden: false, error: null }), false);
  assert.equal(sectionVisible({ data: null, forbidden: false, error: '500' }), true);
  assert.equal(sectionVisible({ data: body(), forbidden: false, error: null }), true);
});

test('the note says when it applies and that no real person is imitated', () => {
  assert.equal(VOICE_NOTE, 'Applies to your next voice session. Voices are presets or voices designed from a text description; the navigator never imitates a real person.');
});

test('a designed voice is described as designed, never by a person', () => {
  assert.equal(voiceDescription({ value: 'voice_x1234', label: 'X', language: null, region: null, presentation: null, custom: true }), 'designed from a text description');
});
