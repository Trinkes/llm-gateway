import {
  formatKindUsage,
  formatRowUsage,
  formatUsage,
  kindOptions,
  KindUsage,
  rowUnit,
} from "../../../dashboard/src/lib/requestKinds";
import { describe, expect, it } from "vitest";

describe("formatUsage", () => {
  it("shows tokens in and out for token kinds", () => {
    expect(
      formatUsage("tokens", { tokensInput: 1200, tokensOutput: 300 }),
    ).toBe("1.2K / 300");
    expect(formatUsage("tokens", {})).toBe("0 / 0");
  });

  it("counts images with the right plural", () => {
    expect(formatUsage("images", { units: 4 })).toBe("4 images");
    expect(formatUsage("images", { units: 1 })).toBe("1 image");
    expect(formatUsage("images", {})).toBe("0 images");
  });

  it("falls back to seconds for an unknown kind", () => {
    expect(formatUsage(null, { latencyMs: 12300 })).toBe("12.3 s");
    expect(formatUsage(null, {})).toBe("—");
    expect(formatUsage(null, { latencyMs: null })).toBe("—");
  });
});

describe("rowUnit and formatRowUsage", () => {
  const chat = { tokens_input: 10, tokens_output: 5, latency_ms: 900 };
  const image = {
    tokens_input: 0,
    tokens_output: 0,
    units: 2,
    latency_ms: 30000,
  };
  const audio = { tokens_input: null, tokens_output: null, latency_ms: 4200 };

  it("infers the unit from the row's counts", () => {
    expect(rowUnit(chat)).toBe("tokens");
    expect(rowUnit({ tokens_cache_write: 3 })).toBe("tokens");
    expect(rowUnit(image)).toBe("images");
    expect(rowUnit(audio)).toBeNull();
    expect(rowUnit({})).toBeNull();
  });

  it("formats each kind of row", () => {
    expect(formatRowUsage(chat)).toBe("10 / 5");
    expect(formatRowUsage(image)).toBe("2 images");
    expect(formatRowUsage(audio)).toBe("4.2 s");
  });
});

describe("formatKindUsage", () => {
  const base = {
    requests: 1,
    errors: 0,
    units: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    costUsd: 0,
    latencyAvgMs: null,
    busySeconds: 0,
  };
  const kinds: KindUsage[] = [
    {
      ...base,
      kind: "chat",
      unit: "tokens",
      label: "Chat",
      tokensInput: 1200,
      tokensOutput: 300,
    },
    { ...base, kind: "image", unit: "images", label: "Images", units: 4 },
    { ...base, kind: "audio", unit: null, label: "audio", busySeconds: 12.3 },
  ];

  it("uses each kind's own unit", () => {
    expect(kinds.map(formatKindUsage)).toEqual([
      "1.2K / 300",
      "4 images",
      "12.3 s",
    ]);
  });
});

describe("kindOptions", () => {
  it("lists each kind once, labelled when a label is known", () => {
    const facets = [
      { kind: "chat" },
      { kind: "image" },
      { kind: "chat" },
      { kind: "audio" },
    ];
    expect(kindOptions(facets, { image: "Images" })).toEqual([
      { value: "chat", label: "chat" },
      { value: "image", label: "Images" },
      { value: "audio", label: "audio" },
    ]);
    expect(kindOptions([])).toEqual([]);
  });
});
