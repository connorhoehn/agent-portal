// Which live session a call gets: the scripted stand-in in the mock world (the same test as the mock transcript
// source), else the provider's session when the voice key is configured, else none (the invite answers 503, as it did
// before this package). Tests inject with setSessionFactory.
import { voiceConfig } from '../voice/config.js';
import { voiceProviderConfigured } from '../voice/openai.js';
import { OpenAiLiveSession } from './live-session.js';
import { ScriptedSession } from './scripted-session.js';
import type { LiveMeetingSession } from './session.js';
import { liveForced } from './live-flag.js';
import { mockTranscriptEnabled } from './transcript-source.js';

export type SessionFactory = (clock: () => number) => LiveMeetingSession | null;

export const defaultSessionFactory: SessionFactory = (clock) => {
  // The mock world scripts the session, unless MEETING_ASSISTANT_LIVE=1 asks for the real one (never in production).
  if (mockTranscriptEnabled() && !liveForced()) return new ScriptedSession(clock);
  if (!voiceProviderConfigured()) return null;
  const cfg = voiceConfig();
  if (!cfg.delegationModel) return null;
  return new OpenAiLiveSession({ model: cfg.model, voice: cfg.voice, delegationModel: cfg.delegationModel, clock });
};

let factory: SessionFactory | null = null;
export function setSessionFactory(next: SessionFactory | null): void { factory = next; }
export function makeSession(clock: () => number): LiveMeetingSession | null { return (factory ?? defaultSessionFactory)(clock); }
/** Can a session be made at all in this process? (The invite checks before it reserves money.) */
export function sessionAvailable(clock: () => number = Date.now): boolean {
  const s = makeSession(clock);
  return s !== null;
}
