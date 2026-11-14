// Nova's voice, server half (docs/meeting-assistant-design.md decision 4, package 7a).
//
// Two small pieces the orchestrator uses, neither of which touches a disk, a log or a store:
//
//   VoiceRelay   hands each 100 ms output frame to the gateway sink, one at a time and in order, behind a burst guard (at most 3 s of
//                audio queued per call; the rest is dropped and counted). A frame is transient: it is base64 in one gateway frame
//                and then gone.
//   NovaSpeech   remembers WHEN Nova was being relayed (and for 400 ms after) and WHAT she said then, so a caption of Nova's own voice
//                coming back through a microphone is not taken for a person addressing her (the echo guard).
//
// The gateway frame, for the browser (the portal's playback package codes against this):
//   { type: 'assistant-audio', channel: 'orgiq:huddle:<callId>',
//     data: { callId, seq, sampleRate: 24000, pcm: <base64 PCM16 mono LE, at most 100 ms>, last?: true } }
// `seq` counts from 1 for the life of the call's run (it does not restart when the provider session is replaced). `last: true` marks
// the final frame of an utterance (the end of its 300 ms tail).

/** The call chat's channel (lib/call-chat.ts `callChatChannel`; a test holds the two equal). Written here so this module needs no gateway imports. */
export const voiceChannel = (callId: string): string => `orgiq:huddle:${callId}`;
export const VOICE_SAMPLE_RATE = 24_000;
export const VOICE_FRAME_BYTES = 4800; // 100 ms of PCM16 mono at 24 kHz
export const VOICE_FRAME_MS = 100;
export const VOICE_MAX_QUEUED_MS = 3000;
/** Nova counts as speaking this long after the last frame went out (her voice reaches a microphone a moment later). */
export const VOICE_ECHO_TAIL_MS = 400;

export interface AssistantAudioFrame {
  type: 'assistant-audio';
  channel: string;
  data: { callId: string; seq: number; sampleRate: number; pcm: string; last?: true };
}
/** Sends one frame to the sockets in the call's chat channel. False when no gateway runs in this process (the frame is dropped). */
export type VoiceSink = (channel: string, frame: AssistantAudioFrame) => Promise<boolean> | boolean;

export class VoiceRelay {
  relayed = 0;
  dropped = 0;
  private seq = 0;
  private queue: Array<{ pcm: Buffer; last: boolean }> = [];
  private pumping = false;
  /** Bumped by `clear`, so a pump that was mid-send when the relay was cleared stops and its frame is not counted. */
  private epoch = 0;

  constructor(private readonly callId: string, private readonly channel: string, private readonly sink: () => VoiceSink) {}

  /** Queue a frame (cut to at most 100 ms). Beyond 3 s queued, frames are dropped and counted, except that a frame marked `last` always goes. */
  push(pcm: Buffer, last: boolean): void {
    const pieces: Buffer[] = [];
    for (let at = 0; at < pcm.length; at += VOICE_FRAME_BYTES) pieces.push(pcm.subarray(at, Math.min(pcm.length, at + VOICE_FRAME_BYTES)));
    pieces.forEach((piece, i) => {
      const isLast = last && i === pieces.length - 1;
      if (this.queue.length * VOICE_FRAME_MS >= VOICE_MAX_QUEUED_MS && !isLast) { this.dropped += 1; return; }
      this.queue.push({ pcm: piece, last: isLast });
    });
    void this.pump();
  }

  /** Forget what is queued (paused, left, voice off): those frames are dropped, not sent. */
  clear(): void {
    this.dropped += this.queue.length;
    this.queue = [];
    this.epoch += 1;
  }

  queuedFrames(): number { return this.queue.length; }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const epoch = this.epoch;
        const next = this.queue.shift()!;
        const frame: AssistantAudioFrame = {
          type: 'assistant-audio', channel: this.channel,
          data: { callId: this.callId, seq: this.seq + 1, sampleRate: VOICE_SAMPLE_RATE, pcm: next.pcm.toString('base64'), ...(next.last ? { last: true as const } : {}) },
        };
        let sent = false;
        try { sent = await this.sink()(this.channel, frame); } catch { sent = false; }
        if (epoch !== this.epoch) { this.dropped += 1; continue; }
        this.seq += 1;
        if (sent) this.relayed += 1; else this.dropped += 1;
      }
    } finally { this.pumping = false; }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// The echo guard.

const words = (text: string): string[] => text.toLowerCase().replace(/[^a-z0-9'\s]+/g, ' ').split(/\s+/).filter(Boolean);

interface Span { start: number; end: number; lastFrameAt: number; done: string[]; partial: string }

/** How long after a span's last frame Nova's transcript text may still be attached to it. */
const TEXT_LAG_MS = 3000;

export class NovaSpeech {
  private spans: Span[] = [];
  private orphan: { text: string; at: number } | null = null;

  /** A frame of Nova's voice went out at `now` (it plays for the next 100 ms). */
  noteFrame(now: number): void {
    const cur = this.spans[this.spans.length - 1];
    if (cur && now <= cur.end) { cur.end = now + VOICE_FRAME_MS + VOICE_ECHO_TAIL_MS; cur.lastFrameAt = now; return; }
    const span: Span = { start: now, end: now + VOICE_FRAME_MS + VOICE_ECHO_TAIL_MS, lastFrameAt: now, done: [], partial: '' };
    if (this.orphan && now - this.orphan.at <= TEXT_LAG_MS) { span.partial = this.orphan.text; }
    this.orphan = null;
    this.spans.push(span);
    if (this.spans.length > 20) this.spans.shift();
  }

  /** What Nova's transcript says at `now`: the text so far (`final` false) or a finished piece. Attached to the span it belongs to. */
  noteText(now: number, text: string, final: boolean): void {
    const cur = this.spans[this.spans.length - 1];
    if (!cur || now > cur.lastFrameAt + TEXT_LAG_MS) { if (!final) this.orphan = { text, at: now }; return; }
    if (final) { cur.done.push(text); cur.partial = ''; } else cur.partial = text;
  }

  /** Was Nova being heard for any part of [startMs, endMs]? (For counters and tests.) */
  speakingAt(ms: number): boolean { return this.spans.some((s) => ms >= s.start && ms <= s.end); }

  /**
   * Is this caption Nova's own voice coming back? Only when the caption's whole span lies inside one Nova-speaking span AND its words
   * match what Nova said then: contained in her words in order (two words or more), or at least 80% of its words (three or more) are hers.
   * A person who merely talks over her is kept, and so is anyone whose span is unknown.
   */
  isEcho(line: { text: string; startAt: number; endAt: number } | null): boolean {
    if (!line || !(line.endAt >= line.startAt)) return false;
    const span = this.spans.find((s) => line.startAt >= s.start && line.endAt <= s.end);
    if (!span) return false;
    const nova = words([...span.done, span.partial].join(' '));
    const mine = words(line.text);
    if (mine.length < 2 || nova.length === 0) return false;
    const joined = ` ${nova.join(' ')} `;
    if (joined.includes(` ${mine.join(' ')} `)) return true;
    if (mine.length < 3) return false;
    const set = new Set(nova);
    return mine.filter((w) => set.has(w)).length / mine.length >= 0.8;
  }
}
