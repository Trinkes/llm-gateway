// [fork] W17: kind-agnostic usage formatting. Kind names, labels and units come
// from API responses; only the unit values below are switched on.
import type { SelectOption } from "../components/ui";
import { fmtTokens } from "./format";

/** What a request kind is measured in; null for kinds without a known unit. */
export type KindUnit = "tokens" | "images" | null;

/** A kind with the unit and label the API attaches to it. */
export interface KindInfo {
  kind: string;
  unit: KindUnit;
  label: string;
}

/** Per-kind totals (mirror of src/metrics/kind-usage.ts). */
export interface KindUsage extends KindInfo {
  requests: number;
  errors: number;
  units: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  costUsd: number;
  latencyAvgMs: number | null;
  busySeconds: number;
}

/** The numbers a usage string is built from; unused ones may be missing. */
export interface UsageParts {
  tokensInput?: number | null;
  tokensOutput?: number | null;
  units?: number | null;
  latencyMs?: number | null;
}

/** "1.2K / 300" for tokens, "4 images" for images, "12.3 s" otherwise. */
export function formatUsage(unit: KindUnit, parts: UsageParts): string {
  if (unit === "tokens") {
    return `${fmtTokens(parts.tokensInput ?? 0)} / ${fmtTokens(parts.tokensOutput ?? 0)}`;
  }
  if (unit === "images") {
    const n = parts.units ?? 0;
    return `${n} ${n === 1 ? "image" : "images"}`;
  }
  if (parts.latencyMs === null || parts.latencyMs === undefined) return "—";
  return `${(parts.latencyMs / 1000).toFixed(1)} s`;
}

/** A request row's unit from its own counts (rows carry the kind, not the unit). */
export function rowUnit(row: {
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_cache_read?: number | null;
  tokens_cache_write?: number | null;
  units?: number | null;
}): KindUnit {
  const tokens =
    (row.tokens_input ?? 0) +
    (row.tokens_output ?? 0) +
    (row.tokens_cache_read ?? 0) +
    (row.tokens_cache_write ?? 0);
  if (tokens > 0) return "tokens";
  if ((row.units ?? 0) > 0) return "images";
  return null;
}

/** Usage text of one request-log row. */
export function formatRowUsage(row: {
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_cache_read?: number | null;
  tokens_cache_write?: number | null;
  units?: number | null;
  latency_ms?: number | null;
}): string {
  return formatUsage(rowUnit(row), {
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    units: row.units,
    latencyMs: row.latency_ms,
  });
}

/** Usage text of a per-kind total. */
export function formatKindUsage(k: KindUsage): string {
  return formatUsage(k.unit, {
    tokensInput: k.tokensInput,
    tokensOutput: k.tokensOutput,
    units: k.units,
    latencyMs: k.busySeconds * 1000,
  });
}

/** Dropdown options for the kinds present in facet rows. */
export function kindOptions(
  facets: { kind: string }[],
  labels: Record<string, string> = {},
): SelectOption[] {
  return [...new Set(facets.map((f) => f.kind))].map((kind) => ({
    value: kind,
    label: labels[kind] ?? kind,
  }));
}
