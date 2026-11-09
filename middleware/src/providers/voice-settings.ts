// The voice navigator's per-person voice settings as data (G38): storage only.
//
// One `voice_settings` row per person who saved a choice (schema/voice_sessions.sql),
// keyed by `user_sub` with no tenant: a person's voice is the same in every
// workspace, like app_users, so the table is not under row-level security and
// the route reads and writes only the caller's own row. Validation is the
// route's (lib/voice/voices.ts); this file stores what it is given.

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { voiceSettingsRows } from '../mock/voice-settings.js';
import {
  DEFAULT_VOICE_SETTINGS, isVoicePace, isVoiceStyle, type VoiceSettings,
} from '../lib/voice/voices.js';

export interface VoiceSettingsRow extends VoiceSettings {
  user_sub: string;
  updated_at: string;
}

export type VoiceSettingsPatch = Partial<VoiceSettings>;

const s = (name: string, v: string): SqlParameter => ({ name, value: { stringValue: v } });
const maybe = (name: string, v: string | null): SqlParameter => (v ? s(name, v) : { name, value: { isNull: true } });

/** A stored row as settings; a value this build no longer knows reads as the default. */
function settingsOf(r: { voice?: unknown; style?: unknown; pace?: unknown } | undefined): VoiceSettings {
  if (!r) return { ...DEFAULT_VOICE_SETTINGS };
  return {
    voice: typeof r.voice === 'string' && r.voice ? r.voice : null,
    style: isVoiceStyle(r.style) ? r.style : DEFAULT_VOICE_SETTINGS.style,
    pace: isVoicePace(r.pace) ? r.pace : DEFAULT_VOICE_SETTINGS.pace,
  };
}

const missingTable = (err: unknown): boolean => /relation .*voice_settings.* does not exist/i.test((err as Error)?.message ?? '');

/** The person's settings, or the defaults when they never saved any (or the cluster has no table yet). */
export async function getVoiceSettings(sub: string): Promise<VoiceSettings> {
  if (config.mock.aurora) return settingsOf(voiceSettingsRows.rows().find((r) => r.user_sub === sub));
  try {
    const rows = await exec('SELECT voice, style, pace FROM voice_settings WHERE user_sub = :sub', [s('sub', sub)]);
    return settingsOf(rows[0]);
  } catch (err) {
    if (missingTable(err)) return { ...DEFAULT_VOICE_SETTINGS };
    throw err;
  }
}

/** Merge `patch` over the stored settings and save; returns what is now stored. */
export async function putVoiceSettings(sub: string, patch: VoiceSettingsPatch): Promise<VoiceSettings> {
  const next: VoiceSettings = { ...await getVoiceSettings(sub), ...patch };
  if (config.mock.aurora) {
    const rows = voiceSettingsRows.rows();
    const row: VoiceSettingsRow = { user_sub: sub, ...next, updated_at: clock.nowIso() };
    const i = rows.findIndex((r) => r.user_sub === sub);
    if (i >= 0) rows[i] = row; else rows.push(row);
    return { ...next };
  }
  const rows = await exec(
    `INSERT INTO voice_settings (user_sub, voice, style, pace, updated_at) VALUES (:sub, :voice, :style, :pace, NOW())
     ON CONFLICT (user_sub) DO UPDATE SET voice = EXCLUDED.voice, style = EXCLUDED.style, pace = EXCLUDED.pace, updated_at = NOW()
     RETURNING voice, style, pace`,
    [s('sub', sub), maybe('voice', next.voice), s('style', next.style), s('pace', next.pace)],
  );
  return settingsOf(rows[0]);
}
