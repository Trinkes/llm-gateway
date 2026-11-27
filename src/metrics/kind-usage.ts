import { kindInfo, type KindUnit } from "./request-kinds";

// [fork] W17: per-kind usage, so dashboards render any request kind from the
// unit and label attached here instead of a hardcoded list.
export interface KindUsage {
  kind: string;
  unit: KindUnit;
  label: string;
  requests: number;
  errors: number;
  /** Image count (or other non-token unit); 0 for token kinds. */
  units: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  costUsd: number;
  latencyAvgMs: number;
  /** Total time spent serving this kind, seconds. */
  busySeconds: number;
}

interface KindUsageRow {
  kind: string;
  requests: number;
  errors: number | null;
  units: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  cost_usd: number | null;
  latency_avg_ms: number | null;
  busy_ms: number | null;
}

/**
 * Per-kind totals as a statement for the caller's own `DB.batch`.
 * `whereSql` must use unqualified `request_metrics` columns.
 */
export function kindUsageStatement(
  env: Env,
  whereSql: string,
  params: (string | number)[],
): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT method AS kind,
            COUNT(*) AS requests,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
            SUM(units) AS units,
            SUM(tokens_input) AS tokens_input,
            SUM(tokens_output) AS tokens_output,
            SUM(tokens_cache_read) AS tokens_cache_read,
            SUM(cost_usd) AS cost_usd,
            ROUND(AVG(latency_ms)) AS latency_avg_ms,
            SUM(latency_ms) AS busy_ms
     FROM request_metrics WHERE ${whereSql}
     GROUP BY method ORDER BY requests DESC, method`,
  ).bind(...params);
}

export function toKindUsage(rows: unknown[]): KindUsage[] {
  return (rows as KindUsageRow[]).map((r) => ({
    ...kindInfo(r.kind),
    requests: r.requests,
    errors: r.errors ?? 0,
    units: r.units ?? 0,
    tokensInput: r.tokens_input ?? 0,
    tokensOutput: r.tokens_output ?? 0,
    tokensCacheRead: r.tokens_cache_read ?? 0,
    costUsd: r.cost_usd ?? 0,
    latencyAvgMs: r.latency_avg_ms ?? 0,
    busySeconds: (r.busy_ms ?? 0) / 1000,
  }));
}
