// [fork] W14: APU → wall fallback model.
import { describe, expect, it } from "vitest";
import {
  chooseFallbackModel,
  MIN_PAIRS,
  modelWatts,
  type PairSums,
} from "~/src/power/fallback-model";

/** OLS sums of `pairs` as the Power query returns them. */
function sums(pairs: [number, number][]): PairSums {
  const xs = pairs.map(([x]) => x);
  return {
    n: pairs.length,
    sx: xs.reduce((a, x) => a + x, 0),
    sy: pairs.reduce((a, [, y]) => a + y, 0),
    sxy: pairs.reduce((a, [x, y]) => a + x * y, 0),
    sxx: xs.reduce((a, x) => a + x * x, 0),
    minX: pairs.length ? Math.min(...xs) : null,
    maxX: pairs.length ? Math.max(...xs) : null,
  };
}

/** `n` pairs on y = k·x + c with x spread evenly over [lo, hi]. */
function line(n: number, k: number, c: number, lo: number, hi: number) {
  return Array.from({ length: n }, (_, i): [number, number] => {
    const x = lo + ((hi - lo) * i) / (n - 1);
    return [x, k * x + c];
  });
}

describe("chooseFallbackModel", () => {
  it("recovers a known line", () => {
    const m = chooseFallbackModel(sums(line(200, 1.12, 23, 7, 125)), 30);
    expect(m.kind).toBe("fit");
    expect(m.k).toBeCloseTo(1.12, 6);
    expect(m.c).toBeCloseTo(23, 6);
    expect(m.pairs).toBe(200);
    expect(m.windowDays).toBe(7);
  });

  it("low spread uses offset", () => {
    const m = chooseFallbackModel(sums(line(200, 1, 15, 7, 20)), 30);
    expect(m).toMatchObject({ kind: "offset", k: 1, pairs: 200 });
    expect(m.c).toBeCloseTo(15, 6);
  });

  it("slope out of bounds uses offset", () => {
    const m = chooseFallbackModel(sums(line(200, 2.5, 10, 7, 125)), 30);
    expect(m.kind).toBe("offset");
    expect(m.k).toBe(1);
  });

  it("negative intercept uses offset", () => {
    const m = chooseFallbackModel(sums(line(200, 1.2, -5, 7, 125)), 30);
    expect(m.kind).toBe("offset");
  });

  it("intercept above 150 W uses offset", () => {
    const m = chooseFallbackModel(sums(line(200, 1, 151, 7, 125)), 30);
    expect(m.kind).toBe("offset");
  });

  it("accepts the bounds themselves", () => {
    const m = chooseFallbackModel(sums(line(200, 0.8, 0, 7, 27)), 30);
    expect(m.kind).toBe("fit");
  });

  it("too few pairs uses setting", () => {
    const m = chooseFallbackModel(
      sums(line(MIN_PAIRS - 1, 1.12, 23, 7, 125)),
      30,
    );
    expect(m).toEqual({
      kind: "setting",
      k: 1,
      c: 30,
      pairs: MIN_PAIRS - 1,
      windowDays: 7,
    });
  });

  it("no setting means zero", () => {
    const m = chooseFallbackModel(sums([]), undefined);
    expect(m).toMatchObject({ kind: "setting", k: 1, c: 0, pairs: 0 });
  });

  it("zero variance does not divide by zero", () => {
    const pairs = Array.from({ length: 200 }, (): [number, number] => [50, 70]);
    const m = chooseFallbackModel(
      { ...sums(pairs), minX: 30, maxX: 70 }, // spread passes, variance is 0
      30,
    );
    expect(m).toMatchObject({ kind: "offset", k: 1, c: 20 });
  });

  it("missing x range uses offset", () => {
    const m = chooseFallbackModel(
      { ...sums(line(200, 1, 10, 7, 125)), minX: null, maxX: null },
      30,
    );
    expect(m.kind).toBe("offset");
  });
});

describe("modelWatts", () => {
  it("applies k and c", () => {
    const m = { kind: "fit", k: 1.1, c: 20, pairs: 200, windowDays: 7 } as const;
    expect(modelWatts(m, 100)).toBeCloseTo(130, 9);
  });
});
