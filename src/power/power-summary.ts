// [fork] W13: energy, electricity cost and cloud comparison from per-period sums.
// [fork] W14: wall-meter seconds are priced as measured; APU-only seconds go
// through the fallback model (which carries the overhead setting when there is
// no plug data), never on top of a wall reading.
import { modelWatts, type FallbackModel } from "./fallback-model";
import {
  addKindBusy,
  attributeEnergy,
  kindEnergy,
  outputKindsUsd,
  type KindBusy,
  type KindEnergy,
} from "./kind-energy";
import type { Period } from "./periods";
import type { IdleStats } from "./power-query";
import type { PowerSettings } from "./power-settings";

const WS_PER_KWH = 3.6e6;
const HOURS_PER_MONTH = 730;

export interface TokenSums {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

/** One period's raw sums as read from D1. */
export interface PeriodRaw extends Period {
  /** [fork] W14: wall-meter energy (watt-seconds) and the seconds it covers. */
  wallWs: number;
  wallS: number;
  /** APU energy and seconds of measured time without a wall reading. */
  apuWs: number;
  apuS: number;
  wallPeakW: number | null;
  apuPeakW: number | null;
  tokens: TokenSums;
  /** The priced requests' tokens at their `model_pricing` rates, in USD. */
  cloudUsd: number;
  /** Requests whose provider/model has no `model_pricing` row. */
  unpricedRequests: number;
  /** [fork] W17: each request kind's busy time, for the energy split. */
  kinds: KindBusy[];
}

export interface PowerTotals {
  effectiveS: number;
  measuredS: number;
  /** measuredS / effectiveS; null when there is no power data. */
  coverage: number | null;
  /** wallKwh + modelledKwh: energy of the measured seconds. */
  measuredKwh: number;
  /** Energy read by the wall meter. */
  wallKwh: number;
  /** Energy of measured seconds without a wall reading, via the fallback model. */
  modelledKwh: number;
  /** Gaps, estimated at the range's average watts. */
  estimatedKwh: number;
  totalKwh: number;
  /** Average wall watts over the measured seconds (wall and modelled). */
  avgW: number | null;
  /** Share of measured seconds read by the wall meter. */
  wallCoverage: number | null;
  source: "wall" | "apu" | "mixed" | null;
  peakW: number | null;
  electricityUsd: number | null;
  tokens: TokenSums;
  /** Null when no request in the range has a `model_pricing` rate. */
  cloudUsd: number | null;
  /** Requests left out of `cloudUsd` because they have no rate. */
  unpricedRequests: number;
  savingsUsd: number | null;
  /** [fork] W17: output-producing token kinds' electricity per 1M output tokens. */
  electricityPer1mOutputUsd: number | null;
  cloudPer1mOutputUsd: number | null;
  /** [fork] W17: the energy split by each kind's busy time. */
  kinds: KindEnergy[];
}

export type PeriodTotals = PowerTotals & Period;

const EMPTY_TOKENS: TokenSums = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
};

/** Seconds of `p` inside `[dataStart, now)`. */
export function effectiveSeconds(
  p: Period,
  dataStart: number | null,
  now: number,
): number {
  if (dataStart === null) return 0;
  return Math.max(0, Math.min(p.end, now) - Math.max(p.start, dataStart));
}

const per1mOutput = (usd: number | null, output: number) =>
  usd === null || output === 0 ? null : (usd / output) * 1e6;

const addTokens = (a: TokenSums, b: TokenSums): TokenSums => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  requests: a.requests + b.requests,
});

/** Cloud figure: null when every request is unpriced (no rate to use). */
const cloudOrNull = (cloudUsd: number, tokens: TokenSums, unpriced: number) =>
  unpriced > 0 && unpriced === tokens.requests ? null : cloudUsd;

/** One set of sums with APU-only time already turned into wall watt-seconds. */
interface Sums {
  effectiveS: number;
  wallWs: number;
  wallS: number;
  modelledWs: number;
  apuS: number;
  peakW: number | null;
  tokens: TokenSums;
  cloud: { usd: number; unpriced: number };
  /** [fork] W17: per-kind busy time, the weights of the energy split. */
  kinds: KindBusy[];
}

function sourceOf(wallS: number, measuredS: number): PowerTotals["source"] {
  if (measuredS === 0) return null;
  if (wallS === measuredS) return "wall";
  return wallS === 0 ? "apu" : "mixed";
}

