// What a user may pick as the voice navigator's voice, speaking style and pace
// (G38, docs/voice-navigator-gaps.md; the facts are docs/voice-navigator-spec.md
// §1 "Voices (verified 8 November 2026)").
//
// - Presets: the 21 voices the provider's docs describe (language, regional
//   influence, presentation) plus `marin` and `cedar`, the two undescribed
//   Realtime voices the docs call best quality. The docs give those two no
//   presentation or accent, so neither does this file. The other eight
//   undescribed names are accepted when stored (case-insensitive, lowercased)
//   but never offered.
// - Designed voices: only the operator's allowlist, VOICE_CUSTOM_VOICES (a JSON
//   array of { id: 'voice_…', label, description }). A designed voice is made
//   from a text description; the custom-voices guide asks that the description
//   be repeated in the session's `instructions`, so the mint does that.
// - Styles and pace are words only: the API has no speed parameter, and the
//   docs steer register and pace through `instructions`. No line names or
//   imitates a person; the place names are the only proper nouns.
//
// Pure apart from `voiceCatalogueConfig`, which reads the environment.

export type Presentation = 'feminine' | 'masculine';

export interface PresetVoice {
  name: string;
  language: string;
  /** The docs' "regional influence"; null when the docs give none. */
  region: string | null;
  /** Null = the docs do not describe it (marin, cedar). */
  presentation: Presentation | null;
  /** The docs' "best quality" pair, undescribed otherwise. */
  bestQuality?: true;
}

export interface CustomVoice {
  id: string;
  label: string;
  description: string;
}

/** Every preset the user is offered, in the order the docs list them, then the best-quality pair. */
export const PRESET_VOICES: readonly PresetVoice[] = [
  { name: 'quartz', language: 'English', region: 'Australian', presentation: 'feminine' },
  { name: 'ripple', language: 'English', region: 'Australian', presentation: 'masculine' },
  { name: 'vesper', language: 'English', region: 'British', presentation: 'masculine' },
  { name: 'willow', language: 'English', region: 'Irish', presentation: 'feminine' },
  { name: 'stone', language: 'English', region: 'Irish', presentation: 'masculine' },
  { name: 'gleam', language: 'English', region: 'North American', presentation: 'feminine' },
  { name: 'meridian', language: 'English', region: 'North American', presentation: 'masculine' },
  { name: 'bossa', language: 'Portuguese', region: 'Brazilian', presentation: 'feminine' },
  { name: 'tempo', language: 'Portuguese', region: 'Brazilian', presentation: 'masculine' },
  { name: 'beacon', language: 'English', region: 'Filipino', presentation: 'masculine' },
  { name: 'delta', language: 'English', region: 'Southern U.S.', presentation: 'feminine' },
  { name: 'cinder', language: 'English', region: 'Southern U.S.', presentation: 'masculine' },
  { name: 'nuri', language: 'German', region: null, presentation: 'feminine' },
  { name: 'juni', language: 'German', region: null, presentation: 'feminine' },
  { name: 'flitz', language: 'German', region: null, presentation: 'masculine' },
  { name: 'brise', language: 'French', region: null, presentation: 'feminine' },
  { name: 'sillage', language: 'French', region: null, presentation: 'masculine' },
  { name: 'nira', language: 'Hindi', region: null, presentation: 'feminine' },
  { name: 'harema', language: 'Japanese', region: null, presentation: 'feminine' },
  { name: 'shida', language: 'Japanese', region: null, presentation: 'masculine' },
  { name: 'noeul', language: 'Korean', region: null, presentation: 'feminine' },
  { name: 'marin', language: 'English', region: null, presentation: null, bestQuality: true },
  { name: 'cedar', language: 'English', region: null, presentation: null, bestQuality: true },
];

/** The undescribed Realtime names: accepted when stored, never offered. */
export const ACCEPTED_UNOFFERED_VOICES: readonly string[] = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];

/** All 31 names the Live API's `audio.output.voice` enum accepts. */
export const ACCEPTED_PRESET_NAMES: ReadonlySet<string> = new Set([...PRESET_VOICES.map((v) => v.name), ...ACCEPTED_UNOFFERED_VOICES]);

