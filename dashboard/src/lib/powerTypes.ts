// [fork] W13: shapes of the /api/power responses (mirror of src/power/*).
import type { KindUnit } from "./requestKinds";

/** A model_pricing row the box's tokens are priced from (USD per 1M). */
export interface CloudRate {
  provider: string;
  model: string;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number;
  cacheWritePer1m: number;
}

export interface PowerSettings {
  pricePerKwhUsd?: number;
  overheadW?: number;
}

/** A settings update: `null` clears a field. */
export type PowerSettingsPatch = {
  [K in keyof PowerSettings]?: PowerSettings[K] | null;
};

export interface TokenSums {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

/** [fork] W17: one request kind's share of the box's energy (src/power/kind-energy.ts). */
export interface KindEnergy {
  kind: string;
  unit: KindUnit;
  label: string;
  requests: number;
  units: number;
  busySeconds: number;
  /** Share of all kinds' busy seconds, 0..1. */
  share: number;
  kwh: number;
  electricityUsd: number | null;
  perUnitUsd: number | null;
  /** What perUnitUsd is priced per ("1M output tokens", "image", ...); null with it. */
  perUnit: string | null;
}

export interface PowerTotals {
  effectiveS: number;
  measuredS: number;
  coverage: number | null;
  /** wallKwh + modelledKwh. */
  measuredKwh: number;
  /** [fork] W14: read by the wall meter. */
  wallKwh: number;
  /** Measured time without a wall reading, through the fallback model. */
  modelledKwh: number;
  estimatedKwh: number;
  totalKwh: number;
  /** Average wall watts over measured time (wall and modelled). */
  avgW: number | null;
  wallCoverage: number | null;
  source: "wall" | "apu" | "mixed" | null;
  peakW: number | null;
  electricityUsd: number | null;
  tokens: TokenSums;
  cloudUsd: number | null;
  unpricedRequests: number;
  savingsUsd: number | null;
  electricityPer1mOutputUsd: number | null;
  cloudPer1mOutputUsd: number | null;
  /** [fork] W17: energy split by request kind. */
  kinds: KindEnergy[];
}

/** [fork] W14: how APU-only time is turned into wall watts. */
export interface FallbackModel {
  kind: "fit" | "offset" | "setting";
  k: number;
  c: number;
  pairs: number;
  windowDays: number;
}

export type PeriodTotals = PowerTotals & { start: number; end: number };

export interface PowerReport {
  from: number;
  to: number;
  tz: string;
  dataStart: number | null;
  settings: PowerSettings;
  cloudRates: CloudRate[];
  fallbackModel: FallbackModel;
  totals: PowerTotals;
  days: PeriodTotals[];
  projectionUsd: number | null;
  idleFloor: { watts: number; monthlyUsd: number | null } | null;
}

export interface PowerMonths {
  tz: string;
  dataStart: number | null;
  settings: PowerSettings;
  cloudRates: CloudRate[];
  fallbackModel: FallbackModel;
  months: PeriodTotals[];
}
