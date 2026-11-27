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
  /** Output tokens: the per-1M base of token kinds. */
  output: number;
  busySeconds: number;
}

/** One kind's share of a range's energy and its cost per unit. */
export interface KindEnergy {
  kind: string;
  unit: KindUnit;
  label: string;
  requests: number;
  units: number;
  busySeconds: number;
  /** busySeconds over every kind's busy seconds. */
  share: number;
  kwh: number;
  /** Null without a kWh price. */
  electricityUsd: number | null;
  /** Per 1M output tokens, per image, or per request (null unit). */
  perUnitUsd: number | null;
}

/** A kind's busy sums with its attributed energy; adds up across periods. */
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

const addUsd = (a: number | null, b: number | null) =>
  a === null || b === null ? null : a + b;

/** Per-kind sums over several periods' shares. */
export function addKindShares(lists: KindShare[][]): KindShare[] {
  const byKind = new Map<string, KindShare>();
  for (const k of lists.flat()) {
    const seen = byKind.get(k.kind);
    byKind.set(
      k.kind,
      seen
        ? {
            kind: k.kind,
            requests: seen.requests + k.requests,
            units: seen.units + k.units,
            output: seen.output + k.output,
            busySeconds: seen.busySeconds + k.busySeconds,
            kwh: seen.kwh + k.kwh,
            electricityUsd: addUsd(seen.electricityUsd, k.electricityUsd),
          }
        : { ...k },
    );
  }
  return [...byKind.values()];
}

function perUnitUsd(k: KindShare, unit: KindUnit): number | null {
  if (k.electricityUsd === null) return null;
  const base =
    unit === "tokens" ? k.output : unit === "images" ? k.units : k.requests;
  if (base === 0) return null;
  return (k.electricityUsd / base) * (unit === "tokens" ? 1e6 : 1);
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
        busySeconds: k.busySeconds,
        share: k.busySeconds / busy,
        kwh: k.kwh,
        electricityUsd: k.electricityUsd,
        perUnitUsd: perUnitUsd(k, unit),
      };
    })
    .sort(
      (a, b) => b.busySeconds - a.busySeconds || a.kind.localeCompare(b.kind),
    );
}

/** Electricity of the token kinds; null without a price or token kinds. */
export function tokenKindsUsd(shares: KindShare[]): number | null {
  const tokens = shares.filter((k) => kindInfo(k.kind).unit === "tokens");
  if (tokens.length === 0) return null;
  return tokens.reduce<number | null>(
    (sum, k) => addUsd(sum, k.electricityUsd),
    0,
  );
}