/** The provider's default voice when nothing is chosen and VOICE_VOICE is unset. */
export const PROVIDER_DEFAULT_VOICE = 'marin';

export const VOICE_STYLES = [
  { id: 'plain', label: 'Plain', hint: 'The voice as it is, no register added.', line: null },
  {
    id: 'north-london', label: 'North London', hint: 'Young, relaxed, short casual sentences.',
    line: "Speaking style: a young north London voice, Highgate: relaxed Gen Z phrasing, short casual sentences, 'yeah', 'cool', clipped vowels, never formal.",
  },
  { id: 'rp', label: 'Received Pronunciation', hint: 'Crisp and clipped.', line: 'Speaking style: Received Pronunciation, crisp and clipped.' },
  { id: 'warm', label: 'Warm', hint: 'Warm and unhurried.', line: 'Speaking style: warm and unhurried.' },
  { id: 'brisk', label: 'Brisk', hint: 'Clipped, no pleasantries.', line: 'Speaking style: brisk, clipped, no pleasantries.' },
] as const;
export type VoiceStyle = typeof VOICE_STYLES[number]['id'];

export const VOICE_PACES = [
  { id: 'brisk', label: 'Quick', line: 'Speak quickly.' },
  { id: 'normal', label: 'Normal', line: null },
  { id: 'relaxed', label: 'Slow', line: 'Speak slowly and deliberately.' },
] as const;
export type VoicePace = typeof VOICE_PACES[number]['id'];

export interface VoiceSettings {
  /** A preset name (lowercase) or an allowlisted `voice_…` id; null = the deployment's default. */
  voice: string | null;
  style: VoiceStyle;
  pace: VoicePace;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { voice: null, style: 'plain', pace: 'normal' };

export const isVoiceStyle = (v: unknown): v is VoiceStyle => VOICE_STYLES.some((s) => s.id === v);
export const isVoicePace = (v: unknown): v is VoicePace => VOICE_PACES.some((p) => p.id === v);

/** The id shape lib/voice/openai.ts `liveSessionBody` sends as `{ id }`. */
export const CUSTOM_VOICE_ID = /^voice_[\w-]{4,80}$/;
const MAX_LABEL = 80;
/** The voice-design prompt's own limit (spec §1). */
const MAX_DESCRIPTION = 2_000;

/**
 * VOICE_CUSTOM_VOICES, parsed. Malformed JSON, or an entry without a
 * `voice_…` id, a label and a description, is skipped: an operator typo
 * offers nothing rather than something half-described.
 */
export function parseCustomVoices(raw: string | undefined | null): CustomVoice[] {
  const text = (raw ?? '').trim();
  if (!text) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: CustomVoice[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== 'object') continue;
    const { id, label, description } = e as Record<string, unknown>;
    if (typeof id !== 'string' || !CUSTOM_VOICE_ID.test(id)) continue;
    if (typeof label !== 'string' || !label.trim() || typeof description !== 'string' || !description.trim()) continue;
    if (out.some((v) => v.id === id)) continue;
    out.push({ id, label: label.trim().slice(0, MAX_LABEL), description: description.trim().slice(0, MAX_DESCRIPTION) });
  }
  return out;
}

export interface VoiceCatalogueConfig {
  /** VOICE_VOICE: the deployment's default voice; null = the provider's (marin). */
  voice: string | null;
  /** VOICE_CUSTOM_VOICES: the designed voices a user may pick. */
  customVoices: CustomVoice[];
}

export function voiceCatalogueConfig(env: NodeJS.ProcessEnv = process.env): VoiceCatalogueConfig {
  const voice = (env['VOICE_VOICE'] ?? '').trim();
  return { voice: voice || null, customVoices: parseCustomVoices(env['VOICE_CUSTOM_VOICES']) };
}

/**
 * A stored or requested voice in canonical form, or null when this deployment
 * would not send it: a preset name (any case) becomes lowercase; a `voice_…`
 * id must be on the allowlist as written.
 */
