// [fork] W14: labels for where Power page energy came from.
import type { FallbackModel, PowerTotals } from "./powerTypes";

export function sourceLabel(
  source: PowerTotals["source"],
  wallCoverage: number | null,
): string {
  if (source === "wall") return "Wall meter";
  if (source === "apu") return "Estimated from APU";
  if (source === "mixed") {
    return `Mixed: ${Math.round((wallCoverage ?? 0) * 100)}% wall`;
  }
  return "No data";
}

export function modelLabel(m: FallbackModel): string {
  const window = `last ${m.windowDays} d`;
  if (m.kind === "fit") {
    return `Fallback: wall ≈ ${m.k.toFixed(2)} × APU + ${Math.round(m.c)} W (fit on ${m.pairs.toLocaleString("en-US")} pairs, ${window})`;
  }
  if (m.kind === "offset") {
    return `Fallback: APU + ${Math.round(m.c)} W (measured offset, ${window})`;
  }
  return "Fallback: manual overhead (not enough plug data)";
}
