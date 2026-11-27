// [fork] W17: measured energy split across request kinds by busy time
// (Σ latency of successful, non-cached box requests). Overlapping requests
// over-count busy time, so the split is approximate.
import { kindInfo, type KindUnit } from "../metrics/request-kinds";

/** One kind's busy time in a period, as read from D1. */
export interface KindBusy {
  kind: string;
  requests: number;
  /** Sum of the kind's own unit count (images); 0 for token kinds. */
  units: number;
  /** Output tokens: the per-1M base of token kinds that generate. */
  output: number;
  /** Input tokens: the per-1M base of token kinds without output (embeddings). */
  input: number;
  busySeconds: number;
}

/** One kind's share of a range's energy and its cost per unit. */
export interface KindEnergy {
  kind: string;
  unit: KindUnit;
  label: string;
  requests: number;
  units: number;
  /** Token kinds' own token counts (0 for other kinds). */
  tokensInput: number;
  tokensOutput: number;
  busySeconds: number;
  /** busySeconds over every kind's busy seconds. */
  share: number;
  kwh: number;
  /** Null without a kWh price. */
  electricityUsd: number | null;
  /**
   * Per 1M output tokens (per 1M input tokens for a token kind without
   * output), per image, or per request (null unit).
   */
  perUnitUsd: number | null;
  /** What `perUnitUsd` is priced per; null when it is null. */
  perUnit: PerUnit | null;
}

/** The pricing basis of a kind's `perUnitUsd`, so clients never infer it. */
export type PerUnit =
  "1M output tokens" | "1M input tokens" | "image" | "request";

/** A kind's busy sums with its attributed energy. */
export interface KindShare extends KindBusy {
  kwh: number;
  electricityUsd: number | null;
}

const busyOf = (kinds: KindBusy[]) =>
  kinds.reduce((sum, k) => sum + k.busySeconds, 0);

/** Split `kwh` and `electricityUsd` by busy share; nothing when nothing was busy. */
export function attributeEnergy(
  kinds: KindBusy[],
  kwh: number,
  electricityUsd: number | null,
): KindShare[] {
  const busy = busyOf(kinds);
  if (busy === 0) return [];
  return kinds.map((k) => {
    const share = k.busySeconds / busy;
    return {
      ...k,
      kwh: kwh * share,
      electricityUsd: electricityUsd === null ? null : electricityUsd * share,
    };
  });
}

/**
 * Per-kind busy sums of two sets, so a range's energy is split by the
 * range's own busy time (its kWh then add up to the range's total).
 */
export function addKindBusy(a: KindBusy[], b: KindBusy[]): KindBusy[] {
  const byKind = new Map<string, KindBusy>();
  for (const k of [...a, ...b]) {
    const seen = byKind.get(k.kind);
    byKind.set(
      k.kind,
      seen
        ? {
            kind: k.kind,
            requests: seen.requests + k.requests,
            units: seen.units + k.units,
            output: seen.output + k.output,
            input: seen.input + k.input,
            busySeconds: seen.busySeconds + k.busySeconds,
          }
        : { ...k },
    );
  }
  return [...byKind.values()];
}

/** The count a kind's electricity is divided by, and the scale of the result. */
function unitBase(k: KindShare, unit: KindUnit): [number, number, PerUnit] {
  if (unit === "tokens") {
    return k.output > 0
      ? [k.output, 1e6, "1M output tokens"]
      : [k.input, 1e6, "1M input tokens"];
  }
  return unit === "images" ? [k.units, 1, "image"] : [k.requests, 1, "request"];
}

function perUnitCost(
  k: KindShare,
  unit: KindUnit,
): { perUnitUsd: number | null; perUnit: PerUnit | null } {
  const [base, scale, perUnit] = unitBase(k, unit);
  if (k.electricityUsd === null || base === 0) {
    return { perUnitUsd: null, perUnit: null };
  }
  return { perUnitUsd: (k.electricityUsd / base) * scale, perUnit };
}

/** The API rows: unit and label attached, busiest kind first. */
export function kindEnergy(shares: KindShare[]): KindEnergy[] {
  const busy = busyOf(shares);
  return shares
    .map((k) => {
      const { unit, label } = kindInfo(k.kind);
      return {
        kind: k.kind,
        unit,
        label,
        requests: k.requests,
        units: k.units,
        tokensInput: k.input,
        tokensOutput: k.output,
        busySeconds: k.busySeconds,
        share: k.busySeconds / busy,
        kwh: k.kwh,
        electricityUsd: k.electricityUsd,
        ...perUnitCost(k, unit),
      };
    })
    .sort(
      (a, b) => b.busySeconds - a.busySeconds || a.kind.localeCompare(b.kind),
    );
}

/** The token kinds that produced output (embeddings excluded). */
function outputKinds(shares: KindShare[]): KindShare[] {
  return shares.filter(
    (k) => k.output > 0 && kindInfo(k.kind).unit === "tokens",
  );
}

/**
 * Electricity of the token kinds that produced output (embeddings excluded):
 * the base of the per-1M-output figure. Null without a price or such kinds.
 */
export function outputKindsUsd(shares: KindShare[]): number | null {
  const kinds = outputKinds(shares);
  if (kinds.length === 0) return null;
  let usd = 0;
  for (const k of kinds) {
    if (k.electricityUsd === null) return null;
    usd += k.electricityUsd;
  }
  return usd;
}

/** Output tokens of the same kinds as `outputKindsUsd`: its denominator. */
export function outputKindsTokens(shares: KindShare[]): number {
  return outputKinds(shares).reduce((sum, k) => sum + k.output, 0);
}
