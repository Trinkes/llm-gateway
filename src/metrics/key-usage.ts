import { kindInfo, type KindUnit } from "./request-kinds";

/** Usage totals for one API key (GET /api/metrics/keys). */
export interface KeyUsage {
  /** Null for traffic without a key (dashboard sessions). */
  apiKeyId: string | null;
  /** Null when the key was deleted or the row has no key. */
  name: string | null;
  keyPrefix: string | null;
  status: string | null;
  requests: number;
  /** Requests with status >= 400. */
  errors: number;
  /** Uncached input tokens; cache reads are reported separately. */
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  costUsd: number;
  latencyAvgMs: number;
  /** Unix seconds of the newest request in the window. */
  lastRequestAt: number;
  /** [fork] W17: requests and units per request kind. */
  kinds: KeyKindUsage[];
}

/** [fork] W17 */
export interface KeyKindUsage {
  kind: string;
  unit: KindUnit;
  label: string;
  requests: number;
  units: number;
}

interface KeyKindRow {
  api_key_id: string | null;
  kind: string;
  requests: number;
  units: number | null;
}

interface KeyUsageRow {
  api_key_id: string | null;
  name: string | null;
  key_prefix: string | null;
  status: string | null;
  requests: number;
  errors: number;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  cost_usd: number;
  latency_avg_ms: number;
  last_request_at: number;
}

/**
 * Requests, tokens, cost, errors and average latency per API key over
 * [start, end), busiest first, keyless traffic last. One round trip: the
 * totals and the per-kind split go to D1 in one batch.
 */
export async function usageByKey(
  env: Env,
  organizationId: string,
  start: number,
  end: number,
): Promise<KeyUsage[]> {
  const scope = "organization_id = ? AND timestamp >= ? AND timestamp < ?";
  const [totals, kinds] = await env.DB.batch([
    env.DB.prepare(
      `SELECT m.api_key_id, k.name, k.key_prefix, k.status,
            COUNT(*) AS requests,
            SUM(CASE WHEN m.status_code >= 400 THEN 1 ELSE 0 END) AS errors,
            COALESCE(SUM(m.tokens_input), 0) AS tokens_input,
            COALESCE(SUM(m.tokens_output), 0) AS tokens_output,
            COALESCE(SUM(m.tokens_cache_read), 0) AS tokens_cache_read,
            COALESCE(SUM(m.cost_usd), 0) AS cost_usd,
            ROUND(AVG(m.latency_ms)) AS latency_avg_ms,
            MAX(m.timestamp) AS last_request_at
     FROM request_metrics m
     LEFT JOIN api_keys k
       ON k.id = m.api_key_id AND k.organization_id = m.organization_id
     WHERE m.organization_id = ? AND m.timestamp >= ? AND m.timestamp < ?
     GROUP BY m.api_key_id
     ORDER BY m.api_key_id IS NULL, requests DESC, tokens_input DESC`,
    ).bind(organizationId, start, end),
    // [fork] W17: per key + kind.
    env.DB.prepare(
      `SELECT api_key_id, method AS kind, COUNT(*) AS requests,
              SUM(units) AS units
       FROM request_metrics WHERE ${scope}
       GROUP BY api_key_id, method ORDER BY requests DESC, method`,
    ).bind(organizationId, start, end),
  ]);

  const byKey = new Map<string | null, KeyKindUsage[]>();
  for (const r of kinds.results as unknown as KeyKindRow[]) {
    const list = byKey.get(r.api_key_id) ?? [];
    list.push({
      ...kindInfo(r.kind),
      requests: r.requests,
      units: r.units ?? 0,
    });
    byKey.set(r.api_key_id, list);
  }

  return (totals.results as unknown as KeyUsageRow[]).map((row) => ({
    apiKeyId: row.api_key_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    status: row.status,
    requests: row.requests,
    errors: row.errors,
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    tokensCacheRead: row.tokens_cache_read,
    costUsd: row.cost_usd,
    latencyAvgMs: row.latency_avg_ms,
    lastRequestAt: row.last_request_at,
    // same batch and scope as the totals: every key has its kind rows
    kinds: byKey.get(row.api_key_id)!,
  }));
}
