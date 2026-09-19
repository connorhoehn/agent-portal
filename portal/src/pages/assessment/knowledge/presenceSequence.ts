// Ordering survives reloads of the same tab; network arrival order need not.
let lastSequence = 0;
export function nextPresenceSequence(): number {
  try {
    const prior = Number(sessionStorage.getItem('assessment.knowledge.presenceSequence'));
    if (Number.isSafeInteger(prior)) lastSequence = Math.max(lastSequence, prior);
  } catch { /* In-memory ordering still works when storage is unavailable. */ }
  lastSequence = Math.max(lastSequence + 1, Date.now() * 1000);
  try { sessionStorage.setItem('assessment.knowledge.presenceSequence', String(lastSequence)); } catch { /* Same fallback. */ }
  return lastSequence;
}
