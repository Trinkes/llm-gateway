// [fork] W14: estimate wall watts from APU watts where the metering plug has no
// reading. Learned from recent 10-minute buckets fully covered by both: a
// least-squares line `wall = k × apu + c` when the data supports a slope, else
// a flat measured offset, else the manual overhead setting.

/** Pairs come from this many seconds before now. */
export const FIT_WINDOW_S = 7 * 86400;
/** One day of 10-minute buckets. */
export const MIN_PAIRS = 144;
/** Least APU watts range that still gives a usable slope. */
export const MIN_SPREAD_W = 20;
const K_MIN = 0.8;
const K_MAX = 2;
const C_MIN = 0;
const C_MAX = 150;
/** Float slack on the bounds, so exact-bound fits are not lost to rounding. */
const EPS = 1e-9;

/** Least-squares sums over the pairs (x = APU watts, y = wall watts). */
export interface PairSums {
  n: number;
  sx: number;
  sy: number;
  sxy: number;
  sxx: number;
  minX: number | null;
  maxX: number | null;
}

export interface FallbackModel {
  kind: "fit" | "offset" | "setting";
  k: number;
  c: number;
  pairs: number;
  windowDays: 7;
}

const within = (v: number, lo: number, hi: number) =>
  v >= lo - EPS && v <= hi + EPS;

/** The least-squares line, or null when the pairs do not support one. */
function fit(s: PairSums): { k: number; c: number } | null {
  if (s.minX === null || s.maxX === null) return null;
  if (s.maxX - s.minX < MIN_SPREAD_W) return null;
  const den = s.n * s.sxx - s.sx * s.sx;
  if (den <= 0) return null;
  const k = (s.n * s.sxy - s.sx * s.sy) / den;
  const c = (s.sy - k * s.sx) / s.n;
  return within(k, K_MIN, K_MAX) && within(c, C_MIN, C_MAX) ? { k, c } : null;
}

export function chooseFallbackModel(
  sums: PairSums,
  overheadW: number | undefined,
): FallbackModel {
  const base = { pairs: sums.n, windowDays: 7 as const };
  const setting: FallbackModel = {
    kind: "setting",
    k: 1,
    c: overheadW ?? 0,
    ...base,
  };
  if (sums.n < MIN_PAIRS) return setting;
  const line = fit(sums);
  if (line) return { kind: "fit", ...line, ...base };
  // Same bounds as the fit's intercept: a negative offset (wall below APU, e.g.
  // the box moved off the plug) would price APU-only time below zero.
  const c = (sums.sy - sums.sx) / sums.n;
  return within(c, C_MIN, C_MAX)
    ? { kind: "offset", k: 1, c, ...base }
    : setting;
}

export function modelWatts(m: FallbackModel, apuW: number): number {
  return m.k * apuW + m.c;
}
