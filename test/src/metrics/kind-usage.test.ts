import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { metricsRouter } from "~/src/api/metrics";
import { usageRouter } from "~/src/api/usage";
import type { AppBindings } from "~/src/app";
import {
  cacheUsageByModel,
  dailyCosts,
  spendForRange,
} from "~/src/metrics/cost-tracker";
import { toKindUsage } from "~/src/metrics/kind-usage";
import type { SessionAuth } from "~/src/types";

const ORG = "org_kind_usage";
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const START = NOW - 3600;
const END = NOW + 60;

const session: SessionAuth = {
  userId: "user_1",
  sessionId: "sess_1",
  organizationId: ORG,
  role: "owner",
  email: "owner@acme.test",
  expiresAt: 9999999999,
};

interface SeedRow {
  kind: string;
  provider?: string;
  model?: string;
  statusCode?: number;
  latencyMs?: number;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  costUsd?: number | null;
  units?: number | null;
  timestamp?: number;
}

async function seed(rows: SeedRow[]) {
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO request_metrics
           (id, organization_id, timestamp, provider, model, method, status_code,
            latency_ms, tokens_input, tokens_output, cost_usd, cache_hit, units)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).bind(
        `m_${Math.random().toString(36).slice(2)}`,
        ORG,
        r.timestamp ?? NOW - 30,
        r.provider ?? "p1",
        r.model ?? "m1",
        r.kind,
        r.statusCode ?? 200,
        r.latencyMs ?? 100,
        r.tokensInput ?? null,
        r.tokensOutput ?? null,
        r.costUsd ?? null,
        r.units ?? null,
      ),
    ),
  );
}

/** Chat, image and an unregistered kind. */
async function seedKinds() {
  await seed([
    {
      kind: "chat",
      tokensInput: 100,
      tokensOutput: 10,
      costUsd: 0.5,
      latencyMs: 200,
    },
    {
      kind: "chat",
      tokensInput: 50,
      tokensOutput: 5,
      costUsd: 0.25,
      latencyMs: 400,
      statusCode: 500,
    },
    {
      kind: "image",
      provider: "img",
      model: "gen",
      units: 3,
      costUsd: 0.3,
      latencyMs: 4000,
    },
    { kind: "audio", provider: "aud", model: "tts", latencyMs: 1000 },
  ]);
}

function app() {
  const a = new Hono<AppBindings>();
  a.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  a.route("/api/metrics", metricsRouter);
  a.route("/api/usage", usageRouter);
  return a;
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER, units INTEGER);",
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM request_metrics;");
});

describe("spendForRange per kind", () => {
  it("splits totals per kind and keeps the all-rows totals", async () => {
    await seedKinds();
    const s = await spendForRange(env, ORG, { start: START, end: END });

    expect(s.requests).toBe(4);
    expect(s.avgLatencyMs).toBe(1400);
    expect(s.byKind).toEqual([
      {
        kind: "chat",
        unit: "tokens",
        label: "Chat",
        requests: 2,
        errors: 1,
        units: 0,
        tokensInput: 150,
        tokensOutput: 15,
        tokensCacheRead: 0,
        costUsd: 0.75,
        latencyAvgMs: 300,
        busySeconds: 0.6,
      },
      {
        kind: "audio",
        unit: null,
        label: "audio",
        requests: 1,
        errors: 0,
        units: 0,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheRead: 0,
        costUsd: 0,
        latencyAvgMs: 1000,
        busySeconds: 1,
      },
      {
        kind: "image",
        unit: "images",
        label: "Image",
        requests: 1,
        errors: 0,
        units: 3,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheRead: 0,
        costUsd: 0.3,
        latencyAvgMs: 4000,
        busySeconds: 4,
      },
    ]);
  });

  it("narrows to one kind", async () => {
    await seedKinds();
    const s = await spendForRange(env, ORG, {
      start: START,
      end: END,
      kind: "image",
    });
    expect(s.requests).toBe(1);
    expect(s.byKind.map((k) => k.kind)).toEqual(["image"]);
  });

  it("has no kinds without traffic", async () => {
    const s = await spendForRange(env, ORG, { start: START, end: END });
    expect(s.byKind).toEqual([]);
  });
});

