// The voice navigator's settings (docs/voice-navigator-spec.md §7, §8), read
// from the environment on every call so a test or an operator override needs
// no restart path of its own. The names are the ones infra delivers to the
// middleware task (infra/lib/middleware-service-stack.ts, -c voice=true).
// OPENAI_API_KEY is deliberately absent: only lib/voice/openai.ts reads it (§6).

export interface VoiceConfig {
  /** VOICE_LIVE_MODEL: the voice model (default gpt-live-1). */
  model: string;
  /** VOICE_DELEGATION_MODEL: the Responses model that runs the functions (default gpt-6-luna, the
   *  model V1 verified on the account); `off` = no delegation, every tool off (§8). */
  delegationModel: string | null;
  /** VOICE_VOICE: a built-in voice name or a `voice_…` id; unset = the model's default. */
  voice: string | null;
  /** VOICE_USD_PER_MINUTE (default 0.05, the prototype README's third-party figure). */
  usdPerMinute: number;
  /** VOICE_SESSION_MINUTES_P75 (default 10): what the hold reserves. */
  p75Minutes: number;
  /** VOICE_SESSION_MAX_MINUTES (default 30): the session ceiling the hold and the reaper bound. */
  maxMinutes: number;
  /** MOCK_VOICE=1: a scripted session, no OpenAI call (§6, §8). */
  mock: boolean;
}

function positive(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : fallback;
}

function text(name: string): string | null {
  const v = (process.env[name] ?? '').trim();
  return v ? v : null;
}

function delegation(): string | null {
  const v = text('VOICE_DELEGATION_MODEL');
  if (v && ['off', 'none', 'false', '0'].includes(v.toLowerCase())) return null;
  return v ?? 'gpt-6-luna';
}

export function voiceConfig(): VoiceConfig {
  const mockRaw = (process.env['MOCK_VOICE'] ?? '').trim().toLowerCase();
  return {
    model: text('VOICE_LIVE_MODEL') ?? 'gpt-live-1',
    delegationModel: delegation(),
    voice: text('VOICE_VOICE'),
    usdPerMinute: positive('VOICE_USD_PER_MINUTE', 0.05),
    p75Minutes: positive('VOICE_SESSION_MINUTES_P75', 10),
    maxMinutes: positive('VOICE_SESSION_MAX_MINUTES', 30),
    mock: mockRaw === '1' || mockRaw === 'true',
  };
}

/** OpenAI bills a WebRTC session at least 15 seconds (prototype README). */
export const MIN_BILLED_SECONDS = 15;

/** Cost of `seconds` of voice at `usdPerMinute`, to four places. */
export function voiceCostUsd(seconds: number, usdPerMinute: number): number {
  return Math.round((seconds / 60) * usdPerMinute * 10_000) / 10_000;
}
