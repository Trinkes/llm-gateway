// [fork] W13: batched energy and token reads for the Power page.
import { createBoxTables } from "../live/box-schema";
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPowerData } from "~/src/power/power-query";

const ORG = "org_power";
const OTHER = "org_other";
const NOW = 1_800_000_000;
const DAY = 86400;
const e = {
  ...env,
  VPC_BINDINGS: `HALOGEN:${ORG}`,
  HOST_METRICS_BINDINGS: `BOXSTATS:${ORG}`,
  HALOGEN: { fetch: () => new Response("") },
  BOXSTATS: { fetch: () => new Response("") },
} as unknown as Env;

async function host(
  res: 10 | 600,
  ts: number,
  w: number | null,
  over: {
    samples?: number;
    ok?: number;
    max?: number | null;
    binding?: string;
    wall?: number | null;
    wallSamples?: number | null;
    wallMax?: number | null;
    apuOnly?: number | null;
  } = {},
) {
  await env.DB.prepare(
    `INSERT INTO host_samples (binding, resolution_s, ts, ok, samples, gpu_power_w, gpu_power_w_max,
       wall_power_w, wall_samples, wall_power_w_max, apu_only_power_w)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      over.binding ?? "BOXSTATS",
      res,
      ts,
      over.ok ?? 1,
      res === 600 ? (over.samples ?? 60) : null,
      w,
      over.max ?? null,
      over.wall ?? null,
      over.wallSamples ?? null,
      over.wallMax ?? null,
      over.apuOnly ?? null,
    )
    .run();
}

async function price(
  provider: string,
  model: string,
  rates: [number, number, number, number],
) {
  await env.DB.prepare(
    `INSERT INTO model_pricing
       (provider, model, input_per_1m, output_per_1m, cache_read_per_1m, cache_write_per_1m)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(provider, model, ...rates)
    .run();
}

async function provider(org: string, name: string, settings: object) {
  await env.DB.prepare(
    "INSERT INTO provider_configs (id, organization_id, provider, config) VALUES (?, ?, ?, ?)",
  )
    .bind(`${org}-${name}`, org, name, JSON.stringify({ keys: [], settings }))
    .run();
}

let n = 0;
async function request(
  ts: number,
  over: {
    org?: string;
    provider?: string;
    status?: number;
    cacheHit?: number;
    // [fork] W17: kind rows; a non-chat kind carries no tokens.
    method?: string;
    units?: number | null;
    latencyMs?: number;
  } = {},
) {
  const method = over.method ?? "chat";
  const tok = (v: number) => (method === "chat" ? v : null);
  await env.DB.prepare(
    `INSERT INTO request_metrics
       (id, organization_id, timestamp, provider, model, method, status_code, latency_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cache_hit, units)
     VALUES (?, ?, ?, ?, 'm', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      `r${n++}`,
      over.org ?? ORG,
      ts,
      over.provider ?? "local-m5",
      method,
      over.status ?? 200,
      over.latencyMs ?? 100,
      tok(1000),
      tok(200),
      tok(300),
      over.cacheHit ?? 0,
      over.units ?? null,
    )
    .run();
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER, units INTEGER);",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS provider_configs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, UNIQUE(organization_id, provider));",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS tenant_settings (organization_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (organization_id, key));",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS model_pricing (provider TEXT NOT NULL, model TEXT NOT NULL, input_per_1m REAL NOT NULL DEFAULT 0, output_per_1m REAL NOT NULL DEFAULT 0, cache_read_per_1m REAL NOT NULL DEFAULT 0, cache_write_per_1m REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider, model));",
  );
  await createBoxTables(env.DB, ["host_samples"]);
});

beforeEach(async () => {
  for (const t of [
    "host_samples",
    "request_metrics",
    "provider_configs",
    "tenant_settings",
    "model_pricing",
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await provider(ORG, "local-m5", { transport: "vpc", vpcBinding: "HALOGEN" });
  await provider(ORG, "openai", {});
});

const T0 = NOW - DAY; // bucket-aligned: NOW is a multiple of 600
const range = [{ start: T0, end: NOW }];

describe("loadPowerData energy", () => {
  it("unaligned range start counts the edge rollup pro rata", async () => {
    await host(600, T0, 20);
    await host(600, T0 + 600, 20);
    const { periods } = await loadPowerData(
      e,
      ORG,
      [{ start: T0 + 300, end: T0 + 1200 }],
      NOW,
    );
    expect(periods[0].apuS).toBeCloseTo(900);
    expect(periods[0].apuWs).toBeCloseTo(20 * 900);
  });

  it("unaligned range end never counts more than the range", async () => {
    await host(600, T0, 20);
    const { periods } = await loadPowerData(
      e,
      ORG,
      [
        { start: T0, end: T0 + 450 },
        { start: T0 + 450, end: T0 + 600 },
      ],
      NOW,
    );
    expect(periods.map((p) => p.apuS)).toEqual([450, 150]);
  });

  it("raw rows older than the raw retention are not read", async () => {
    // a bucket with no rollup 40 days ago: its raw rows would be pruned in prod
    await host(10, NOW - 40 * DAY, 30);
    const { periods } = await loadPowerData(
      e,
      ORG,
      [{ start: NOW - 41 * DAY, end: NOW }],
      NOW,
    );
    expect(periods[0].apuS).toBe(0);
  });

  it("dataStart seeks rollups and raw rows", async () => {
    await host(600, T0 + 1200, 5);
    await host(10, T0 + 600, 5);
    expect((await loadPowerData(e, ORG, range, NOW)).dataStart).toBe(T0 + 600);
  });

  it("sums rollup rows", async () => {
    await host(600, T0, 20, { max: 50 });
    await host(600, T0 + 600, 40, { samples: 30, max: 70 });
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0].apuWs).toBe(20 * 600 + 40 * 300);
    expect(periods[0].apuS).toBe(900);
    expect(periods[0].apuPeakW).toBe(70);
  });

  it("raw rows fill a missing rollup bucket", async () => {
    await host(600, T0, 20);
    for (let i = 0; i < 6; i++) await host(10, T0 + 600 + i * 10, 30);
    // raw rows inside the rolled-up bucket are not double counted
    await host(10, T0 + 10, 99);
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0].apuWs).toBe(20 * 600 + 6 * 300);
    expect(periods[0].apuS).toBe(660);
    expect(periods[0].apuPeakW).toBe(30);
  });

  it("ok = 0 raw rows and other bindings are ignored", async () => {
    await host(10, T0, 30, { ok: 0 });
    await host(10, T0 + 10, null);
    await host(600, T0, 50, { binding: "OTHERBOX" });
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0]).toMatchObject({
      wallWs: 0,
      wallS: 0,
      apuWs: 0,
      apuS: 0,
      wallPeakW: null,
      apuPeakW: null,
    });
  });

  it("rows assigned to their period", async () => {
    await host(600, T0, 10);
    await host(600, T0 + 3600, 20);
    const { periods } = await loadPowerData(
      e,
      ORG,
      [
        { start: T0, end: T0 + 3600 },
        { start: T0 + 3600, end: NOW },
      ],
      NOW,
    );
    expect(periods.map((p) => p.apuWs)).toEqual([6000, 12000]);
    expect(periods[1]).toMatchObject({ start: T0 + 3600, end: NOW });
  });

  // [fork] W14: wall readings and APU-only time are summed apart.
  it("legacy rollups are apu-only", async () => {
    await host(600, T0, 20, { max: 30 });
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0]).toMatchObject({
      wallWs: 0,
      wallS: 0,
      apuWs: 20 * 600,
      apuS: 600,
      wallPeakW: null,
      apuPeakW: 30,
    });
  });

  it("mixed bucket prices apu-only seconds with model", async () => {
    await host(600, T0, 80, {
      wall: 150,
      wallSamples: 40,
      wallMax: 190,
      apuOnly: 40,
      max: 120,
    });
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0]).toMatchObject({
      wallS: 400,
      wallWs: 150 * 400,
      apuS: 200,
      apuWs: 40 * 200,
      wallPeakW: 190,
      apuPeakW: 120,
    });
  });

  it("fully wall bucket has no apu-only time", async () => {
    await host(600, T0, 80, { wall: 150, wallSamples: 60, apuOnly: null });
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0]).toMatchObject({
      wallS: 600,
      apuS: 0,
      apuWs: 0,
      apuPeakW: null,
    });
  });

  it("wall bucket counts even without gpu watts", async () => {
    await host(600, T0, null, { wall: 150, wallSamples: 60 });
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0]).toMatchObject({ wallS: 600, wallWs: 90000, apuS: 0 });
  });

  it("raw rows split by wall presence", async () => {
    for (let i = 0; i < 3; i++) {
      await host(10, T0 + i * 10, 100, { wall: 150 + i });
    }
    for (let i = 3; i < 5; i++) await host(10, T0 + i * 10, 40);
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0]).toMatchObject({
      wallS: 30,
      wallWs: (150 + 151 + 152) * 10,
      apuS: 20,
      apuWs: 800,
      wallPeakW: 152,
      apuPeakW: 40,
    });
  });

  it("keeps the rollup wall peak when raw rows have none", async () => {
    await host(600, T0, 80, { wall: 150, wallSamples: 60, wallMax: 190 });
    await host(10, T0 + 600, 40);
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0]).toMatchObject({ wallPeakW: 190, apuPeakW: 40 });
  });

  it("dataStart is the first host row", async () => {
    await host(10, T0 + 30, 5);
    await host(600, T0 + 600, 5);
    expect((await loadPowerData(e, ORG, range, NOW)).dataStart).toBe(T0 + 30);
  });

  it("no rows gives null dataStart", async () => {
    expect((await loadPowerData(e, ORG, range, NOW)).dataStart).toBeNull();
  });
});

describe("loadPowerData tokens", () => {
  it("token sums skip errors, cache hits, other providers, other orgs and rows before dataStart", async () => {
    await host(600, T0 + 600, 10);
    await request(T0 + 700);
    await request(T0 + 800);
    await request(T0 + 900, { status: 500 });
    await request(T0 + 900, { cacheHit: 1 });
    await request(T0 + 900, { provider: "openai" });
    await request(T0 + 900, { org: OTHER });
    await request(T0 + 100); // before the first host sample
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0].unpricedRequests).toBe(2);
    expect(periods[0].cloudUsd).toBe(0);
    expect(periods[0].tokens).toEqual({
      input: 2000,
      output: 400,
      cacheRead: 600,
      cacheWrite: 0,
      requests: 2,
    });
  });

  it("ignores a vpc provider on a binding the org may not use", async () => {
    await host(600, T0, 10);
    await provider(ORG, "elsewhere", { transport: "vpc", vpcBinding: "NOPE" });
    await request(T0 + 10, { provider: "elsewhere" });
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0].tokens.requests).toBe(0);
  });
});

// [fork] W17: per-kind busy time for the energy split.
describe("loadPowerData kinds", () => {
  it("sums each kind's busy time per period over the token-row filter", async () => {
    await host(600, T0, 10);
    await request(T0 + 10, { latencyMs: 1500 });
    await request(T0 + 20, { latencyMs: 500 });
    await request(T0 + 30, { method: "image", units: 2, latencyMs: 30_000 });
    await request(T0 + 40, { method: "image", units: 1, latencyMs: 10_000 });
    await request(T0 + 50, { method: "audio", latencyMs: 4000 });
    await request(T0 + 60, { method: "image", units: 3, status: 500 });
    await request(T0 + 60, { method: "image", units: 3, cacheHit: 1 });
    await request(T0 + 60, { method: "image", provider: "openai" });
    await request(T0 + 60, { method: "image", org: OTHER });
    await request(T0 + 3700, { method: "image", units: 4, latencyMs: 8000 });
    const { periods } = await loadPowerData(
      e,
      ORG,
      [
        { start: T0, end: T0 + 3600 },
        { start: T0 + 3600, end: NOW },
      ],
      NOW,
    );
    expect(periods[0].kinds).toEqual([
      { kind: "image", requests: 2, units: 3, output: 0, busySeconds: 40 },
      { kind: "audio", requests: 1, units: 0, output: 0, busySeconds: 4 },
      { kind: "chat", requests: 2, units: 0, output: 400, busySeconds: 2 },
    ]);
    expect(periods[1].kinds).toEqual([
      { kind: "image", requests: 1, units: 4, output: 0, busySeconds: 8 },
    ]);
  });

  it("image and unknown rows are not tokens and not unpriced", async () => {
    await host(600, T0, 10);
    await request(T0 + 10);
    await request(T0 + 20, { method: "image", units: 1 });
    await request(T0 + 30, { method: "audio" });
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0].tokens.requests).toBe(1);
    expect(periods[0].unpricedRequests).toBe(1);
  });

  it("a period without requests has no kinds", async () => {
    await host(600, T0, 10);
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0].kinds).toEqual([]);
  });

  it("no host gives empty kinds", async () => {
    const { periods } = await loadPowerData(
      { ...e, HOST_METRICS_BINDINGS: "" } as Env,
      ORG,
      range,
      NOW,
    );
    expect(periods[0].kinds).toEqual([]);
  });
});

describe("loadPowerData cloud pricing", () => {
  // each request: 1000 in, 200 out, 300 cache read, model 'm'
  it("prices from the provider's '*' row", async () => {
    await host(600, T0, 10);
    await price("local-m5", "*", [1, 4, 0.1, 2]);
    await request(T0 + 10);
    await request(T0 + 20);
    const data = await loadPowerData(e, ORG, range, NOW);
    expect(data.periods[0].cloudUsd).toBeCloseTo(
      (2 * (1000 * 1 + 200 * 4 + 300 * 0.1)) / 1e6,
    );
    expect(data.periods[0].unpricedRequests).toBe(0);
    expect(data.cloudRates).toEqual([
      {
        provider: "local-m5",
        model: "*",
        inputPer1m: 1,
        outputPer1m: 4,
        cacheReadPer1m: 0.1,
        cacheWritePer1m: 2,
      },
    ]);
  });

  it("an exact model row wins over '*'", async () => {
    await host(600, T0, 10);
    await price("local-m5", "*", [1, 4, 0.1, 0]);
    await price("local-m5", "m", [2, 8, 0, 0]);
    await request(T0 + 10);
    const data = await loadPowerData(e, ORG, range, NOW);
    expect(data.periods[0].cloudUsd).toBeCloseTo((1000 * 2 + 200 * 8) / 1e6);
    expect(data.cloudRates.map((r) => r.model)).toEqual(["*", "m"]);
  });

  it("other providers' rates are not used or listed", async () => {
    await host(600, T0, 10);
    await price("openai", "*", [1, 1, 1, 1]);
    await price("local-m5", "other", [1, 1, 1, 1]);
    await request(T0 + 10);
    const data = await loadPowerData(e, ORG, range, NOW);
    expect(data.periods[0].unpricedRequests).toBe(1);
    expect(data.periods[0].cloudUsd).toBe(0);
    expect(data.cloudRates.map((r) => r.provider)).toEqual(["local-m5"]);
  });
});

describe("loadPowerData idle and settings", () => {
  it("idle p10 nearest rank", async () => {
    for (let i = 1; i <= 10; i++) await host(600, NOW - i * 600, i);
    expect((await loadPowerData(e, ORG, range, NOW)).idle.apuP10W).toBe(1);
    for (let i = 11; i <= 20; i++) await host(600, NOW - i * 600, i);
    await host(600, NOW - 40 * DAY, 0.5); // older than 30 days
    expect((await loadPowerData(e, ORG, range, NOW)).idle.apuP10W).toBe(2);
  });

  it("no idle rows gives null", async () => {
    expect((await loadPowerData(e, ORG, range, NOW)).idle.apuP10W).toBeNull();
  });

  it("pair sums use only fully wall buckets in the last 7 days", async () => {
    await host(600, NOW - 600, 100, { wall: 130, wallSamples: 60 });
    await host(600, NOW - 1200, 100, { wall: 130, wallSamples: 50 }); // partial
    await host(600, NOW - 8 * DAY, 100, { wall: 130, wallSamples: 60 }); // old
    await host(600, NOW - 1800, 100, {
      samples: 29,
      wall: 130,
      wallSamples: 29,
    });
    await host(600, NOW - 2400, 100, {
      samples: 30,
      wall: 140,
      wallSamples: 30,
    });
    expect((await loadPowerData(e, ORG, range, NOW)).pairs).toEqual({
      n: 2,
      sx: 200,
      sy: 270,
      sxy: 100 * 130 + 100 * 140,
      sxx: 20000,
      minX: 100,
      maxX: 100,
    });
  });

  it("idle p10 per source", async () => {
    for (let i = 1; i <= 10; i++) {
      await host(600, NOW - i * 600, i, { wall: 100 + i, wallSamples: 60 });
    }
    for (let i = 11; i <= 15; i++) await host(600, NOW - i * 600, i);
    await host(600, NOW - 40 * DAY, 0.5, { wall: 1, wallSamples: 60 });
    expect((await loadPowerData(e, ORG, range, NOW)).idle).toEqual({
      wallP10W: 101,
      wallBuckets: 10,
      apuP10W: 11,
      buckets: 15,
    });
  });

  it("reads power setting", async () => {
    expect((await loadPowerData(e, ORG, range, NOW)).settings).toEqual({});
    await env.DB.prepare(
      "INSERT INTO tenant_settings (organization_id, key, value) VALUES (?, 'power', ?)",
    )
      .bind(ORG, JSON.stringify({ pricePerKwhUsd: 0.2 }))
      .run();
    expect((await loadPowerData(e, ORG, range, NOW)).settings).toEqual({
      pricePerKwhUsd: 0.2,
    });
  });

  it("one round trip", async () => {
    const spy = vi.spyOn(e.DB, "batch");
    await loadPowerData(e, ORG, range, NOW);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("loadPowerData without a host binding", () => {
  it("org without host binding gets empty periods but its settings", async () => {
    await host(600, T0, 10);
    await env.DB.prepare(
      "INSERT INTO tenant_settings (organization_id, key, value) VALUES (?, 'power', ?)",
    )
      .bind(OTHER, JSON.stringify({ overheadW: 5 }))
      .run();
    const data = await loadPowerData(e, OTHER, range, NOW);
    expect(data).toEqual({
      settings: { overheadW: 5 },
      dataStart: null,
      idle: { wallP10W: null, wallBuckets: 0, apuP10W: null, buckets: 0 },
      pairs: { n: 0, sx: 0, sy: 0, sxy: 0, sxx: 0, minX: null, maxX: null },
      cloudRates: [],
      periods: [
        {
          start: T0,
          end: NOW,
          wallWs: 0,
          wallS: 0,
          apuWs: 0,
          apuS: 0,
          wallPeakW: null,
          apuPeakW: null,
          tokens: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            requests: 0,
          },
          cloudUsd: 0,
          unpricedRequests: 0,
          kinds: [],
        },
      ],
    });
  });

  it("no periods reads settings only", async () => {
    const data = await loadPowerData(e, ORG, [], NOW);
    expect(data).toMatchObject({ dataStart: null, periods: [] });
  });
});
