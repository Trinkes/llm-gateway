// [fork] W22: per-model busy time and stats from the request log.
import { describe, expect, it } from "vitest";
import {
  modelActivity,
  spreadBusy,
  type ModelRequest,
} from "~/src/live/model-activity";

function row(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    timestamp: 130,
    latency_ms: 30_000,
    provider: "local-a",
    method: "chat",
    status_code: 200,
    units: null,
    tokens_input: 0,
    tokens_output: 0,
    ...over,
  };
}

describe("spreadBusy", () => {
  it("marks each 10 s slot a request covers as busy 1", () => {
    expect(spreadBusy([row()], 100, 140, 10)).toEqual([1, 1, 1, 0]);
  });

  it("counts a partial slot by its overlap", () => {
    expect(
      spreadBusy([row({ timestamp: 105, latency_ms: 5_000 })], 100, 140, 10),
    ).toEqual([0.5, 0, 0, 0]);
  });

  it("adds overlapping requests", () => {
    const rows = [
      row({ timestamp: 120, latency_ms: 20_000 }),
      row({ timestamp: 130, latency_ms: 20_000 }),
    ];
    expect(spreadBusy(rows, 100, 140, 10)).toEqual([1, 2, 1, 0]);
  });

  it("spreads a long request over every slot it overlaps, never above 1", () => {
    const busy = spreadBusy(
      [row({ timestamp: 400, latency_ms: 120_000 })],
      100,
      400,
      10,
    );
    busy.forEach((b, i) => {
      const ts = 100 + i * 10;
      expect(b).toBe(ts >= 280 ? 1 : 0);
    });
  });
});

describe("modelActivity", () => {
  it("counts a request only in the window it finished in", () => {
    const long = row({ timestamp: 400, latency_ms: 120_000 });
    const [inside] = modelActivity([long], [], 300, 400, 10);
    expect(inside.requests).toBe(0);
    expect(inside.busy.every((p) => p.busy === 1)).toBe(true);
    const [after] = modelActivity([long], [], 300, 410, 10);
    expect(after.requests).toBe(1);
  });

  it("groups by provider and kind, with idle rows for current providers", () => {
    const rows = [
      row({
        timestamp: 110,
        latency_ms: 4000,
        tokens_input: 10,
        tokens_output: 20,
      }),
      row({ timestamp: 120, latency_ms: 9000, status_code: 500 }),
      row({
        timestamp: 130,
        latency_ms: 2000,
        provider: "img",
        method: "image",
        units: 2,
      }),
    ];
    const models = modelActivity(
      rows,
      ["local-a", "img", "idle"],
      100,
      140,
      10,
    );
    expect(models.map((m) => m.label)).toEqual([
      "local-a · Chat",
      "img · Image",
      "idle",
    ]);
    const [chat, image, idle] = models;
    expect(chat).toMatchObject({
      provider: "local-a",
      kind: "chat",
      unit: "tokens",
      requests: 2,
      errors: 1,
      latencyAvgMs: 4000,
      tokensInput: 10,
      tokensOutput: 20,
      units: 0,
    });
    expect(image).toMatchObject({ kind: "image", unit: "images", units: 2 });
    expect(idle).toMatchObject({
      provider: "idle",
      kind: null,
      unit: null,
      requests: 0,
      errors: 0,
      latencyAvgMs: null,
    });
    expect(idle.busy).toHaveLength(4);
    expect(idle.busy.every((p) => p.busy === 0 && p.busyMax === null)).toBe(
      true,
    );
  });

  it("adds busy time for a failed request", () => {
    const [m] = modelActivity([row({ status_code: 500 })], [], 100, 140, 10);
    expect(m.busy.map((p) => p.busy)).toEqual([1, 1, 1, 0]);
    expect(m.latencyAvgMs).toBeNull();
  });

  it("orders by requests, then label", () => {
    const rows = [
      row({ provider: "b" }),
      row({ provider: "a" }),
      row({ provider: "c" }),
      row({ provider: "c", timestamp: 120 }),
    ];
    expect(
      modelActivity(rows, [], 100, 140, 10).map((m) => m.provider),
    ).toEqual(["c", "a", "b"]);
  });
});
