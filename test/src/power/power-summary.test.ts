// [fork] W13: energy, cost and cloud-comparison maths.
// [fork] W14: wall-meter time priced as measured, APU-only time via the fallback model.
import { describe, expect, it } from "vitest";
import type { FallbackModel } from "~/src/power/fallback-model";
import type { IdleStats } from "~/src/power/power-query";
import type { PowerSettings } from "~/src/power/power-settings";
import {
  effectiveSeconds,
  idleFloor,
  projectUsd,
  summarize,
  type PeriodRaw,
} from "~/src/power/power-summary";

const settings: PowerSettings = { pricePerKwhUsd: 0.2, overheadW: 10 };
/** What chooseFallbackModel gives `settings` with no plug data. */
const overhead10: FallbackModel = {
  kind: "setting",
  k: 1,
  c: 10,
  pairs: 0,
  windowDays: 7,
};
const none: FallbackModel = { ...overhead10, c: 0 };
const fit: FallbackModel = {
  kind: "fit",
  k: 1.1,
  c: 20,
  pairs: 1008,
  windowDays: 7,
};
const tokens = {
  input: 3_000_000,
  output: 1_000_000,
  cacheRead: 1_000_000,
  cacheWrite: 0,
  requests: 5,
};
const noTokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
};
const noWall = { wallWs: 0, wallS: 0, wallPeakW: null };
const noApu = { apuWs: 0, apuS: 0, apuPeakW: null };
// 1 h range, 30 min measured at 20 W APU, no wall readings
const raw: PeriodRaw[] = [
  {
    start: 0,
    end: 3600,
    ...noWall,
    apuWs: 20 * 1800,
    apuS: 1800,
    apuPeakW: 60,
    tokens,
    // 3M in at $1, 1M out at $4, 1M cache read at $0.1 (priced in SQL)
    cloudUsd: 7.1,
    unpricedRequests: 0,
  },
];

