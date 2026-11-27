// [fork] W12: history and request-time sample reads.
import { createBoxTables } from "./box-schema";
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { queryHistory, historyBucket, sampleAt } from "~/src/live/sample-query";

const ORG = "org_q";
const e = {
  ...env,
  VPC_BINDINGS: `HALOGEN:${ORG}|org_other`,
  HOST_METRICS_BINDINGS: `BOXSTATS:${ORG}`,
  HALOGEN: { fetch: () => new Response("") },
  BOXSTATS: { fetch: () => new Response("") },
} as unknown as Env;

async function infRow(
  binding: string,
  res: number,
  ts: number,
  over: Record<string, number | string | null> = {},
) {
  const row = {
    ok: 1,
    samples: res === 600 ? 60 : null,
    slots: 4,
    in_flight: 1,
    queued: 0,
    in_flight_max: res === 600 ? 2 : null,
    ...over,
  };
  const cols = ["binding", "resolution_s", "ts", ...Object.keys(row)];
  await env.DB.prepare(
    `INSERT INTO inference_samples (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  )
    .bind(binding, res, ts, ...Object.values(row))
    .run();
}

async function hostRow(
  binding: string,
  res: number,
  ts: number,
  cpu: number,
  cpuMax: number | null = null,
) {
  await env.DB.prepare(
    `INSERT INTO host_samples (binding, resolution_s, ts, ok, samples, cpu_busy_pct, cpu_busy_pct_max)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(binding, res, ts, res === 600 ? 60 : null, cpu, cpuMax)
    .run();
}

async function config(org: string, provider: string, settings: object) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO provider_configs (id, organization_id, provider, config) VALUES (?, ?, ?, ?)",
  )
    .bind(
      `${org}-${provider}`,
      org,
      provider,
      JSON.stringify({ keys: [], settings }),
    )
    .run();
}

async function request(
  id: string,
  ts: number,
  latencyMs: number,
  provider = "box",
) {
  await env.DB.prepare(
    `INSERT INTO request_metrics
       (id, organization_id, timestamp, provider, model, method, status_code,
        latency_ms, tokens_input, tokens_output, cache_hit, ttft_ms, decode_ms)
     VALUES (?, ?, ?, ?, 'm', 'chat', 200, ?, 6000, 12000, 0, NULL, NULL)`,
  )
    .bind(id, ORG, ts, provider, latencyMs)
    .run();
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER, units INTEGER);",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS provider_configs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, UNIQUE(organization_id, provider));",
  );
  await createBoxTables(env.DB, [
    "inference_samples",
    "host_samples",
    "throughput_rollups",
    "model_activity_rollups",
  ]);
});

