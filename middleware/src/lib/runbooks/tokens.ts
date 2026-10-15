// Token estimate and content hash — the ONE estimator every budget in the
// brief uses (design §3.2 step 5). Deterministic by construction: chars / 4,
// rounded up. It does not try to match any model's tokenizer; it has to agree
// with itself, so a brief's budget check and its recorded used_tokens never
// disagree.
import { createHash } from 'node:crypto';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 4212 → "4,212", without locale data (ICU-independent, so a contract sha never moves with the host). */
export function groupThousands(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${grouped}` : grouped;
}
