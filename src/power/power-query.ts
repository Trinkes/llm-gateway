// [fork] W13: one batched read of everything the Power page needs.
// Energy comes from host_samples: 10-minute rollups (pro rata at unaligned
// range edges), with raw 10 s rows used for buckets that have no rollup.
// Tokens come from the org's box requests in request_metrics, priced at their
// model_pricing rates for the cloud comparison.
// [fork] W14: wall-meter time and APU-only time are summed apart, so the
// summary can price APU-only time with the fallback model; the same batch
// reads the model's least-squares sums.
import { hostBinding } from "../live/sources";
import { vpcBindingNames } from "../llm/transport";
import type { ModelPricing } from "../metrics/cost-tracker";
import { safeJsonParse } from "../utils/crypto";
import { FIT_WINDOW_S, type PairSums } from "./fallback-model";
import type { Period } from "./periods";
import type { PowerSettings } from "./power-settings";
import type { PeriodRaw, TokenSums } from "./power-summary";

const ROLLUP_S = 600;
const RAW_S = 10;
const IDLE_WINDOW_S = 30 * 86400;
/** Raw 10 s rows are pruned after 30 days (history-cron). */
const RAW_RETENTION_S = 30 * 86400;

export interface PowerData {
  settings: PowerSettings;
  /** First stored host sample of the org's box; null when there is none. */
  dataStart: number | null;
  periods: PeriodRaw[];
  /** p10 of 10-minute averages over the last 30 days, per source. */
  idle: IdleStats;
  /** Least-squares sums over fully wall-measured buckets of the last 7 days. */
  pairs: PairSums;
  /** model_pricing rows of the box's providers: the cloud comparison rates. */
  cloudRates: ModelPricing[];
}

export interface IdleStats {
  /** p10 wall watts over fully wall-measured buckets. */
  wallP10W: number | null;
  wallBuckets: number;
  /** p10 APU watts over the other buckets. */
  apuP10W: number | null;
  /** All buckets with samples in the window. */
  buckets: number;
}

interface EnergyRow {
  i: number;
  wall_ws: number;
  wall_secs: number;
  apu_ws: number;
  apu_secs: number;
  wall_peak: number | null;
  apu_peak: number | null;
}

interface PairRow {
  n: number;
  sx: number;
  sy: number;
  sxy: number;
  sxx: number;
  min_x: number | null;
  max_x: number | null;
}

interface TokenRow {
  i: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  requests: number;
  cloud_usd: number;
  unpriced: number;
}

interface RateRow {
  provider: string;
  model: string;
  input_per_1m: number;
  output_per_1m: number;
  cache_read_per_1m: number;
  cache_write_per_1m: number;
}

const PERIODS_CTE = `p AS (
  SELECT CAST(key AS INTEGER) AS i,
         json_extract(value, '$[0]') AS s,
         json_extract(value, '$[1]') AS e
    FROM json_each(?1))`;

/** First host sample: two primary-key seeks (one per resolution), not a scan. */
const dataStartSql = (binding: string) => `SELECT MIN(m) AS first FROM (
    SELECT MIN(ts) AS m FROM host_samples
     WHERE binding = ${binding} AND resolution_s = ${ROLLUP_S}
    UNION ALL
    SELECT MIN(ts) FROM host_samples
     WHERE binding = ${binding} AND resolution_s = ${RAW_S})`;

// Rollups overlapping each period, counted pro rata at unaligned edges. The
// CROSS JOIN keeps the periods as the outer loop so each period is one
// primary-key range seek on host_samples.
const OVERLAP = `(MIN(h.ts + ${ROLLUP_S}, p.e) - MAX(h.ts, p.s)) * 1.0 / ${ROLLUP_S}`;
// Wall rows: wall_samples of them at wall_power_w. APU-only rows: the rest of
// `samples`, at apu_only_power_w (their own APU average); rollups written
// before wall_samples existed (NULL) are all APU-only at gpu_power_w.
const WALL_N = "COALESCE(h.wall_samples, 0)";
const APU_N = `(h.samples - ${WALL_N})`;
const APU_W =
  "CASE WHEN h.wall_samples IS NULL THEN h.gpu_power_w ELSE h.apu_only_power_w END";
