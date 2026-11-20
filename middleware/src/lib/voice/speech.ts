// The voice backend: whatever turns one logged line into PCM (docs/milo-rebuild/REBUILD-PLAN.md section 1).
//
// Speak (meeting-assistant/turn/speak.ts) knows only this interface, so a text-to-speech model that retires, or a different
// provider, is a new backend and a config value, not a change to the turn. MILO_TTS_BACKEND names the backend (default `openai`).
//
// Spoken equals logged: a backend reports through `onInput` the exact text it is about to have spoken, before any audio. Speak
// compares that with the logged line and plays nothing when they differ, so a backend that trims, normalises, truncates or
// rewrites its input cannot make Milo say words the log does not hold.
import { openAiSpeech } from './openai-tts.js';

export interface SpeechResult { firstAudioMs: number | null; ms: number; bytes: number }

export interface SpeechOpts {
  signal?: AbortSignal;
  /** Called once, before any audio, with the exact text sent to be spoken. */
  onInput(input: string): void;
  /** PCM16 mono at the backend's `sampleRate`, whole samples, as it arrives. Never kept. */
  onAudio(pcm: Buffer): void;
  now?: () => number;
}

export interface SpeechBackend {
  /** For traces: provider, model and voice. Never a key. */
  readonly id: string;
  readonly sampleRate: number;
  /** Speak `text`, unchanged. Rejects when the provider fails or `signal` aborts. */
  speak(text: string, opts: SpeechOpts): Promise<SpeechResult>;
}

const BACKENDS: Record<string, () => SpeechBackend> = { openai: openAiSpeech };

/** The configured backend. Throws on a name this build does not have: the line stays logged and posted, and is not said. */
export function speechBackend(): SpeechBackend {
  const name = (process.env['MILO_TTS_BACKEND'] ?? '').trim().toLowerCase() || 'openai';
  const make = Object.hasOwn(BACKENDS, name) ? BACKENDS[name] : undefined;
  if (!make) throw new Error(`no voice backend named "${name}"`);
  return make();
}
