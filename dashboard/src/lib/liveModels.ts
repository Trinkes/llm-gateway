// [fork] W22: helpers for the Live page's per-model busy chart and table.
// Models, labels and units come from the API; nothing here names a model.
import type { ModelActivity } from "./api";
import { formatUsage } from "./requestKinds";

/** Series colours, assigned by sorted series key so they stay put across polls. */
export const MODEL_COLORS = [
  "#f59e0b",
  "#3b82f6",
  "#10b981",
  "#a855f7",
  "#ef4444",
  "#14b8a6",
  "#ec4899",
  "#64748b",
] as const;

/** `provider|kind` (empty kind for an idle provider): the chart's data key. */
export function modelSeriesKey(m: ModelActivity): string {
  return `${m.provider}|${m.kind ?? ""}`;
}

/** The colour of `key` among `keys`, by its position once sorted. */
export function modelColor(key: string, keys: string[]): string {
  const i = [...keys].sort().indexOf(key);
  return MODEL_COLORS[Math.max(0, i) % MODEL_COLORS.length];
}

/** One chart point per bucket (`t` in ms) with each model's busy value under its key. */
export function modelChartPoints(
  models: ModelActivity[],
): Array<{ t: number } & Record<string, number>> {
  const points = new Map<number, { t: number } & Record<string, number>>();
  for (const m of models) {
    const key = modelSeriesKey(m);
    for (const p of m.busy) {
      const point =
        points.get(p.ts) ??
        ({ t: p.ts * 1000 } as {
          t: number;
        } & Record<string, number>);
      point[key] = p.busy;
      points.set(p.ts, point);
    }
  }
  return [...points.values()].sort((a, b) => a.t - b.t);
}

/** Finished requests per minute over a `windowS`-second window. */
export function requestsPerMin(m: ModelActivity, windowS: number): number {
  return windowS > 0 ? m.requests / (windowS / 60) : 0;
}

/** Output in the model's unit ("1.2K / 300", "3 images"); "—" without a unit. */
export function modelUsage(m: ModelActivity): string {
  if (m.kind === null || m.unit === null) return "—";
  return formatUsage(m.unit, {
    tokensInput: m.tokensInput,
    tokensOutput: m.tokensOutput,
    units: m.units,
  });
}

/** "1.2", "0" when idle, "<0.1" for a rate that would round to 0.0. */
export function fmtRate(perMin: number): string {
  if (perMin === 0) return "0";
  if (perMin < 0.05) return "<0.1";
  return perMin.toFixed(1);
}

/** Seconds the models' busy series covers (stored ranges stop where the cron got to). */
export function modelsWindowS(
  models: ModelActivity[],
  bucketS: number,
): number {
  return (models[0]?.busy.length ?? 0) * bucketS;
}
