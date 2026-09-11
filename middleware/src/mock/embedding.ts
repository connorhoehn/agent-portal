// The offline embedding — a bag-of-words projection, not Titan.
//
// WHY THIS EXISTS. `lib/embedding.ts` invokes `amazon.titan-embed-text-v2:0`.
// Offline it throws, `processTrace` catches it into `null`, and the whole drift
// half of the observability pipeline then does nothing: no vector is stored, no
// centroid can ever be computed from stored vectors, and `EmbeddingDriftP95` is
// never published. The drift surfaces read `mock/observability.ts`'s modelled
// per-row distance instead, so the PAGES look fine while the PIPELINE that
// produces the column has never once run offline.
//
// WHAT THIS IS. For each content word, one dimension chosen by a stable hash,
// weighted by occurrences, then L2-normalised. Two texts that share vocabulary
// therefore have a genuinely smaller cosine distance than two that do not, and
// `cosineDistance` in lib/embedding.ts — a pure function — computes the real
// thing over these vectors.
//
// WHAT IT IS NOT. It is not semantic. It cannot tell that "Kubernetes" and
// "container orchestration" are the same subject, so offline drift is drift in
// VOCABULARY, not drift in meaning. That is a much weaker claim than Titan's
// and it is the honest one; anything read off these vectors should be read as
// "the fleet started using different words", never as "the fleet changed its
// mind". It is deterministic — the same text always yields the same vector —
// which is what lets a frozen-clock test assert an exact distance.

/** FNV-1a. Small, fast, stable across processes — an id, not a checksum. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A unit vector of `dimensions` components for `text`, or null when there is
 * nothing to embed — matching `embedText`'s contract, which returns null for
 * blank input so the caller stores a NULL vector rather than a zero one.
 */
export function lexicalEmbedding(text: string, dimensions: number): number[] | null {
  const words = (text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  if (words.length === 0) return null;

  const vec = new Array<number>(dimensions).fill(0);
  for (const word of words) {
    const idx = hash32(word) % dimensions;
    // A second, differently-seeded bucket per word: with one bucket each, two
    // texts sharing a single common word collide onto exactly one dimension and
    // every distance collapses towards 1. Two spreads the mass without making
    // the projection any less deterministic.
    const alt = hash32(`${word}#2`) % dimensions;
    vec[idx] = (vec[idx] ?? 0) + 1;
    vec[alt] = (vec[alt] ?? 0) + 0.5;
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let i = 0; i < dimensions; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}
