// The voice navigator's per-person voice settings, offline — the
// `voice_settings` rows (schema/voice_sessions.sql, G38). Starts empty: nobody
// has chosen anything until they save on Settings › Voice, and a reset clears
// the choices back to the deployment's default.

import { defineFixture } from './core/index.js';
import type { VoiceSettingsRow } from '../providers/voice-settings.js';

export const voiceSettingsRows = defineFixture<VoiceSettingsRow>({
  key: 'voice-settings',
  scenarios: { default: () => [] },
});