export function canonicalVoice(v: string, customVoices: readonly CustomVoice[]): string | null {
  const t = v.trim();
  if (CUSTOM_VOICE_ID.test(t)) return customVoices.some((c) => c.id === t) ? t : null;
  const lower = t.toLowerCase();
  return ACCEPTED_PRESET_NAMES.has(lower) ? lower : null;
}

/**
 * The voice a mint sends: the user's choice when this deployment still offers
 * it, else VOICE_VOICE, else null (the provider's default, marin).
 */
export function resolveVoice(settings: Pick<VoiceSettings, 'voice'> | null, cfg: VoiceCatalogueConfig): string | null {
  const chosen = settings?.voice ? canonicalVoice(settings.voice, cfg.customVoices) : null;
  return chosen ?? cfg.voice;
}

/** The register and pace lines appended to the voice's instructions. Words only. */
export function voiceStyleLines(settings: Pick<VoiceSettings, 'style' | 'pace'>): string[] {
  const style: string | null = VOICE_STYLES.find((s) => s.id === settings.style)?.line ?? null;
  const pace: string | null = VOICE_PACES.find((p) => p.id === settings.pace)?.line ?? null;
  return [style, pace].filter((l): l is string => l != null);
}

/** For a designed voice, its description, repeated in `instructions` as the custom-voices guide asks. */
export function designedVoiceLines(voice: string | null, customVoices: readonly CustomVoice[]): string[] {
  const custom = voice ? customVoices.find((c) => c.id === voice) : undefined;
  return custom ? [`Your voice, as it was designed: ${custom.description}`] : [];
}

/** The voice's full instructions: the catalogue's, then the designed voice's description, then style and pace. */
/** The provider's instructions cap (openai.ts slices the session's instructions here). */
export const VOICE_INSTRUCTIONS_MAX = 20_000;

/**
 * The voice's instructions with the user's voice lines appended. The base is cut first so the whole stays under
 * VOICE_INSTRUCTIONS_MAX with the voice, style and pace lines whole (sweep 6: a long tool list must never silently
 * drop the user's setting).
 */
export function withVoiceSettings(base: string, voice: string | null, settings: Pick<VoiceSettings, 'style' | 'pace'>, cfg: VoiceCatalogueConfig): string {
  const extra = [...designedVoiceLines(voice, cfg.customVoices), ...voiceStyleLines(settings)].join('\n');
  if (!extra) return base;
  return `${base.slice(0, Math.max(0, VOICE_INSTRUCTIONS_MAX - extra.length - 1))}\n${extra}`;
}

export interface VoiceOption {
  /** Preset name, or the designed voice's id: what PUT takes as `voice`. */
  value: string;
  name?: string;
  id?: string;
  label: string;
  language: string | null;
  region: string | null;
  presentation: Presentation | null;
  bestQuality?: true;
  custom?: true;
}

export interface VoiceSettingsView extends VoiceSettings {
  options: {
    voices: VoiceOption[];
    styles: { id: VoiceStyle; label: string; hint: string }[];
    paces: { id: VoicePace; label: string }[];
  };
  default: { voice: string };
}

const capitalised = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** GET/PUT /api/voice/settings' body. */
export function voiceSettingsView(settings: VoiceSettings, cfg: VoiceCatalogueConfig): VoiceSettingsView {
  const voices: VoiceOption[] = [
    ...PRESET_VOICES.map((v) => ({
      value: v.name, name: v.name, label: capitalised(v.name), language: v.language, region: v.region, presentation: v.presentation,
      ...(v.bestQuality ? { bestQuality: true as const } : {}),
    })),
    ...cfg.customVoices.map((c) => ({
      value: c.id, id: c.id, label: c.label, language: null, region: null, presentation: null, custom: true as const,
    })),
  ];
  return {
    voice: settings.voice, style: settings.style, pace: settings.pace,
    options: {
      voices,
      styles: VOICE_STYLES.map(({ id, label, hint }) => ({ id, label, hint })),
      paces: VOICE_PACES.map(({ id, label }) => ({ id, label })),
    },
    default: { voice: cfg.voice ?? PROVIDER_DEFAULT_VOICE },
  };
}
