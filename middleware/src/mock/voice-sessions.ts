// The voice navigator's sessions, tool-call rows and event log, offline —
// `voice_sessions`, `voice_tool_calls` and `voice_session_events`
// (schema/voice_sessions.sql, docs/voice-navigator-spec.md §9).
// All three start empty: a session exists only once someone mints one in this
// process, and a reset clears them. The daily minutes (G13) read the sessions
// rows through providers/voice-sessions.ts `userVoiceSecondsSince`, which
// skips `mock: true` rows, so the scripted sessions dev:mock mints never
// count against anyone's day.

import { defineFixture } from './core/index.js';
import type { VoiceSessionEventRow, VoiceSessionRow, VoiceToolCallRow } from '../providers/voice-sessions.js';

export const voiceSessions = defineFixture<VoiceSessionRow>({
  key: 'voice-sessions',
  scenarios: { default: () => [] },
});

export const voiceToolCalls = defineFixture<VoiceToolCallRow>({
  key: 'voice-tool-calls',
  scenarios: { default: () => [] },
});

export const voiceSessionEvents = defineFixture<VoiceSessionEventRow>({
  key: 'voice-session-events',
  scenarios: { default: () => [] },
});
