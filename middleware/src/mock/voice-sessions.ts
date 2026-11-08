// The voice navigator's sessions and tool-call rows, offline — `voice_sessions`
// and `voice_tool_calls` (schema/voice_sessions.sql, docs/voice-navigator-spec.md §9).
// Both start empty: a session exists only once someone mints one in this
// process, and a reset clears them. The daily minutes (G13) read the sessions
// rows through providers/voice-sessions.ts `userVoiceSecondsSince`, which
// skips `mock: true` rows, so the scripted sessions dev:mock mints never
// count against anyone's day.

import { defineFixture } from './core/index.js';
import type { VoiceSessionRow, VoiceToolCallRow } from '../providers/voice-sessions.js';

export const voiceSessions = defineFixture<VoiceSessionRow>({
  key: 'voice-sessions',
  scenarios: { default: () => [] },
});

export const voiceToolCalls = defineFixture<VoiceToolCallRow>({
  key: 'voice-tool-calls',
  scenarios: { default: () => [] },
});
