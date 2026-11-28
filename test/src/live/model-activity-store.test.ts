// [fork] W22: 10-minute per-model activity rollups.
import { createBoxTables } from "./box-schema";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ModelRequest } from "~/src/live/model-activity";
import {
  modelActivityRollupsStatement,
  modelActivityWrites,
  rollupModelActivity,
} from "~/src/live/model-activity-store";

const e = env as unknown as Env;

function row(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    timestamp: 650,
    latency_ms: 120_000,
    provider: "box",
    method: "chat",
    status_code: 200,
    units: null,
    tokens_input: 10,
    tokens_output: 20,
    ...over,
  };
}

const ROWS = [
  row(),
  row({
    timestamp: 100,
    latency_ms: 10_000,
    provider: "img",
    method: "image",
    status_code: 500,
    units: 1,
  }),
];

describe("rollupModelActivity", () => {
  const rollups = rollupModelActivity(ROWS, 0, 1200);
  const find = (provider: string, ts: number) =>
    rollups.find((r) => r.provider === provider && r.ts === ts)!;

  it("writes only buckets with busy time or requests", () => {
    expect(rollups.map((r) => `${r.ts}:${r.provider}`)).toEqual([
      "0:box",
      "600:box",
      "0:img",
    ]);
  });

  it("averages busy over the bucket and keeps the 10 s peak", () => {
    expect(find("box", 0).busy).toBeCloseTo(70 / 600);
    expect(find("box", 600).busy).toBeCloseTo(50 / 600);
    expect(find("box", 600).busy_max).toBe(1);
  });

  it("counts a request in the bucket it finished in", () => {
    expect(find("box", 0).requests).toBe(0);
    expect(find("box", 600)).toMatchObject({
      requests: 1,
      errors: 0,
      latency_ms_sum: 120_000,
      tokens_input: 10,
      tokens_output: 20,
    });
  });

  it("counts a failed request as an error with no latency or output", () => {
    expect(find("img", 0)).toMatchObject({
      method: "image",
      requests: 1,
      errors: 1,
      latency_ms_sum: 0,
      units: 0,
    });
  });
});

describe("modelActivityWrites / modelActivityRollupsStatement", () => {
  beforeAll(async () => {
    await createBoxTables(env.DB, ["model_activity_rollups"]);
  });

  it("packs rows into multi-row inserts under D1's 100 bound-parameter limit", async () => {
    await env.DB.exec("DELETE FROM model_activity_rollups");
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...rollupModelActivity(ROWS, 0, 1200)[0],
      ts: i * 600,
    }));
    const writes = modelActivityWrites(e, "org_pack", many);
    expect(writes).toHaveLength(3);
    await env.DB.batch(writes);
    const { results } = await modelActivityRollupsStatement(
      e,
      "org_pack",
      0,
      20 * 600,
    ).all();
    expect(results).toHaveLength(20);
  });

  it("writes nothing for no rollups", () => {
    expect(modelActivityWrites(e, "org_pack", [])).toEqual([]);
  });

  it("stores rollups per org and reads them back in order, replacing on re-run", async () => {
    const rollups = rollupModelActivity(ROWS, 0, 1200);
    await env.DB.batch(modelActivityWrites(e, "org_a", rollups));
    await env.DB.batch(modelActivityWrites(e, "org_a", rollups));
    await env.DB.batch(modelActivityWrites(e, "org_b", rollups.slice(0, 1)));
    const { results } = await modelActivityRollupsStatement(
      e,
      "org_a",
      0,
      1200,
    ).all<{ provider: string; ts: number }>();
    expect(results.map((r) => `${r.ts}:${r.provider}`)).toEqual([
      "0:box",
      "0:img",
      "600:box",
    ]);
  });
});