/** Totals for one set of sums; `fillW` is the watts gaps are estimated at. */
function totalsOf(
  x: Sums,
  fillW: number | null,
  s: PowerSettings,
): PowerTotals {
  if (x.effectiveS === 0) {
    return {
      effectiveS: 0,
      measuredS: 0,
      coverage: null,
      measuredKwh: 0,
      wallKwh: 0,
      modelledKwh: 0,
      estimatedKwh: 0,
      totalKwh: 0,
      avgW: null,
      wallCoverage: null,
      source: null,
      peakW: null,
      electricityUsd: null,
      tokens: { ...EMPTY_TOKENS },
      cloudUsd: null,
      unpricedRequests: 0,
      savingsUsd: null,
      electricityPer1mOutputUsd: null,
      cloudPer1mOutputUsd: null,
      kinds: [],
    };
  }
  const measuredS = x.wallS + x.apuS;
  const measuredWs = x.wallWs + x.modelledWs;
  const wallKwh = x.wallWs / WS_PER_KWH;
  const modelledKwh = x.modelledWs / WS_PER_KWH;
  const gapS = Math.max(x.effectiveS - measuredS, 0);
  const estimatedKwh = fillW === null ? 0 : (fillW * gapS) / WS_PER_KWH;
  const totalKwh = wallKwh + modelledKwh + estimatedKwh;
  const electricityUsd =
    s.pricePerKwhUsd === undefined ? null : totalKwh * s.pricePerKwhUsd;
  const cloudUsd = cloudOrNull(x.cloud.usd, x.tokens, x.cloud.unpriced);
  // [fork] W17: all of the energy is split by these sums' own busy time, so
  // a range's kinds add up to its total (not the sum of per-period splits).
  const shares = attributeEnergy(x.kinds, totalKwh, electricityUsd);
  return {
    effectiveS: x.effectiveS,
    measuredS,
    coverage: measuredS / x.effectiveS,
    measuredKwh: wallKwh + modelledKwh,
    wallKwh,
    modelledKwh,
    estimatedKwh,
    totalKwh,
    avgW: measuredS > 0 ? measuredWs / measuredS : null,
    wallCoverage: measuredS > 0 ? x.wallS / measuredS : null,
    source: sourceOf(x.wallS, measuredS),
    peakW: x.peakW,
    electricityUsd,
    tokens: x.tokens,
    cloudUsd,
    unpricedRequests: x.cloud.unpriced,
    savingsUsd:
      cloudUsd === null || electricityUsd === null
        ? null
        : cloudUsd - electricityUsd,
    electricityPer1mOutputUsd: per1mOutput(
      outputKindsUsd(shares),
      x.tokens.output,
    ),
    cloudPer1mOutputUsd: per1mOutput(cloudUsd, x.tokens.output),
    kinds: kindEnergy(shares),
  };
}

const maxOrNull = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);

/** A period's sums with its APU-only time priced through `model`. */
function periodSums(
  p: PeriodRaw,
  effectiveS: number,
  model: FallbackModel,
): Sums {
  return {
    effectiveS,
    wallWs: p.wallWs,
    wallS: p.wallS,
    // linear model: k × (Σ apu W·s) + c × apu seconds
    modelledWs: model.k * p.apuWs + model.c * p.apuS,
    apuS: p.apuS,
    peakW: maxOrNull(
      p.wallPeakW,
      p.apuPeakW === null ? null : modelWatts(model, p.apuPeakW),
    ),
    tokens: p.tokens,
    cloud: { usd: p.cloudUsd, unpriced: p.unpricedRequests },
    kinds: p.kinds,
  };
}

function addSums(a: Sums, b: Sums): Sums {
  return {
    effectiveS: a.effectiveS + b.effectiveS,
    wallWs: a.wallWs + b.wallWs,
    wallS: a.wallS + b.wallS,
    modelledWs: a.modelledWs + b.modelledWs,
    apuS: a.apuS + b.apuS,
    peakW: maxOrNull(a.peakW, b.peakW),
    tokens: addTokens(a.tokens, b.tokens),
    cloud: {
      usd: a.cloud.usd + b.cloud.usd,
      unpriced: a.cloud.unpriced + b.cloud.unpriced,
    },
    kinds: addKindBusy(a.kinds, b.kinds),
  };
}

const EMPTY_SUMS: Sums = {
  effectiveS: 0,
  wallWs: 0,
  wallS: 0,
  modelledWs: 0,
  apuS: 0,
  peakW: null,
  tokens: { ...EMPTY_TOKENS },
  cloud: { usd: 0, unpriced: 0 },
  kinds: [],
};

/**
 * Per-period and overall totals. Gaps in every period are estimated at the
 * measured average over all periods, so the periods add up to the totals.
 */
export function summarize(
  periods: PeriodRaw[],
  dataStart: number | null,
  now: number,
  s: PowerSettings,
  model: FallbackModel,
): { totals: PowerTotals; periods: PeriodTotals[] } {
  const live = periods.map((p) =>
    periodSums(p, effectiveSeconds(p, dataStart, now), model),
  );
  const all = live.filter((x) => x.effectiveS > 0).reduce(addSums, EMPTY_SUMS);
  const measuredS = all.wallS + all.apuS;
  const fillW =
    measuredS > 0 ? (all.wallWs + all.modelledWs) / measuredS : null;
  return {
    totals: totalsOf(all, fillW, s),
    periods: periods.map((p, i) => ({
      start: p.start,
      end: p.end,
      ...totalsOf(live[i], fillW, s),
    })),
  };
}

/** Electricity so far plus the rest of the range at the current average draw. */
export function projectUsd(
  totals: PowerTotals,
  remainingS: number,
  s: PowerSettings,
): number | null {
  const price = s.pricePerKwhUsd;
  if (price === undefined) return null;
  if (totals.electricityUsd === null || totals.avgW === null) return null;
  return (
    totals.electricityUsd + ((totals.avgW * remainingS) / WS_PER_KWH) * price
  );
}

/**
 * Typical idle draw and its monthly cost: the wall p10 when at least half the
 * window's buckets were fully wall-measured, else the APU p10 through `model`.
 */
export function idleFloor(
  idle: IdleStats,
  model: FallbackModel,
  s: PowerSettings,
): { watts: number; monthlyUsd: number | null } | null {
  const useWall =
    idle.wallP10W !== null && idle.wallBuckets * 2 >= idle.buckets;
  const watts = useWall
    ? idle.wallP10W
    : idle.apuP10W === null
      ? null
      : modelWatts(model, idle.apuP10W);
  if (watts === null) return null;
  return {
    watts,
    monthlyUsd:
      s.pricePerKwhUsd === undefined
        ? null
        : ((watts * HOURS_PER_MONTH) / 1000) * s.pricePerKwhUsd,
  };
}