describe("summarize", () => {
  it("full maths", () => {
    const { totals, periods } = summarize(raw, 0, 10_000, settings, overhead10);
    expect(totals.coverage).toBe(0.5);
    expect(totals.avgW).toBe(30);
    expect(totals.wallKwh).toBe(0);
    expect(totals.modelledKwh).toBeCloseTo(0.015);
    expect(totals.measuredKwh).toBeCloseTo(0.015);
    expect(totals.estimatedKwh).toBeCloseTo(0.015);
    expect(totals.totalKwh).toBeCloseTo(0.03);
    expect(totals.electricityUsd).toBeCloseTo(0.006);
    expect(totals.cloudUsd).toBeCloseTo(7.1);
    expect(totals.unpricedRequests).toBe(0);
    expect(totals.savingsUsd).toBeCloseTo(7.1 - 0.006);
    expect(totals.peakW).toBe(70);
    expect(totals.source).toBe("apu");
    expect(totals.wallCoverage).toBe(0);
    expect(totals.electricityPer1mOutputUsd).toBeCloseTo(0.006);
    expect(totals.cloudPer1mOutputUsd).toBeCloseTo(7.1);
    expect(periods[0]).toMatchObject({ start: 0, end: 3600, coverage: 0.5 });
  });

  it("fully wall range ignores model", () => {
    const wall: PeriodRaw[] = [
      {
        ...raw[0],
        wallWs: 150 * 3600,
        wallS: 3600,
        wallPeakW: 190,
        ...noApu,
      },
    ];
    const { totals } = summarize(wall, 0, 10_000, settings, {
      ...fit,
      c: 100,
    });
    expect(totals.wallKwh).toBeCloseTo(0.15);
    expect(totals.modelledKwh).toBe(0);
    expect(totals.totalKwh).toBeCloseTo(0.15);
    expect(totals.avgW).toBe(150);
    expect(totals.peakW).toBe(190);
    expect(totals.source).toBe("wall");
    expect(totals.wallCoverage).toBe(1);
  });

  it("apu-only range uses model", () => {
    const apu: PeriodRaw[] = [
      { ...raw[0], ...noWall, apuWs: 3.6e6, apuS: 3600, apuPeakW: 1000 },
    ];
    const { totals } = summarize(apu, 0, 10_000, settings, fit);
    expect(totals.modelledKwh).toBeCloseTo(1.1 + 0.02);
    expect(totals.totalKwh).toBeCloseTo(1.12);
    expect(totals.peakW).toBeCloseTo(1120);
  });

  it("mixed source and coverage", () => {
    const mixed: PeriodRaw[] = [
      {
        ...raw[0],
        wallWs: 150 * 2700,
        wallS: 2700,
        wallPeakW: 160,
        apuWs: 100 * 900,
        apuS: 900,
        apuPeakW: 200,
      },
    ];
    const { totals } = summarize(mixed, 0, 10_000, settings, fit);
    expect(totals.source).toBe("mixed");
    expect(totals.wallCoverage).toBe(0.75);
    expect(totals.coverage).toBe(1);
    expect(totals.wallKwh).toBeCloseTo((150 * 2700) / 3.6e6);
    expect(totals.modelledKwh).toBeCloseTo((130 * 900) / 3.6e6);
    expect(totals.avgW).toBeCloseTo((150 * 2700 + 130 * 900) / 3600);
    expect(totals.peakW).toBeCloseTo(240); // 1.1 × 200 + 20 beats the wall 160
  });

  it("gaps filled at total average", () => {
    // 1800 s wall at 150 W, 900 s APU-only at 100 W → 130 W, 900 s gap
    const gappy: PeriodRaw[] = [
      {
        ...raw[0],
        wallWs: 150 * 1800,
        wallS: 1800,
        wallPeakW: 150,
        apuWs: 100 * 900,
        apuS: 900,
        apuPeakW: 100,
      },
    ];
    const { totals } = summarize(gappy, 0, 10_000, settings, fit);
    const avg = (150 * 1800 + 130 * 900) / 2700;
    expect(totals.avgW).toBeCloseTo(avg);
    expect(totals.estimatedKwh).toBeCloseTo((avg * 900) / 3.6e6);
  });

  it("fills each period's gaps with the range average so periods add up", () => {
    const two: PeriodRaw[] = [
      {
        start: 0,
        end: 100,
        ...noWall,
        apuWs: 1000,
        apuS: 100,
        apuPeakW: 10,
        tokens: noTokens,
        cloudUsd: 0,
        unpricedRequests: 0,
      },
      {
        start: 100,
        end: 200,
        ...noWall,
        apuWs: 1500,
        apuS: 50,
        apuPeakW: 40,
        tokens: noTokens,
        cloudUsd: 0,
        unpricedRequests: 0,
      },
    ];
    const { totals, periods } = summarize(two, 0, 10_000, {}, none);
    // range average 2500 Ws / 150 s; second period's 50 s gap uses it
    expect(periods[1].estimatedKwh).toBeCloseTo((50 * 2500) / 150 / 3.6e6);
    expect(periods[1].avgW).toBe(30);
    expect(periods[0].estimatedKwh + periods[1].estimatedKwh).toBeCloseTo(
      totals.estimatedKwh,
    );
    expect(totals.peakW).toBe(40);
  });

  it("keeps the peak when a later period has none", () => {
    const two: PeriodRaw[] = [
      { ...raw[0], end: 1800 },
      { ...raw[0], start: 1800, ...noApu },
    ];
    expect(summarize(two, 0, 10_000, {}, none).totals.peakW).toBe(60);
  });

  it("null electricity money without a kWh price", () => {
    const { totals } = summarize(raw, 0, 10_000, {}, none);
    expect(totals.totalKwh).toBeGreaterThan(0);
    expect([
      totals.electricityUsd,
      totals.savingsUsd,
      totals.electricityPer1mOutputUsd,
    ]).toEqual([null, null, null]);
    expect(totals.cloudUsd).toBeCloseTo(7.1);
  });

  it("no cloud figure when every request is unpriced", () => {
    const { totals } = summarize(
      [{ ...raw[0], cloudUsd: 0, unpricedRequests: tokens.requests }],
      0,
      10_000,
      settings,
      overhead10,
    );
    expect(totals.cloudUsd).toBeNull();
    expect(totals.savingsUsd).toBeNull();
    expect(totals.cloudPer1mOutputUsd).toBeNull();
    expect(totals.unpricedRequests).toBe(tokens.requests);
  });

  it("partly priced keeps the priced figure and counts the rest", () => {
    const two: PeriodRaw[] = [
      { ...raw[0], end: 1800 },
      {
        ...raw[0],
        start: 1800,
        cloudUsd: 0,
        unpricedRequests: tokens.requests,
      },
    ];
    const { totals, periods } = summarize(two, 0, 10_000, settings, overhead10);
    expect(totals.cloudUsd).toBeCloseTo(7.1);
    expect(totals.unpricedRequests).toBe(tokens.requests);
    expect(periods[1].cloudUsd).toBeNull();
  });

  it("no measured seconds gives no estimate", () => {
    const { totals } = summarize(
      [{ ...raw[0], ...noApu }],
      0,
      10_000,
      settings,
      overhead10,
    );
    expect([
      totals.avgW,
      totals.estimatedKwh,
      totals.coverage,
      totals.peakW,
      totals.source,
      totals.wallCoverage,
    ]).toEqual([null, 0, 0, null, null, null]);
  });

  it("no output tokens gives no per-1M figures", () => {
    const { totals } = summarize(
      [{ ...raw[0], tokens: noTokens, cloudUsd: 0 }],
      0,
      10_000,
      settings,
      overhead10,
    );
    expect(totals.cloudUsd).toBe(0);
    expect(totals.electricityPer1mOutputUsd).toBeNull();
    expect(totals.cloudPer1mOutputUsd).toBeNull();
  });

  it("period before data start is no power data", () => {
    const { totals, periods } = summarize(
      raw,
      5000,
      10_000,
      settings,
      overhead10,
    );
    expect(periods[0]).toMatchObject({
      effectiveS: 0,
      coverage: null,
      avgW: null,
      electricityUsd: null,
      cloudUsd: null,
      totalKwh: 0,
      source: null,
      tokens: noTokens,
    });
    expect(totals.effectiveS).toBe(0);
    expect(totals.electricityUsd).toBeNull();
  });

  it("no data start at all is no power data", () => {
    expect(
      summarize(raw, null, 10_000, settings, overhead10).totals.coverage,
    ).toBeNull();
  });
});

