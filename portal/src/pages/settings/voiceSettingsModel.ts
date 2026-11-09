// Settings › Voice (G38): the wording and the option shaping for the voice
// navigator's voice, speaking style and pace. VoiceSection.tsx only fetches,
// saves and draws; everything a test can read lives here.
//
// The body is GET/PUT /api/voice/settings (middleware/src/routes/voice.ts,
// lib/voice/voices.ts). A voice is a provider preset or a voice designed from
// a text description on the operator's allowlist; nothing here names or
// imitates a person.

export type Presentation = 'feminine' | 'masculine';

export interface VoiceOptionBody {
  value: string;
  name?: string;
  id?: string;
  label: string;
  language: string | null;
  region: string | null;
  presentation: Presentation | null;
  bestQuality?: boolean;
  custom?: boolean;
}

export interface VoiceSettingsBody {
  voice: string | null;
  style: string;
  pace: string;
  options: {
    voices: VoiceOptionBody[];
    styles: { id: string; label: string; hint: string }[];
    paces: { id: string; label: string }[];
  };
  default: { voice: string };
}

/** The Select's value for "no choice: the deployment's default". Never sent: it becomes `voice: null`. */
export const DEFAULT_VOICE_VALUE = '__default';

export const VOICE_NOTE =
  'Applies to your next voice session. Voices are presets or voices designed from a text description; the navigator never imitates a real person.';

export const VOICE_ROW_HINT = 'English voices first; the description is the provider\'s own.';
export const STYLE_ROW_HINT = 'A register the voice is asked to speak in. Words only.';
export const PACE_ROW_HINT = 'There is no speed control in the provider; the voice is asked in words.';

export interface Option { value: string; label: string; description?: string }
export interface OptionGroup { label: string; options: Option[] }

const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "masculine · British", "feminine · German", "best quality · not described", "designed from a description". */
export function voiceDescription(v: VoiceOptionBody): string {
  if (v.custom) return 'designed from a text description';
  if (!v.presentation) return v.bestQuality ? 'best quality · presentation not described' : 'not described';
  const where = v.language && v.language !== 'English'
    ? (v.region ? `${v.region} ${v.language}` : v.language)
    : (v.region ?? v.language ?? '');
  return where ? `${v.presentation} · ${where}` : v.presentation;
}

function asOption(v: VoiceOptionBody): Option {
  return { value: v.value, label: v.label, description: voiceDescription(v) };
}

/** The label of a voice value in this body, else the value title-cased (a preset this build does not offer). */
export function voiceLabel(body: VoiceSettingsBody, value: string): string {
  const found = body.options.voices.find((v) => v.value === value);
  return found ? found.label : title(value);
}

export interface VoiceSelectModel {
  value: string;
  options: Option[];
  groups: OptionGroup[];
}

/**
 * The voice Select: "Default (…)" first, then English presets, the best-quality
 * pair, the other languages, and the designed voices. A stored voice the list
 * no longer offers is kept as a flat option so the field still shows it.
 */
export function voiceSelect(body: VoiceSettingsBody): VoiceSelectModel {
  const voices = body.options.voices;
  const english = voices.filter((v) => !v.custom && !v.bestQuality && v.language === 'English');
  const best = voices.filter((v) => !v.custom && v.bestQuality);
  const other = voices.filter((v) => !v.custom && !v.bestQuality && v.language !== 'English');
  const designed = voices.filter((v) => v.custom);
  const groups: OptionGroup[] = [
    { label: 'English', options: english.map(asOption) },
    { label: 'Best quality', options: best.map(asOption) },
    { label: 'Other languages', options: other.map(asOption) },
    { label: 'Designed voices', options: designed.map(asOption) },
  ].filter((g) => g.options.length > 0);
  const options: Option[] = [{
    value: DEFAULT_VOICE_VALUE,
    label: `Default (${voiceLabel(body, body.default.voice)})`,
    description: 'this deployment\'s voice',
  }];
  const value = body.voice ?? DEFAULT_VOICE_VALUE;
  if (body.voice && !voices.some((v) => v.value === body.voice)) {
    options.push({ value: body.voice, label: voiceLabel(body, body.voice), description: 'no longer offered' });
  }
  return { value, options, groups };
}

/** What PUT takes for a Select value. */
export function putVoiceValue(value: string): string | null {
  return value === DEFAULT_VOICE_VALUE ? null : value;
}

export function styleOptions(body: VoiceSettingsBody): Option[] {
  return body.options.styles.map((s) => ({ value: s.id, label: s.label, description: s.hint }));
}

export function paceOptions(body: VoiceSettingsBody): Option[] {
  return body.options.paces.map((p) => ({ value: p.id, label: p.label }));
}

export type SaveState =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'saved' }
  | { state: 'error'; message: string };

/** The one line under the rows; null = nothing to say. */
export function saveStatusText(s: SaveState): string | null {
  if (s.state === 'pending') return 'Saving…';
  if (s.state === 'saved') return 'Saved. Your next voice session uses it.';
  if (s.state === 'error') return `Could not save: ${s.message}`;
  return null;
}

/** A refused PUT's reason: the server names the field, the person reads a sentence. */
export function putErrorMessage(status: number, body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; field?: unknown };
  if (status === 400 && typeof b.error === 'string') return b.error;
  if (status === 403) return 'you do not have voice navigation in this workspace.';
  if (status === 429) return 'too many changes at once; try again in a minute.';
  return typeof b.error === 'string' ? b.error : `HTTP ${status}`;
}

/** Whether the section is drawn: hidden on 403 (no VoiceNavigate grant), and until the first read answers. */
export function sectionVisible(read: { data: VoiceSettingsBody | null; forbidden: boolean; error: string | null }): boolean {
  if (read.forbidden) return false;
  return read.data != null || read.error != null;
}