describe("toKindUsage", () => {
  it("coalesces null aggregates to zero", () => {
    expect(
      toKindUsage([
        {
          kind: "audio",
          requests: 1,
          errors: null,
          units: null,
          tokens_input: null,
          tokens_output: null,
          tokens_cache_read: null,
          cost_usd: null,
          latency_avg_ms: null,
          busy_ms: null,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: "audio",
        errors: 0,
        units: 0,
        costUsd: 0,
        latencyAvgMs: 0,
        busySeconds: 0,
      }),
    ]);
  });
});

describe("GET /api/metrics/summary", () => {
  it("returns byKind and honours the kind filter", async () => {
    await seedKinds();
    const get = async (extra = "") => {
      const res = await app().request(
        `/api/metrics/summary?start=${START}&end=${END}${extra}`,
        {},
        env,
      );
      expect(res.status).toBe(200);
      return (
        (await res.json()) as {
          summary: { requests: number; byKind: Array<{ kind: string }> };
        }
      ).summary;
    };
    const all = await get();
    expect(all.byKind.map((k) => k.kind)).toEqual(["chat", "audio", "image"]);
    const images = await get("&kind=image");
    expect(images.requests).toBe(1);
    expect(images.byKind.map((k) => k.kind)).toEqual(["image"]);
  });
});

describe("GET /api/metrics/latency", () => {
  it("groups by provider and kind", async () => {
    await seed([
      { kind: "chat", latencyMs: 100 },
      { kind: "chat", latencyMs: 300 },
      { kind: "image", latencyMs: 5000 },
      { kind: "chat", latencyMs: 9, statusCode: 500 },
      { kind: "audio", provider: "aud", latencyMs: 700 },
    ]);
    const res = await app().request(
      `/api/metrics/latency?start=${START}&end=${END}`,
      {},
      env,
    );
    const { latency } = (await res.json()) as {
      latency: Array<{
        provider: string;
        kind: string;
        requests: number;
        avg: number;
      }>;
    };
    expect(latency.map((l) => [l.provider, l.kind, l.requests, l.avg])).toEqual(
      [
        ["aud", "audio", 1, 700],
        ["p1", "chat", 2, 200],
        ["p1", "image", 1, 5000],
      ],
    );
  });
});

describe("cacheUsageByModel", () => {
  it("leaves out kinds without token counts", async () => {
    await seedKinds();
    const usage = await cacheUsageByModel(env, ORG, START, END);
    expect(usage.map((u) => [u.provider, u.model])).toEqual([["p1", "m1"]]);
  });
});

describe("dailyCosts", () => {
  it("folds per-kind rows into days", async () => {
    const day1 = Math.floor(NOW / DAY) * DAY - 2 * DAY + 3600;
    const day2 = day1 + DAY;
    await seed([
      { kind: "chat", costUsd: 0.5, timestamp: day1 },
      { kind: "chat", costUsd: 0.25, timestamp: day1 + 5 },
      { kind: "image", units: 2, costUsd: 0.1, timestamp: day1 + 10 },
      { kind: "audio", timestamp: day2 },
    ]);
    const days = await dailyCosts(env, ORG, day1 - 3600, day2 + DAY);
    expect(days).toEqual([
      {
        day: day1 - 3600,
        cost_usd: expect.closeTo(0.85),
        requests: 3,
        kinds: [
          { kind: "chat", requests: 2, units: 0, costUsd: 0.75 },
          { kind: "image", requests: 1, units: 2, costUsd: 0.1 },
        ],
      },
      {
        day: day2 - 3600,
        cost_usd: 0,
        requests: 1,
        kinds: [{ kind: "audio", requests: 1, units: 0, costUsd: 0 }],
      },
    ]);
  });

  it("is served by GET /api/usage/costs", async () => {
    await seedKinds();
    const res = await app().request(
      `/api/usage/costs?start=${START}&end=${END}`,
      {},
      env,
    );
    const body = (await res.json()) as {
      days: Array<{ kinds: Array<{ kind: string }> }>;
      summary: { byKind: unknown[] };
    };
    expect(body.days[0].kinds.map((k) => k.kind).sort()).toEqual([
      "audio",
      "chat",
      "image",
    ]);
    expect(body.summary.byKind).toHaveLength(3);
  });
});
