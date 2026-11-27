// [fork] W13: energy, cost and cloud-comparison maths.
// [fork] W14: wall-meter time priced as measured, APU-only time via the fallback model.
import { describe, expect, it } from "vitest";
import type { FallbackModel } from "~/src/power/fallback-model";
import type { KindBusy } from "~/src/power/kind-energy";
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
const chatBusy: KindBusy = {
  kind: "chat",
  requests: 5,
  units: 0,
  output: 1_000_000,
  input: 3_000_000,
  busySeconds: 100,
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
    // [fork] W17: chat only, so it carries all the energy.
    kinds: [chatBusy],
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
        kinds: [],
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
        kinds: [],
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

// [fork] W17: measured energy split by each kind's busy time.
describe("summarize kinds", () => {
  const imageBusy: KindBusy = {
    kind: "image",
    requests: 3,
    units: 6,
    output: 0,
    input: 0,
    busySeconds: 30,
  };
  const audioBusy: KindBusy = {
    kind: "audio",
    requests: 2,
    units: 0,
    output: 0,
    input: 0,
    busySeconds: 20,
  };
  // raw[0]: 0.03 kWh, $0.006 at 0.2 $/kWh
  const mixed: PeriodRaw[] = [
    {
      ...raw[0],
      kinds: [audioBusy, imageBusy, { ...chatBusy, busySeconds: 50 }],
    },
  ];

  it("splits energy by busy share across chat, image and an unknown kind", () => {
    const { totals, periods } = summarize(
      mixed,
      0,
      10_000,
      settings,
      overhead10,
    );
    const k = periods[0].kinds;
    expect(k.map((x) => x.kind)).toEqual(["chat", "image", "audio"]);
    expect(k.map((x) => x.unit)).toEqual(["tokens", "images", null]);
    expect(k.map((x) => x.label)).toEqual(["Chat", "Image", "audio"]);
    expect(k.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1);
    expect(k.map((x) => x.share)).toEqual([0.5, 0.3, 0.2]);
    expect(k[0].kwh).toBeCloseTo(0.015);
    expect(k[0].electricityUsd).toBeCloseTo(0.003);
    expect(k[0].perUnitUsd).toBeCloseTo(0.003); // per 1M output tokens
    expect(k[1].perUnitUsd).toBeCloseTo(0.0018 / 6); // per image
    expect(k[2].perUnitUsd).toBeCloseTo(0.0012 / 2); // per request
    expect(k[1]).toMatchObject({ requests: 3, units: 6, busySeconds: 30 });
    // chat's per-1M uses only chat's share
    expect(periods[0].electricityPer1mOutputUsd).toBeCloseTo(0.003);
    expect(totals.electricityPer1mOutputUsd).toBeCloseTo(0.003);
    expect(totals.kinds).toEqual(k);
  });

  it("a chat-only period keeps the whole-energy per-1M figure", () => {
    const { totals } = summarize(raw, 0, 10_000, settings, overhead10);
    expect(totals.kinds).toHaveLength(1);
    expect(totals.kinds[0].share).toBe(1);
    expect(totals.electricityPer1mOutputUsd).toBeCloseTo(
      totals.electricityUsd!,
    );
  });

  it("an image-only period has no token per-1M but a per-image figure", () => {
    const { totals } = summarize(
      [{ ...raw[0], tokens: noTokens, cloudUsd: 0, kinds: [imageBusy] }],
      0,
      10_000,
      settings,
      overhead10,
    );
    expect(totals.electricityPer1mOutputUsd).toBeNull();
    expect(totals.kinds[0].perUnitUsd).toBeCloseTo(0.006 / 6);
  });

  it("an idle period attributes nothing", () => {
    const zero = { ...chatBusy, busySeconds: 0 };
    for (const kinds of [[], [zero]]) {
      const { totals } = summarize(
        [{ ...raw[0], kinds }],
        0,
        10_000,
        settings,
        overhead10,
      );
      expect(totals.kinds).toEqual([]);
      expect(totals.electricityPer1mOutputUsd).toBeNull();
    }
  });

  it("range totals split all range energy by the range's busy time", () => {
    const two: PeriodRaw[] = [
      { ...raw[0], end: 1800, kinds: [{ ...chatBusy, busySeconds: 10 }] },
      {
        ...raw[0],
        start: 1800,
        tokens: noTokens,
        kinds: [
          imageBusy,
          { ...chatBusy, output: 0, input: 0, busySeconds: 30 },
        ],
      },
    ];
    const { totals, periods } = summarize(two, 0, 10_000, settings, overhead10);
    const [chat, image] = totals.kinds;
    expect(chat.kind).toBe("chat");
    expect(chat.busySeconds).toBe(40);
    expect(chat.requests).toBe(10);
    expect(chat.share).toBeCloseTo(40 / 70);
    expect(image.share).toBeCloseTo(30 / 70);
    // shares and kWh agree, and the kinds carry all of the range's energy
    expect(chat.kwh).toBeCloseTo((totals.totalKwh * 40) / 70);
    expect(chat.kwh + image.kwh).toBeCloseTo(totals.totalKwh);
    expect(chat.electricityUsd! + image.electricityUsd!).toBeCloseTo(
      totals.electricityUsd!,
    );
    expect(chat.perUnitUsd).toBeCloseTo(chat.electricityUsd!); // 1M output
    expect(totals.electricityPer1mOutputUsd).toBeCloseTo(chat.electricityUsd!);
    // the second period has chat busy time but no output tokens
    expect(periods[1].kinds.find((x) => x.kind === "chat")?.perUnitUsd).toBe(
      null,
    );
    expect(periods[1].electricityPer1mOutputUsd).toBeNull();
  });

  it("a chat-only range with an idle day keeps the old per-1M figure", () => {
    const days: PeriodRaw[] = [
      { ...raw[0], end: 1800 },
      { ...raw[0], start: 1800, tokens: noTokens, cloudUsd: 0, kinds: [] },
    ];
    const { totals, periods } = summarize(
      days,
      0,
      10_000,
      settings,
      overhead10,
    );
    expect(periods[1].kinds).toEqual([]);
    expect(periods[1].totalKwh).toBeGreaterThan(0);
    expect(totals.kinds).toHaveLength(1);
    expect(totals.kinds[0].kwh).toBeCloseTo(totals.totalKwh);
    expect(totals.electricityPer1mOutputUsd).toBeCloseTo(
      (totals.electricityUsd! / tokens.output) * 1e6,
    );
  });

  it("day periods summed match one month period", () => {
    const days: PeriodRaw[] = [
      { ...raw[0], end: 1800, kinds: [{ ...chatBusy, busySeconds: 10 }] },
      { ...raw[0], start: 1800, tokens: noTokens, kinds: [imageBusy] },
    ];
    const month: PeriodRaw[] = [
      {
        ...raw[0],
        apuWs: 2 * raw[0].apuWs,
        apuS: 2 * raw[0].apuS,
        tokens,
        cloudUsd: 2 * raw[0].cloudUsd,
        kinds: [imageBusy, { ...chatBusy, busySeconds: 10 }],
      },
    ];
    const a = summarize(days, 0, 10_000, settings, overhead10).totals;
    const b = summarize(month, 0, 10_000, settings, overhead10).totals;
    expect(a.totalKwh).toBeCloseTo(b.totalKwh);
    expect(a.kinds.map((k) => k.kind)).toEqual(b.kinds.map((k) => k.kind));
    a.kinds.forEach((k, i) => {
      expect(k.kwh).toBeCloseTo(b.kinds[i].kwh);
      expect(k.share).toBeCloseTo(b.kinds[i].share);
      expect(k.perUnitUsd!).toBeCloseTo(b.kinds[i].perUnitUsd!);
    });
    expect(a.electricityPer1mOutputUsd!).toBeCloseTo(
      b.electricityPer1mOutputUsd!,
    );
  });

  it("embedding energy is per 1M input and stays out of chat's per-1M output", () => {
    const embedding: KindBusy = {
      kind: "embedding",
      requests: 4,
      units: 0,
      output: 0,
      input: 2_000_000,
      busySeconds: 10,
    };
    // busy 40 chat, 30 image, 20 audio, 10 embedding of 100 s; $0.006
    const { totals } = summarize(
      [
        {
          ...raw[0],
          kinds: [
            { ...chatBusy, busySeconds: 40 },
            imageBusy,
            audioBusy,
            embedding,
          ],
        },
      ],
      0,
      10_000,
      settings,
      overhead10,
    );
    const by = Object.fromEntries(totals.kinds.map((k) => [k.kind, k]));
    expect(totals.kinds.map((k) => k.kind)).toEqual([
      "chat",
      "image",
      "audio",
      "embedding",
    ]);
    expect(totals.kinds.reduce((a, k) => a + k.share, 0)).toBeCloseTo(1);
    expect(by.embedding.unit).toBe("tokens");
    expect(by.embedding.perUnitUsd).toBeCloseTo((0.0006 / 2_000_000) * 1e6);
    expect(by.chat.perUnitUsd).toBeCloseTo(0.0024); // per 1M output
    // only chat (output > 0) feeds the per-1M output figure
    expect(totals.electricityPer1mOutputUsd).toBeCloseTo(0.0024);
  });

  it("a token kind without input or output has no per-unit figure", () => {
    const { totals } = summarize(
      [
        {
          ...raw[0],
          tokens: noTokens,
          kinds: [{ ...chatBusy, output: 0, input: 0 }],
        },
      ],
      0,
      10_000,
      settings,
      overhead10,
    );
    expect(totals.kinds[0].perUnitUsd).toBeNull();
    expect(totals.electricityPer1mOutputUsd).toBeNull();
  });

  it("orders equal busy time by kind", () => {
    const { totals } = summarize(
      [{ ...raw[0], kinds: [imageBusy, { ...audioBusy, busySeconds: 30 }] }],
      0,
      10_000,
      settings,
      overhead10,
    );
    expect(totals.kinds.map((x) => x.kind)).toEqual(["audio", "image"]);
  });

  it("no kWh price leaves kind money null", () => {
    const { totals } = summarize(mixed, 0, 10_000, {}, none);
    expect(totals.kinds.every((x) => x.kwh > 0)).toBe(true);
    expect(totals.kinds.map((x) => x.electricityUsd)).toEqual([
      null,
      null,
      null,
    ]);
    expect(totals.kinds.map((x) => x.perUnitUsd)).toEqual([null, null, null]);
  });

  it("zero units or requests give no per-unit figure", () => {
    const { totals } = summarize(
      [
        {
          ...raw[0],
          kinds: [
            { ...imageBusy, units: 0 },
            { ...audioBusy, requests: 0 },
          ],
        },
      ],
      0,
      10_000,
      settings,
      overhead10,
    );
    expect(totals.kinds.map((x) => x.perUnitUsd)).toEqual([null, null]);
  });

  it("a period before data start has no kinds", () => {
    const { periods } = summarize(mixed, 5000, 10_000, settings, overhead10);
    expect(periods[0].kinds).toEqual([]);
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
