// The text after `/summarize` in a Social conversation:
//
//   /summarize [range]                      the recent thread (lib/social-summarize-range.ts)
//   /summarize --recording <id> [focus]     a recorded call's transcript (slice 7)
//   /summarize --from recording:<id>        the same, in the form the picker writes
//
// realtime-examples' picker writes `--from recording:<id>` (deckCommand.ts:167);
// `--recording <id>` is the short spelling. A recording replaces the range:
// whatever else is typed becomes the instruction the summary is asked to follow.

import { parseSummarizeRange } from './social-summarize-range.js';

export type SummarizeArgs =
  | { ok: true; recordingId: string | null; sinceMs: number | null; instruction: string }
  | { ok: false; error: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function parseSummarizeArgs(argumentText: string, now: Date): SummarizeArgs {
  const words = argumentText.trim().split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  let recordingId: string | null = null;
  const take = (value: string | undefined): string | null => {
    if (!value || !ID.test(value)) return null;
    return value;
  };
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const lowered = word.toLowerCase();
    let value: string | undefined;
    let isFlag = false;
    if (lowered === '--recording') { isFlag = true; value = words[i + 1]; i += 1; }
    else if (lowered.startsWith('--recording=')) { isFlag = true; value = word.slice('--recording='.length); }
    else if (lowered === '--from' || lowered.startsWith('--from=')) {
      isFlag = true;
      const raw = lowered.startsWith('--from=') ? word.slice('--from='.length) : words[(i += 1)];
      const m = /^recording:(.+)$/i.exec(raw ?? '');
      if (!m) return { ok: false, error: 'Use --from recording:<id>, or pick a recording from the list.' };
      value = m[1];
    }
    if (!isFlag) { kept.push(word); continue; }
    const id = take(value);
    if (!id) return { ok: false, error: 'Name the recording after --recording, or pick one from the list.' };
    if (recordingId && recordingId !== id) return { ok: false, error: 'Summarize one recording at a time.' };
    recordingId = id;
  }
  const rest = kept.join(' ');
  if (recordingId) return { ok: true, recordingId, sinceMs: null, instruction: rest };
  const range = parseSummarizeRange(argumentText, now);
  return range.ok ? { ok: true, recordingId: null, sinceMs: range.sinceMs, instruction: argumentText.trim() } : range;
}
