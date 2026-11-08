// The voice session's ledger row (docs/voice-navigator-spec.md §7), shared by the close route and the reaper.

import type { VoiceSessionRow } from '../../providers/voice-sessions.js';

/**
 * The session's one ledger row (§7), keyed by its id so a retry is a no-op; a
 * known cost settles the hold, an unknown one leaves it until it expires.
 */
export async function bookVoiceSpend(row: VoiceSessionRow): Promise<void> {
  const { recordSpend } = await import('../../providers/spend-ledger.js');
  await recordSpend({
    source: 'voice_session', sourceId: row.id, initiativeId: null, boxId: null, actorId: row.user_sub,
    trigger: `voice:${row.tenant}`, model: row.model, costUsd: row.cost_usd,
    costBasis: row.cost_usd == null ? 'unknown' : 'estimated', provider: 'openai',
  });
}
