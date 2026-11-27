import { describe, expect, it } from "vitest";
import {
  IMAGE_QUALITY_TOKENS,
  imageOutputTokens,
  isPriceableSize,
} from "~/src/metrics/image-tokens";

describe("imageOutputTokens", () => {
  it.each([
    ["low", 272],
    ["medium", 1056],
    ["high", 4160],
  ])("prices a 1024x1024 %s image at OpenAI's count", (quality, expected) => {
    expect(imageOutputTokens({ size: "1024x1024", quality })).toBe(expected);
  });

  it("exposes the 1024x1024 counts", () => {
    expect(IMAGE_QUALITY_TOKENS).toEqual({
      low: 272,
      medium: 1056,
      high: 4160,
    });
  });

  it.each([
    ["1536x1024", "high", 6240],
    ["1024x1536", "medium", 1584],
    ["512x512", "high", 1040],
  ])("scales %s %s by pixel area", (size, quality, expected) => {
    expect(imageOutputTokens({ size, quality })).toBe(expected);
  });

  it("defaults to a 1024x1024 high image", () => {
    expect(imageOutputTokens({})).toBe(4160);
    expect(imageOutputTokens({ size: "auto", quality: "auto" })).toBe(4160);
  });

  it.each([
    ["standard", 1056],
    ["hd", 4160],
    ["ultra", 4160],
    [7, 4160],
  ])("maps quality %s", (quality, expected) => {
    expect(imageOutputTokens({ size: "1024x1024", quality })).toBe(expected);
  });

  it.each(["1024 X 1024", "big", 42, "0x1024"])(
    "treats size %s as 1024x1024",
    (size) => {
      expect(imageOutputTokens({ size, quality: "high" })).toBe(4160);
    },
  );

  it.each([
    [3, 816],
    [10, 2720],
    ["2", 272],
    [2.7, 272],
    [0, 272],
    [-1, 272],
    [11, 272],
    [null, 272],
  ])("charges n=%s like the recorded image count", (n, expected) => {
    expect(imageOutputTokens({ quality: "low", n })).toBe(expected);
  });
});

describe("isPriceableSize", () => {
  it.each([undefined, "auto", "1024x1024", "1536x1024", "512x512"])(
    "accepts %j",
    (size) => {
      expect(isPriceableSize(size)).toBe(true);
    },
  );

  it.each([
    "1024 X 1024",
    "big",
    42,
    null,
    "0x1024",
    "",
    "9".repeat(400) + "x1",
  ])("refuses %j", (size) => {
    expect(isPriceableSize(size)).toBe(false);
  });
});
