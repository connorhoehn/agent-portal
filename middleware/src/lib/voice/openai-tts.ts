// Text to speech: one line, streamed as PCM16 mono at 24 kHz (Milo's mouth, docs/milo-rebuild/REBUILD-PLAN.md section 1).
//
// The input is exactly the text the caller logged: nothing here rewrites, trims or adds words. The audio is handed to the caller
// as it arrives and is never kept. The key is read here and goes nowhere else (not in a return value, an error or a log line).
//
// Model and voice are config: MILO_TTS_MODEL (default gpt-4o-mini-tts, the probe's fastest first byte, REBUILD-PROBE.md c) and
// MILO_TTS_VOICE (then VOICE_VOICE, then cedar). The default model retires on 2027-01-06: its successor is a MILO_TTS_MODEL value,
// and any model this module has no special case for gets the plain request (model, voice, input, pcm). The turn reaches this module
// only through the SpeechBackend interface (./speech.ts), so another provider is another backend.
import type { SpeechBackend, SpeechOpts, SpeechResult } from './speech.js';

function apiKey(): string | null {
  const v = (process.env['OPENAI_API_KEY'] ?? '').trim();
  return v && !v.includes('REPLACE_ME') ? v : null;
}
const apiBase = (): string => ((process.env['OPENAI_BASE_URL'] ?? '').trim() || 'https://api.openai.com/v1').replace(/\/$/, '');

export const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_TTS_VOICE = 'cedar';
/** The PCM the provider returns for `response_format: 'pcm'`. */
export const TTS_SAMPLE_RATE = 24_000;

export function ttsModel(): string { return (process.env['MILO_TTS_MODEL'] ?? '').trim() || DEFAULT_TTS_MODEL; }
export function ttsVoice(): string { return (process.env['MILO_TTS_VOICE'] ?? '').trim() || (process.env['VOICE_VOICE'] ?? '').trim() || DEFAULT_TTS_VOICE; }

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ status: number; body: AsyncIterable<Uint8Array> | null; text(): Promise<string> }>;
const realFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, body: res.body as unknown as AsyncIterable<Uint8Array> | null, text: () => res.text() };
};
let fetchImpl: FetchLike = realFetch;
/** Tests: replace the transport. */
export function _setTtsFetch(f: FetchLike | null): void { fetchImpl = f ?? realFetch; }

export class TtsError extends Error {
  constructor(message: string, readonly kind: 'no-key' | 'aborted' | 'network' | 'status' | 'input-changed', readonly status?: number) { super(message); }
}

export type TtsResult = SpeechResult;

/** The request body. `input` is the caller's text, unchanged. */
export function ttsBody(text: string, opts: { model?: string; voice?: string; instructions?: string } = {}): Record<string, unknown> {
  const model = opts.model ?? ttsModel();
  const body: Record<string, unknown> = { model, voice: opts.voice ?? ttsVoice(), input: text, response_format: 'pcm' };
  if (model.startsWith('gpt-4o-mini-tts')) {
    body['stream_format'] = 'audio';
    if (opts.instructions) body['instructions'] = opts.instructions;
  }
  return body;
}

/**
 * Speak `text`: each PCM chunk goes to `onAudio` as it arrives (an odd trailing byte is held so every chunk is whole samples).
 * Throws TtsError; an abort through `signal` throws kind 'aborted'.
 */
export async function streamSpeech(text: string, opts: { signal?: AbortSignal; onInput?: (input: string) => void; onAudio: (pcm: Buffer) => void; now?: () => number; model?: string; voice?: string; instructions?: string }): Promise<TtsResult> {
  const key = apiKey();
  if (!key) throw new TtsError('no OpenAI key configured', 'no-key');
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (opts.signal?.aborted) throw new TtsError('speech was stopped', 'aborted');
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const aborted = (): boolean => controller.signal.aborted;
  try {
    // Spoken equals logged, at the wire: whatever a model's request shape becomes, the input sent is the caller's text or nothing is.
    const body = ttsBody(text, opts);
    if (body['input'] !== text) throw new TtsError('the speech request would not say the given text', 'input-changed');
    opts.onInput?.(body['input'] as string);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(`${apiBase()}/audio/speech`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      });
    } catch {
      throw aborted() ? new TtsError('speech was stopped', 'aborted') : new TtsError('the speech request failed', 'network');
    }
    if (res.status < 200 || res.status >= 300 || !res.body) {
      await res.text().catch(() => '');
      throw new TtsError(`the speech request was refused (${res.status})`, 'status', res.status);
    }
    let firstAudioMs: number | null = null;
    let bytes = 0;
    let carry: Buffer | null = null;
    try {
      for await (const chunk of res.body) {
        if (aborted()) break;
        let buf = Buffer.from(chunk);
        if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
        if (buf.length % 2) { carry = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
        if (!buf.length) continue;
        if (firstAudioMs === null) firstAudioMs = now() - t0;
        bytes += buf.length;
        opts.onAudio(buf);
      }
    } catch {
      if (!aborted()) throw new TtsError('the speech stream broke', 'network');
    }
    if (aborted()) throw new TtsError('speech was stopped', 'aborted');
    return { firstAudioMs, ms: now() - t0, bytes };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** OpenAI's speech endpoint as a voice backend, with the configured model and voice. */
export function openAiSpeech(): SpeechBackend {
  const model = ttsModel();
  const voice = ttsVoice();
  return {
    id: `openai:${model}:${voice}`,
    sampleRate: TTS_SAMPLE_RATE,
    speak: (text: string, opts: SpeechOpts) => streamSpeech(text, { ...opts, model, voice }),
  };
}
