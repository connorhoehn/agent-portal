// The recording picker on `/summarize` and `/deck` (docs/agentic-flows-migration.md
// slice 7): the library's ChatCommandProvider argument menu, the way
// realtime-examples' deckCommand does it (deckCommand.ts:148-176). Picking a row
// inserts `--from recording:<id>` into the draft (the machine token the BFF
// parses: lib/social-summarize-args.ts, lib/social-deck/args.ts), so the person
// can still type what the deck is about. The rows are THIS conversation's
// recordings; the BFF re-asks every authority question on send.

import type { ChatCommand, ChannelRecordingItem } from '@connorhoehnslalom/ui-components/social';

export interface RecordingPick { recordingId: string; label: string; hint?: string }

const minutes = (ms: number | undefined): string | null => (ms && ms > 0 ? `${Math.max(1, Math.round(ms / 60_000))} min` : null);

/** The conversation's recordings that can have a transcript, newest first. Rooms have no conversation, so none. */
export function recordingPicks(channel: string, recordings: readonly ChannelRecordingItem[]): RecordingPick[] {
  if (!channel.startsWith('social:dm:')) return [];
  return [...recordings]
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    .map(r => {
      const when = r.startedAt ? new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Recorded call';
      const length = minutes(r.durationMs);
      return { recordingId: r.recordingId, label: when, ...(length ? { hint: length } : {}) };
    });
}

/** `/summarize --from recording:<id>` — what a pick writes. */
export const recordingToken = (recordingId: string): string => `--from recording:${recordingId}`;

/** The same command with the recording picker attached. `load` is read on every keystroke. */
export function withRecordingPicker(command: ChatCommand, load: () => readonly RecordingPick[]): ChatCommand {
  return {
    ...command,
    argument: {
      placeholder: 'pick a recorded call to use as the source, or keep typing',
      search: query => {
        const needle = query.trim().toLowerCase();
        return load()
          .filter(item => !needle || item.label.toLowerCase().includes(needle) || recordingToken(item.recordingId).includes(needle))
          .map(item => ({ id: item.recordingId, label: recordingToken(item.recordingId), icon: '🎙️', hint: item.hint ? `${item.label} · ${item.hint}` : item.label }));
      },
      onPick: () => 'insert',
    },
  };
}