const ROLLUP_ENERGY_SQL = `WITH ${PERIODS_CTE}
SELECT p.i,
       COALESCE(SUM(h.wall_power_w * ${WALL_N} * ${RAW_S} * ${OVERLAP}), 0) AS wall_ws,
       COALESCE(SUM(CASE WHEN h.wall_power_w IS NOT NULL
                         THEN ${WALL_N} * ${RAW_S} * ${OVERLAP} END), 0) AS wall_secs,
       COALESCE(SUM(${APU_W} * ${APU_N} * ${RAW_S} * ${OVERLAP}), 0) AS apu_ws,
       COALESCE(SUM(CASE WHEN ${APU_W} IS NOT NULL
                         THEN ${APU_N} * ${RAW_S} * ${OVERLAP} END), 0) AS apu_secs,
       MAX(h.wall_power_w_max) AS wall_peak,
       MAX(CASE WHEN ${APU_N} > 0 AND ${APU_W} IS NOT NULL
                THEN COALESCE(h.gpu_power_w_max, h.gpu_power_w) END) AS apu_peak
  FROM p
  CROSS JOIN host_samples h
    ON h.binding = ?2 AND h.resolution_s = ${ROLLUP_S}
   AND h.ts > p.s - ${ROLLUP_S} AND h.ts < p.e
 WHERE h.samples > 0
 GROUP BY p.i`;

// Raw 10 s rows, read only for buckets that have no rollup (the unfinished
// bucket, or one a long cron outage skipped), within raw retention [?3, ?4).
const RAW_ENERGY_SQL = `WITH RECURSIVE ${PERIODS_CTE},
b(t) AS (
  SELECT ?3 WHERE ?3 < ?4
  UNION ALL
  SELECT t + ${ROLLUP_S} FROM b WHERE t + ${ROLLUP_S} < ?4),
missing AS (
  SELECT t FROM b
   WHERE NOT EXISTS (
     SELECT 1 FROM host_samples x
      WHERE x.binding = ?2 AND x.resolution_s = ${ROLLUP_S} AND x.ts = b.t)),
raw AS (
  SELECT h.ts, h.gpu_power_w AS w, h.wall_power_w AS ww
    FROM missing m
    CROSS JOIN host_samples h
      ON h.binding = ?2 AND h.resolution_s = ${RAW_S}
     AND h.ts >= m.t AND h.ts < m.t + ${ROLLUP_S}
   WHERE h.ok = 1 AND (h.wall_power_w IS NOT NULL OR h.gpu_power_w IS NOT NULL))
SELECT p.i,
       COALESCE(SUM(raw.ww * ${RAW_S}), 0) AS wall_ws,
       COUNT(raw.ww) * ${RAW_S} AS wall_secs,
       COALESCE(SUM(CASE WHEN raw.ww IS NULL THEN raw.w * ${RAW_S} END), 0) AS apu_ws,
       COUNT(CASE WHEN raw.ww IS NULL THEN 1 END) * ${RAW_S} AS apu_secs,
       MAX(raw.ww) AS wall_peak,
       MAX(CASE WHEN raw.ww IS NULL THEN raw.w END) AS apu_peak
  FROM p JOIN raw ON raw.ts >= p.s AND raw.ts < p.e
 GROUP BY p.i`;

/** The org's providers that reach the box over VPC (`org` = org id, `bindings` = JSON array of binding names). */
const boxProvidersSql = (org: string, bindings: string) => `
  SELECT provider FROM provider_configs
   WHERE organization_id = ${org}
     AND json_extract(config, '$.settings.transport') = 'vpc'
     AND json_extract(config, '$.settings.vpcBinding')
         IN (SELECT value FROM json_each(${bindings}))`;

