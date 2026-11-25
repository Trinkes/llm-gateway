// [fork] W14: Power page labels for the energy source and fallback model.
import {
  modelLabel,
  sourceLabel,
} from "../../../dashboard/src/lib/powerSource";
import { describe, expect, it } from "vitest";

describe("sourceLabel", () => {
  it("names each source", () => {
    expect(sourceLabel("wall", 1)).toBe("Wall meter");
    expect(sourceLabel("apu", 0)).toBe("Estimated from APU");
    expect(sourceLabel("mixed", 0.634)).toBe("Mixed: 63% wall");
    expect(sourceLabel(null, null)).toBe("No data");
  });
});

describe("modelLabel", () => {
  it("fit", () => {
    expect(
      modelLabel({ kind: "fit", k: 1.1234, c: 22.6, pairs: 1008, windowDays: 7 }),
    ).toBe("Fallback: wall ≈ 1.12 × APU + 23 W (fit on 1,008 pairs, last 7 d)");
  });

  it("offset", () => {
    expect(
      modelLabel({ kind: "offset", k: 1, c: 15.2, pairs: 300, windowDays: 7 }),
    ).toBe("Fallback: APU + 15 W (measured offset, last 7 d)");
  });

  it("setting", () => {
    expect(
      modelLabel({ kind: "setting", k: 1, c: 30, pairs: 3, windowDays: 7 }),
    ).toBe("Fallback: manual overhead (not enough plug data)");
  });
});
