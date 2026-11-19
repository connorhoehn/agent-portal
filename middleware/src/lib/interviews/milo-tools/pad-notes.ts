// The pad's changes reach the session (review 1, item 7).
import type { PadEventIn } from '../pad/log/rules.js';
import type { PadLanguage } from '../types.js';
import { hasPad, padContextNote } from './context.js';
import { deps, liveInterview } from './deps.js';

const padNoted = new Map<string, { language: string; text: string; at: number }>();

/** The pad a session started with (family.ts `backendInstructions`). */
export function notePadSeen(interviewId: string, pad: { text: string; language: PadLanguage }): void {
  padNoted.set(interviewId, { language: pad.language, text: pad.text, at: deps().now() });
}

/**
 * What the pad log took in (pad/log/service.ts `appendPadEvents`): when the pad's language changed, the live session of the
 * interview's call is told the pad as it is now (silent context), so a helper or a test asked for next is written in the pad's
 * language. A change of text alone is never told (review 2, item 4: a note every 30 s all interview grew the session's context);
 * a call refused for the pad's language carries the pad as it is in its retry note instead.
 */
export async function notePadChange(interviewId: string, events: readonly PadEventIn[], now = Date.now()): Promise<boolean> {
  const snap = [...events].reverse().find((e) => e.kind === 'snapshot' && typeof e.text === 'string');
  const lang = [...events].reverse().find((e) => (e.kind === 'language' || e.kind === 'snapshot') && typeof e.language === 'string')?.language;
  if (!snap && !lang) return false;
  const last = padNoted.get(interviewId);
  const language = (lang ?? last?.language ?? '') as PadLanguage;
  const text = snap?.text ?? last?.text ?? '';
  if (!language) return false;
  const languageChanged = !!last && last.language !== language;
  padNoted.set(interviewId, { language, text, at: now });
  if (padNoted.size > 500) padNoted.delete(padNoted.keys().next().value as string);
  if (!last || !languageChanged) return false; // the first look (the session started with this pad), or the text alone changed
  const interview = await liveInterview(interviewId);
  if (!interview || !interview.callId || !hasPad(interview)) return false;
  const { peekAssistantRuntime } = await import('../../meeting-assistant/orchestrator.js');
  return peekAssistantRuntime()?.addSessionContext(interview.callId, padContextNote({ text, language })) ?? false;
}

/** Tests: forget what was noted. */
export function resetPadNotes(): void { padNoted.clear(); }