// Each request is priced from model_pricing like getModelPricing: the exact
// model row, else the provider's '*' row. Requests with neither are counted as
// unpriced instead of getting the hard-coded default.
const rate = (col: string) => `COALESCE(pe.${col}, pw.${col})`;
const TOKENS_SQL = `WITH ${PERIODS_CTE},
m AS (
  SELECT r.timestamp AS ts, COALESCE(r.tokens_input, 0) AS input,
         COALESCE(r.tokens_output, 0) AS output,
         COALESCE(r.tokens_cache_read, 0) AS cache_read,
         COALESCE(r.tokens_cache_write, 0) AS cache_write,
         ${rate("input_per_1m")} AS in_rate,
         ${rate("output_per_1m")} AS out_rate,
         ${rate("cache_read_per_1m")} AS cr_rate,
         ${rate("cache_write_per_1m")} AS cw_rate
    FROM request_metrics r
    LEFT JOIN model_pricing pe ON pe.provider = r.provider AND pe.model = r.model
    LEFT JOIN model_pricing pw ON pw.provider = r.provider AND pw.model = '*'
   WHERE r.organization_id = ?2 AND r.timestamp >= ?3 AND r.timestamp < ?4
     AND r.status_code < 400 AND COALESCE(r.cache_hit, 0) = 0
     AND r.timestamp >= (${dataStartSql("?5")})
     AND r.provider IN (${boxProvidersSql("?2", "?6")}))
SELECT p.i, COALESCE(SUM(m.input), 0) AS input, COALESCE(SUM(m.output), 0) AS output,
       COALESCE(SUM(m.cache_read), 0) AS cache_read,
       COALESCE(SUM(m.cache_write), 0) AS cache_write, COUNT(m.ts) AS requests,
       COALESCE(SUM((m.input * m.in_rate + m.output * m.out_rate
                     + m.cache_read * m.cr_rate + m.cache_write * m.cw_rate) / 1e6), 0)
         AS cloud_usd,
       COUNT(m.ts) - COUNT(m.in_rate) AS unpriced
  FROM p LEFT JOIN m ON m.ts >= p.s AND m.ts < p.e
 GROUP BY p.i`;

/** The model_pricing rows the box's requests can be priced from. */
const RATES_SQL = `SELECT provider, model, input_per_1m, output_per_1m,
       cache_read_per_1m, cache_write_per_1m
  FROM model_pricing
 WHERE provider IN (${boxProvidersSql("?1", "?2")})
 ORDER BY provider, model`;

// Nearest-rank p10 of 10-minute averages: wall watts over fully wall-measured
// buckets, APU watts over the rest, plus both bucket counts.
const IDLE_SQL = `WITH b AS (
  SELECT gpu_power_w AS g, wall_power_w AS wl,
         COALESCE(wall_samples = samples AND wall_power_w IS NOT NULL, 0) AS is_wall
    FROM host_samples
   WHERE binding = ?1 AND resolution_s = ${ROLLUP_S} AND samples > 0 AND ts >= ?2),
w AS (SELECT wl AS v, ROW_NUMBER() OVER (ORDER BY wl) AS rn, COUNT(*) OVER () AS n
        FROM b WHERE is_wall = 1),
a AS (SELECT g AS v, ROW_NUMBER() OVER (ORDER BY g) AS rn, COUNT(*) OVER () AS n
        FROM b WHERE is_wall = 0 AND g IS NOT NULL)
SELECT (SELECT v FROM w WHERE rn = (n + 9) / 10) AS wall_p10,
       (SELECT COUNT(*) FROM w) AS wall_buckets,
       (SELECT v FROM a WHERE rn = (n + 9) / 10) AS apu_p10,
       (SELECT COUNT(*) FROM b) AS buckets`;

// Least-squares sums for the fallback model: x = APU watts, y = wall watts,
// over buckets at least half full and entirely wall-measured.
const PAIRS_SQL = `SELECT COUNT(*) AS n,
       COALESCE(SUM(gpu_power_w), 0) AS sx,
       COALESCE(SUM(wall_power_w), 0) AS sy,
       COALESCE(SUM(gpu_power_w * wall_power_w), 0) AS sxy,
       COALESCE(SUM(gpu_power_w * gpu_power_w), 0) AS sxx,
       MIN(gpu_power_w) AS min_x, MAX(gpu_power_w) AS max_x
  FROM host_samples
 WHERE binding = ? AND resolution_s = ${ROLLUP_S} AND ts >= ?
   AND samples >= 30 AND wall_samples = samples
   AND gpu_power_w IS NOT NULL AND wall_power_w IS NOT NULL`;

const EMPTY_IDLE: IdleStats = {
  wallP10W: null,
  wallBuckets: 0,
  apuP10W: null,
  buckets: 0,
};

const EMPTY_PAIRS: PairSums = {
  n: 0,
  sx: 0,
  sy: 0,
  sxy: 0,
  sxx: 0,
  minX: null,
  maxX: null,
};

const EMPTY_TOKENS: TokenSums = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
};

function emptyPeriods(periods: Period[]): PeriodRaw[] {
  return periods.map((p) => ({
    start: p.start,
    end: p.end,
    wallWs: 0,
    wallS: 0,
    apuWs: 0,
    apuS: 0,
    wallPeakW: null,
    apuPeakW: null,
    tokens: { ...EMPTY_TOKENS },
    cloudUsd: 0,
    unpricedRequests: 0,
  }));
}

