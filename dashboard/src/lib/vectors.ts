// [fork] W23: small vector helpers for the playground's embeddings view.

export function vectorNorm(v: number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

/** Cosine similarity; null when either vector is all zeros or sizes differ. */
export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  const denom = vectorNorm(a) * vectorNorm(b);
  if (denom === 0) return null;
  return a.reduce((sum, x, i) => sum + x * b[i], 0) / denom;
}
