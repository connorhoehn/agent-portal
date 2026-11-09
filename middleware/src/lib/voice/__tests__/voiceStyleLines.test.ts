// Sweep 6 item 5 (G38): the style and pace lines survive the provider's
// 20,000-character cap whatever the base's length.
import { VOICE_INSTRUCTIONS_MAX, voiceStyleLines, withVoiceSettings } from '../voices.js';

describe('withVoiceSettings', () => {
  it('cuts the base, never the user\'s lines, to fit the cap', () => {
    const settings = { style: 'north-london', pace: 'brisk' } as const;
    const lines = voiceStyleLines(settings);
    expect(lines.length).toBe(2);
    const out = withVoiceSettings('x'.repeat(25_000), null, settings, { voice: null, customVoices: [] });
    expect(out.length).toBeLessThanOrEqual(VOICE_INSTRUCTIONS_MAX);
    expect(out.endsWith(lines.join('\n'))).toBe(true);
    // A short base is untouched.
    expect(withVoiceSettings('base', null, settings, { voice: null, customVoices: [] })).toBe(`base\n${lines.join('\n')}`);
    expect(withVoiceSettings('base', null, { style: 'plain', pace: 'normal' }, { voice: null, customVoices: [] })).toBe('base');
  });
});
