import {
  formatKindUsage,
  formatRowUsage,
  formatUsage,
  kindOptions,
  KindUsage,
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

describe("formatRowUsage", () => {
  it("formats each row by its kind's unit, even when it failed", () => {
    expect(
      formatRowUsage({
        kind_unit: "tokens",
        tokens_input: 10,
        tokens_output: 5,
      }),
    ).toBe("10 / 5");
    expect(formatRowUsage({ kind_unit: "tokens" })).toBe("0 / 0");
    expect(formatRowUsage({ kind_unit: "images", units: 2 })).toBe("2 images");
    expect(formatRowUsage({ kind_unit: null, latency_ms: 4200 })).toBe("4.2 s");
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
  it("lists each kind once by its label", () => {
    const facets = [
      { kind: "chat", label: "Chat" },
      { kind: "image", label: "Image" },
      { kind: "chat", label: "Chat" },
      { kind: "audio", label: "audio" },
    ];
    expect(kindOptions(facets)).toEqual([
      { value: "chat", label: "Chat" },
      { value: "image", label: "Image" },
      { value: "audio", label: "audio" },
    ]);
    expect(kindOptions([])).toEqual([]);
  });
});