describe("effectiveSeconds", () => {
  it("clips periods to data start", () => {
    expect(effectiveSeconds({ start: 0, end: 3600 }, 1800, 10_000)).toBe(1800);
    expect(effectiveSeconds({ start: 0, end: 3600 }, null, 10_000)).toBe(0);
    expect(effectiveSeconds({ start: 0, end: 3600 }, 0, 600)).toBe(600);
    expect(effectiveSeconds({ start: 0, end: 3600 }, 5000, 10_000)).toBe(0);
  });
});

const idle = (over: Partial<IdleStats>): IdleStats => ({
  wallP10W: null,
  wallBuckets: 0,
  apuP10W: null,
  buckets: 0,
  ...over,
});

describe("idleFloor and projection", () => {
  it("idle floor models apu p10 otherwise", () => {
    expect(
      idleFloor(idle({ apuP10W: 7, buckets: 10 }), overhead10, settings),
    ).toEqual({ watts: 17, monthlyUsd: ((17 * 730) / 1000) * 0.2 });
    expect(idleFloor(idle({ apuP10W: 7, buckets: 10 }), none, {})).toEqual({
      watts: 7,
      monthlyUsd: null,
    });
    expect(idleFloor(idle({}), overhead10, settings)).toBeNull();
  });

  it("idle floor picks wall when half the buckets are wall", () => {
    const stats = idle({
      wallP10W: 60,
      wallBuckets: 5,
      apuP10W: 7,
      buckets: 10,
    });
    expect(idleFloor(stats, fit, settings)?.watts).toBe(60);
    expect(idleFloor({ ...stats, wallBuckets: 4 }, fit, settings)?.watts).toBe(
      1.1 * 7 + 20,
    );
  });

  it("projection uses total avg", () => {
    const { totals } = summarize(raw, 0, 3600, settings, overhead10);
    expect(projectUsd(totals, 3600, settings)).toBeCloseTo(
      totals.electricityUsd! + ((30 * 3600) / 3.6e6) * 0.2,
    );
    expect(projectUsd(totals, 3600, {})).toBeNull();
    const empty = summarize(raw, null, 3600, settings, overhead10).totals;
    expect(projectUsd(empty, 3600, settings)).toBeNull();
  });
});
