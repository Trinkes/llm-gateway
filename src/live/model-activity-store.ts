// [fork] W22: stored 10-minute per-model activity (busy time and request
// stats per provider and kind), written by the throughput rollup cron so long
// Live ranges never read raw request rows.
import { modelKey, spreadBusy, type ModelRequest } from "./model-activity";

const SAMPLE_S = 10;
const ROLLUP_S = 600;

export interface ModelActivityRollup {
  provider: string;
  method: string;
  /** Bucket start, unix seconds. */
  ts: number;
  /** Mean of the bucket's 10 s busy values. */
  busy: number;
  busy_max: number;
  /** Requests that finished in the bucket (errors included). */
  requests: number;
  errors: number;
  /** Latency sum of the successful requests. */
  latency_ms_sum: number;
  tokens_input: number;
  tokens_output: number;
  units: number;
}

/**
 * One rollup per 600 s bucket of `[from, to)` for every (provider, method)
 * pair with any row in `rows`, skipping buckets with neither busy time nor
 * requests: readers treat a missing bucket as idle, and the daily 24 h
 * recompute stays far below D1's per-invocation query limit. `from` must be
 * a multiple of 600.
 */
export function rollupModelActivity(
  rows: ModelRequest[],
  from: number,
  to: number,
): ModelActivityRollup[] {
  const byKey = new Map<string, ModelRequest[]>();
  for (const r of rows) {
    const key = modelKey(r.provider, r.method);
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const perBucket = ROLLUP_S / SAMPLE_S;
  const buckets = Math.ceil((to - from) / ROLLUP_S);
  return [...byKey.values()].flatMap((group) => {
    const busy10s = spreadBusy(group, from, to, SAMPLE_S);
    return Array.from({ length: buckets }, (_, b) => {
      const ts = from + b * ROLLUP_S;
      const slots = busy10s.slice(b * perBucket, (b + 1) * perBucket);
      const finished = group.filter(
        (r) => r.timestamp >= ts && r.timestamp < ts + ROLLUP_S,
      );
      const ok = finished.filter((r) => r.status_code < 400);
      return {
        provider: group[0].provider,
        method: group[0].method,
        ts,
        busy: slots.reduce((s, v) => s + v, 0) / slots.length,
        busy_max: Math.max(...slots),
        requests: finished.length,
        errors: finished.length - ok.length,
        latency_ms_sum: ok.reduce((s, r) => s + r.latency_ms, 0),
        tokens_input: ok.reduce((s, r) => s + r.tokens_input, 0),
        tokens_output: ok.reduce((s, r) => s + r.tokens_output, 0),
        units: ok.reduce((s, r) => s + (r.units ?? 0), 0),
      };
    }).filter((r) => r.busy > 0 || r.requests > 0);
  });
}

/** `INSERT OR REPLACE` statements for `rollups`, for the caller's write batch. */
export function modelActivityWrites(
  env: Env,
  orgId: string,
  rollups: ModelActivityRollup[],
): D1PreparedStatement[] {
  const insert = env.DB.prepare(
    `INSERT OR REPLACE INTO model_activity_rollups
       (organization_id, provider, method, ts, busy, busy_max, requests,
        errors, latency_ms_sum, tokens_input, tokens_output, units)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return rollups.map((r) =>
    insert.bind(
      orgId,
      r.provider,
      r.method,
      r.ts,
      r.busy,
      r.busy_max,
      r.requests,
      r.errors,
      r.latency_ms_sum,
      r.tokens_input,
      r.tokens_output,
      r.units,
    ),
  );
}

/**
 * Stored rollups of `[from, to)` (bucket starts) for the org, every provider
 * that has any (removed ones included), oldest first.
 */
export function modelActivityRollupsStatement(
  env: Env,
  orgId: string,
  from: number,
  to: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT provider, method, ts, busy, busy_max, requests, errors,
            latency_ms_sum, tokens_input, tokens_output, units
       FROM model_activity_rollups
      WHERE organization_id = ? AND ts >= ? AND ts < ?
      ORDER BY ts, provider, method`,
  ).bind(orgId, from, to);
}