/** Settings, data start, per-period energy and tokens, and idle p10 in one round trip. */
export async function loadPowerData(
  env: Env,
  orgId: string,
  periods: Period[],
  now: number,
): Promise<PowerData> {
  const settingsStmt = env.DB.prepare(
    "SELECT value FROM tenant_settings WHERE organization_id = ? AND key = 'power'",
  ).bind(orgId);
  const host = hostBinding(env, orgId);
  if (!host || periods.length === 0) {
    const [settings] = await env.DB.batch<{ value: string }>([settingsStmt]);
    return {
      settings: parseSettings(settings.results[0]?.value),
      dataStart: null,
      periods: emptyPeriods(periods),
      idle: { ...EMPTY_IDLE },
      pairs: { ...EMPTY_PAIRS },
      cloudRates: [],
    };
  }

  const json = JSON.stringify(periods.map((p) => [p.start, p.end]));
  const from = Math.min(...periods.map((p) => p.start));
  const to = Math.max(...periods.map((p) => p.end));
  const rawFrom = Math.max(from, now - RAW_RETENTION_S);
  const bindings = JSON.stringify(vpcBindingNames(env, orgId));
  const [settings, first, rollups, raw, tokens, idle, pairs, rates] =
    await env.DB.batch<unknown>([
      settingsStmt,
      env.DB.prepare(dataStartSql("?1")).bind(host.name),
      env.DB.prepare(ROLLUP_ENERGY_SQL).bind(json, host.name),
      env.DB.prepare(RAW_ENERGY_SQL).bind(
        json,
        host.name,
        rawFrom - (rawFrom % ROLLUP_S),
        Math.min(to, now + ROLLUP_S),
      ),
      env.DB.prepare(TOKENS_SQL).bind(
        json,
        orgId,
        from,
        to,
        host.name,
        bindings,
      ),
      env.DB.prepare(IDLE_SQL).bind(host.name, now - IDLE_WINDOW_S),
      env.DB.prepare(PAIRS_SQL).bind(host.name, now - FIT_WINDOW_S),
      env.DB.prepare(RATES_SQL).bind(orgId, bindings),
    ]);

  const tokenRows = tokens.results as TokenRow[];
  const out = emptyPeriods(periods);
  for (const row of [...rollups.results, ...raw.results] as EnergyRow[]) {
    const p = out[row.i];
    p.wallWs += row.wall_ws;
    p.wallS += row.wall_secs;
    p.apuWs += row.apu_ws;
    p.apuS += row.apu_secs;
    p.wallPeakW = maxOrNull(p.wallPeakW, row.wall_peak);
    p.apuPeakW = maxOrNull(p.apuPeakW, row.apu_peak);
  }
  for (const row of tokenRows) {
    out[row.i].tokens = {
      input: row.input,
      output: row.output,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
      requests: row.requests,
    };
    out[row.i].cloudUsd = row.cloud_usd;
    out[row.i].unpricedRequests = row.unpriced;
  }
  return {
    settings: parseSettings(
      (settings.results[0] as { value: string } | undefined)?.value,
    ),
    dataStart:
      (first.results[0] as { first: number | null } | undefined)?.first ?? null,
    periods: out,
    idle: toIdle(idle.results[0] as IdleRow),
    pairs: toPairs(pairs.results[0] as PairRow),
    cloudRates: (rates.results as RateRow[]).map((r) => ({
      provider: r.provider,
      model: r.model,
      inputPer1m: r.input_per_1m,
      outputPer1m: r.output_per_1m,
      cacheReadPer1m: r.cache_read_per_1m,
      cacheWritePer1m: r.cache_write_per_1m,
    })),
  };
}

const maxOrNull = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);

interface IdleRow {
  wall_p10: number | null;
  wall_buckets: number;
  apu_p10: number | null;
  buckets: number;
}

function toIdle(r: IdleRow): IdleStats {
  return {
    wallP10W: r.wall_p10,
    wallBuckets: r.wall_buckets,
    apuP10W: r.apu_p10,
    buckets: r.buckets,
  };
}

function toPairs(r: PairRow): PairSums {
  return {
    n: r.n,
    sx: r.sx,
    sy: r.sy,
    sxy: r.sxy,
    sxx: r.sxx,
    minX: r.min_x,
    maxX: r.max_x,
  };
}

function parseSettings(value: string | undefined): PowerSettings {
  return safeJsonParse<PowerSettings>(value, {});
}
