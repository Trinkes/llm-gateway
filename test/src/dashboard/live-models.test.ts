// [fork] W22: Live page per-model chart and table helpers.
import type { ModelActivity } from "../../../dashboard/src/lib/api";
import {
  MODEL_COLORS,
  fmtRate,
  modelChartPoints,
  modelColor,
  modelSeriesKey,
  modelUsage,
  modelsWindowS,
  requestsPerMin,
} from "../../../dashboard/src/lib/liveModels";
import { formatUsage } from "../../../dashboard/src/lib/requestKinds";
import { describe, expect, it } from "vitest";

function model(over: Partial<ModelActivity> = {}): ModelActivity {
  return {
    provider: "local-a",
    kind: "chat",
    unit: "tokens",
    label: "local-a · Chat",
    busy: [
      { ts: 100, busy: 1, busyMax: null },
      { ts: 110, busy: 0.5, busyMax: null },
    ],
    requests: 0,
    errors: 0,
    latencyAvgMs: null,
    tokensInput: 0,
    tokensOutput: 0,
    units: 0,
    ...over,
  };
}

describe("modelSeriesKey", () => {
  it("is provider and kind, empty kind for idle", () => {
    expect(modelSeriesKey(model())).toBe("local-a|chat");
    expect(modelSeriesKey(model({ kind: null }))).toBe("local-a|");
  });
});

describe("modelChartPoints", () => {
  it("pivots to one point per ts with a key per model", () => {
    const img = model({
      provider: "img",
      kind: "image",
      busy: [
        { ts: 100, busy: 0, busyMax: null },
        { ts: 110, busy: 2, busyMax: null },
      ],
    });
    expect(modelChartPoints([model(), img])).toEqual([
      { t: 100_000, "local-a|chat": 1, "img|image": 0 },
      { t: 110_000, "local-a|chat": 0.5, "img|image": 2 },
    ]);
  });

  it("is empty without models", () => {
    expect(modelChartPoints([])).toEqual([]);
  });
});

describe("modelColor", () => {
  it("is stable by sorted key, whatever the order models come in", () => {
    const keys = ["b|chat", "a|chat"];
    expect(modelColor("a|chat", keys)).toBe(MODEL_COLORS[0]);
    expect(modelColor("b|chat", [...keys].reverse())).toBe(MODEL_COLORS[1]);
  });
});

describe("modelsWindowS", () => {
  it("is the span the busy series covers, not the requested range", () => {
    expect(modelsWindowS([model()], 600)).toBe(1200);
    expect(modelsWindowS([], 600)).toBe(0);
  });
});

describe("requestsPerMin", () => {
  it("divides by the window in minutes", () => {
    expect(requestsPerMin(model({ requests: 30 }), 600)).toBe(3);
  });
});

describe("fmtRate", () => {
  it("shows one decimal, and never 0.0 for a non-zero rate", () => {
    expect(fmtRate(0)).toBe("0");
    expect(fmtRate(1.234)).toBe("1.2");
    expect(fmtRate(0.011)).toBe("<0.1");
  });
});

describe("modelUsage", () => {
  it("is a dash for an idle model", () => {
    expect(modelUsage(model({ kind: null, unit: null }))).toBe("—");
  });

  it("uses the kind's unit", () => {
    expect(modelUsage(model({ kind: "image", unit: "images", units: 3 }))).toBe(
      formatUsage("images", { units: 3 }),
    );
    expect(modelUsage(model({ tokensInput: 1200, tokensOutput: 300 }))).toBe(
      formatUsage("tokens", { tokensInput: 1200, tokensOutput: 300 }),
    );
  });

  it("is a dash for a kind without a unit", () => {
    expect(modelUsage(model({ kind: "speech", unit: null }))).toBe("—");
  });
});