beforeEach(async () => {
  for (const t of [
    "inference_samples",
    "host_samples",
    "throughput_rollups",
    "model_activity_rollups",
    "request_metrics",
    "provider_configs",
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await config(ORG, "box", { transport: "vpc", vpcBinding: "HALOGEN" });
  await config(ORG, "openai", {});
  vi.restoreAllMocks();
});

describe("historyBucket", () => {
  it("is 10 s up to 2 h, then 10-minute multiples keeping <= 720 points", () => {
    expect(historyBucket(0, 3600)).toBe(10);
    expect(historyBucket(0, 7200)).toBe(10);
    expect(historyBucket(0, 7201)).toBe(600);
    expect(historyBucket(0, 7 * 86400)).toBe(1200);
    expect(historyBucket(0, 365 * 86400)).toBe(43800);
  });
});

describe("queryHistory", () => {
  it("short range reads 10 s rows", async () => {
    await infRow("HALOGEN", 10, 100, { in_flight: 3 });
    await infRow("HALOGEN", 10, 110, { ok: 0, slots: null, in_flight: null });
    await infRow("HALOGEN", 10, 5000); // outside
    await infRow("HALOGEN", 600, 0); // wrong resolution
    await hostRow("BOXSTATS", 10, 100, 42);
    const h = await queryHistory(e, ORG, 100, 3700);
    expect(h).toMatchObject({ from: 100, to: 3700, bucketS: 10 });
    expect(h.inference!.binding).toBe("HALOGEN");
    expect(h.inference!.points).toHaveLength(2);
    expect(h.inference!.points[0]).toMatchObject({
      ts: 100,
      ok: 1,
      samples: null,
      avg: { in_flight: 3, slots: 4 },
      max: {},
    });
    expect(h.inference!.points[1]).toMatchObject({
      ts: 110,
      ok: 0,
      avg: { in_flight: null },
    });
    expect(h.host!.binding).toBe("BOXSTATS");
    expect(h.host!.points).toHaveLength(1);
    expect(h.host!.points[0].avg.cpu_busy_pct).toBe(42);
  });

  it("long range reads 600 rows grouped", async () => {
    // from=0, to=7 days -> bucket 1200: rows 0 and 600 merge, 1200 is next.
    await infRow("HALOGEN", 600, 0, { in_flight: 1, in_flight_max: 5 });
    await infRow("HALOGEN", 600, 600, { in_flight: 3, in_flight_max: 9 });
    await infRow("HALOGEN", 600, 1200, { in_flight: 7, in_flight_max: 7 });
    await infRow("HALOGEN", 10, 10); // raw rows are ignored
    await hostRow("BOXSTATS", 600, 0, 10, 20);
    await hostRow("BOXSTATS", 600, 600, 30, 80);
    const h = await queryHistory(e, ORG, 0, 7 * 86400);
    expect(h.bucketS).toBe(1200);
    expect(h.inference!.points).toHaveLength(2);
    expect(h.inference!.points[0]).toMatchObject({
      ts: 0,
      ok: 1,
      samples: 120,
      avg: { in_flight: 2, slots: 4 },
      max: { in_flight: 9 },
    });
    expect(h.inference!.points[1]).toMatchObject({ ts: 1200, samples: 60 });
    expect(h.host!.points).toHaveLength(1);
    expect(h.host!.points[0]).toMatchObject({
      samples: 120,
      avg: { cpu_busy_pct: 20 },
      max: { cpu_busy_pct: 80 },
    });
  });

  it("org without bindings gets empty series", async () => {
    await infRow("HALOGEN", 10, 100);
    await hostRow("BOXSTATS", 10, 100, 1);
    const h = await queryHistory(e, "org_nobody", 0, 3600);
    expect(h.inference).toBeNull();
    expect(h.host).toBeNull();
    expect(h.throughput).toEqual([]);
  });

  it("uses one D1 batch for a long range", async () => {
    const spy = vi.spyOn(env.DB, "batch");
    await queryHistory(e, ORG, 0, 7 * 86400);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns only the series for the bindings that exist", async () => {
    const only = { ...e, HOST_METRICS_BINDINGS: "" } as unknown as Env;
    const h = await queryHistory(only, ORG, 0, 3600);
    expect(h.inference).not.toBeNull();
    expect(h.host).toBeNull();
  });

  it("throughput on a short range comes from the request log", async () => {
    // Non-streamed, 60 s over [3000, 3060): 12000 out, 6000 prefill.
    await request("r1", 3060, 60_000);
    await request("r2", 3060, 60_000, "openai"); // not the box
    const h = await queryHistory(e, ORG, 3000, 3100);
    expect(h.throughput).toHaveLength(10);
    expect(h.throughput[0]).toEqual({
      ts: 3000,
      decodeTps: 200,
      prefillTps: 100,
      decodeTpsMax: null,
      prefillTpsMax: null,
    });
    expect(h.throughput[6].decodeTps).toBe(0);
  });

  it("models on a short range come from the request log", async () => {
    await request("r1", 3060, 60_000);
    await request("r2", 3060, 60_000, "openai"); // not a vpc provider
    const h = await queryHistory(e, ORG, 3000, 3100);
    expect(h.models).toHaveLength(1);
    expect(h.models[0]).toMatchObject({
      provider: "box",
      kind: "chat",
      requests: 1,
    });
    expect(h.models[0].busy.map((p) => p.busy)).toEqual([
      1, 1, 1, 1, 1, 1, 0, 0, 0, 0,
    ]);
  });

  /** Dense throughput rollups up to `end`, as the cron writes them (idle = zeros). */
  async function rolledUpTo(end: number, org = ORG) {
    for (let ts = 0; ts < end; ts += 600) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO throughput_rollups
           (organization_id, ts, decode_tps, decode_tps_max, prefill_tps, prefill_tps_max, requests)
         VALUES (?, ?, 0, 0, 0, 0, 0)`,
      )
        .bind(org, ts)
        .run();
    }
  }

  it("models on a long range stop at the newest rollup, aligned to the bucket", async () => {
    await rolledUpTo(3600);
    const h = await queryHistory(e, ORG, 100, 100 + 7 * 86400);
    const [idle] = h.models;
    expect(idle.busy[0].ts).toBe(0);
    expect(idle.busy.every((p) => p.ts % h.bucketS === 0)).toBe(true);
    expect(idle.busy.at(-1)!.ts).toBeLessThan(3600);
    expect(idle.busy).toHaveLength(Math.ceil(3600 / h.bucketS));
  });

  it("models on a long range come from rollups, removed providers included", async () => {
    const put = (
      org: string,
      ts: number,
      busy: number,
      busyMax: number,
      requests: number,
    ) =>
      env.DB.prepare(
        `INSERT INTO model_activity_rollups
           (organization_id, provider, method, ts, busy, busy_max, requests,
            errors, latency_ms_sum, tokens_input, tokens_output, units)
         VALUES (?, 'gone', 'image', ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      )
        .bind(
          org,
          ts,
          busy,
          busyMax,
          requests,
          requests > 0 ? 1 : 0,
          requests > 0 ? 3000 : 0,
          requests > 0 ? 3 : 0,
        )
        .run();
    await put(ORG, 0, 0.5, 1, 2);
    await put(ORG, 600, 0.25, 0.5, 0);
    await put("org_other", 0, 9, 9, 9);
    await rolledUpTo(2400);
    const h = await queryHistory(e, ORG, 0, 7 * 86400);
    // The series stops where the cron has rolled up to, not at `to`.
    const buckets = 2400 / h.bucketS;
    expect(h.models.map((m) => m.label)).toEqual(["gone · Image", "box"]);
    const [gone, idle] = h.models;
    expect(gone).toMatchObject({
      requests: 2,
      errors: 1,
      latencyAvgMs: 3000,
      units: 3,
      unit: "images",
    });
    expect(gone.busy).toHaveLength(buckets);
    expect(gone.busy[0].busy).toBeCloseTo(0.75 / (h.bucketS / 600));
    expect(gone.busy[0].busyMax).toBe(1);
    expect(gone.busy[1]).toMatchObject({ busy: 0, busyMax: 0 });
    expect(idle).toMatchObject({ provider: "box", kind: null, requests: 0 });
    expect(idle.busy).toHaveLength(buckets);
  });

  it("aligns an unaligned from to the bucket and still counts all tokens", async () => {
    await request("r1", 3060, 60_000);
    const h = await queryHistory(e, ORG, 3003, 3103);
    expect(h.from).toBe(3000);
    expect(h.throughput.every((p) => p.ts % h.bucketS === 0)).toBe(true);
    const decodeTokens = h.throughput.reduce(
      (sum, p) => sum + p.decodeTps * h.bucketS,
      0,
    );
    expect(decodeTokens).toBeCloseTo(12000);
  });

  it("throughput on a short range is empty without vpc providers", async () => {
    await env.DB.exec("DELETE FROM provider_configs");
    const h = await queryHistory(e, ORG, 3000, 3100);
    expect(h.throughput).toEqual([]);
  });

  it("throughput on a long range comes from rollups, grouped", async () => {
    const put = (org: string, ts: number, avg: number, max: number) =>
      env.DB.prepare(
        `INSERT INTO throughput_rollups
           (organization_id, ts, decode_tps, decode_tps_max, prefill_tps, prefill_tps_max, requests)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
        .bind(org, ts, avg, max, avg / 2, max / 2)
        .run();
    await put(ORG, 0, 10, 40);
    await put(ORG, 600, 30, 60);
    await put(ORG, 1200, 5, 5);
    await put("org_other", 0, 999, 999);
    const h = await queryHistory(e, ORG, 0, 7 * 86400);
    expect(h.throughput).toEqual([
      {
        ts: 0,
        decodeTps: 20,
        prefillTps: 10,
        decodeTpsMax: 60,
        prefillTpsMax: 30,
      },
      {
        ts: 1200,
        decodeTps: 5,
        prefillTps: 2.5,
        decodeTpsMax: 5,
        prefillTpsMax: 2.5,
      },
    ]);
  });
});

describe("sampleAt", () => {
  it("returns the nearest 10 s row within 10 s", async () => {
    await infRow("HALOGEN", 10, 980, { in_flight: 9 });
    await infRow("HALOGEN", 10, 990, { in_flight: 2 });
    await infRow("HALOGEN", 10, 1000, { in_flight: 5 });
    await hostRow("BOXSTATS", 10, 1000, 77);
    const s = await sampleAt(e, ORG, "box", 992);
    expect(s).toMatchObject({
      binding: "HALOGEN",
      ts: 990,
      resolutionS: 10,
      inference: { in_flight: 2 },
      host: { cpu_busy_pct: 77 },
    });
    expect(s!.inference).not.toHaveProperty("ts");
  });

  it("falls back to the 600 row containing ts", async () => {
    await infRow("HALOGEN", 600, 600, { in_flight: 4 });
    await infRow("HALOGEN", 600, 1200, { in_flight: 8 });
    const s = await sampleAt(e, ORG, "box", 1000);
    expect(s).toMatchObject({
      ts: 600,
      resolutionS: 600,
      inference: { in_flight: 4 },
      host: null,
    });
  });

  it("uses the host row when only it exists", async () => {
    await hostRow("BOXSTATS", 10, 1000, 5);
    const s = await sampleAt(e, ORG, "box", 1000);
    expect(s).toMatchObject({ ts: 1000, resolutionS: 10, inference: null });
  });

  it("returns null when nothing is stored near ts", async () => {
    await infRow("HALOGEN", 10, 5000);
    expect(await sampleAt(e, ORG, "box", 1000)).toBeNull();
  });

  it("returns null for a provider without vpc transport", async () => {
    await infRow("HALOGEN", 10, 1000);
    expect(await sampleAt(e, ORG, "openai", 1000)).toBeNull();
  });

  it("uses one D1 batch", async () => {
    const spy = vi.spyOn(env.DB, "batch");
    await sampleAt(e, ORG, "box", 1000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("only reads the host table when no host binding exists", async () => {
    await infRow("HALOGEN", 10, 1000);
    const only = { ...e, HOST_METRICS_BINDINGS: "" } as unknown as Env;
    const s = await sampleAt(only, ORG, "box", 1000);
    expect(s!.host).toBeNull();
    expect(s!.inference).not.toBeNull();
  });
});
