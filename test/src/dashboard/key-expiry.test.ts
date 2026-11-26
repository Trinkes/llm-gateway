import {
  EXPIRY_SOON_SECONDS,
  expiryState,
  fromLocalInputValue,
  presetInputValue,
  relativeExpiry,
  toLocalInputValue,
} from "../../../dashboard/src/lib/keyExpiry";
import { describe, expect, it } from "vitest";

const NOW = 1_800_000_000;

describe("expiryState", () => {
  it("classifies never, expired, soon and ok", () => {
    expect(expiryState(null, NOW)).toBe("never");
    expect(expiryState(NOW, NOW)).toBe("expired");
    expect(expiryState(NOW + EXPIRY_SOON_SECONDS, NOW)).toBe("soon");
    expect(expiryState(NOW + EXPIRY_SOON_SECONDS + 1, NOW)).toBe("ok");
  });
});

describe("datetime-local conversion", () => {
  it("round-trips to the minute in local time", () => {
    const value = toLocalInputValue(NOW);
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInputValue(value)).toBe(NOW - (NOW % 60));
  });

  it("reads the value as local time, not UTC", () => {
    const local = new Date(2030, 0, 2, 3, 4).getTime() / 1000;
    expect(fromLocalInputValue("2030-01-02T03:04")).toBe(local);
  });

  it("maps empty and invalid input to null", () => {
    expect(toLocalInputValue(null)).toBe("");
    expect(fromLocalInputValue("")).toBeNull();
    expect(fromLocalInputValue("  ")).toBeNull();
    expect(fromLocalInputValue("not a date")).toBeNull();
  });

  it("builds presets from now", () => {
    expect(presetInputValue(7, NOW)).toBe(toLocalInputValue(NOW + 7 * 86400));
  });
});

describe("relativeExpiry", () => {
  it.each([
    [NOW + 3 * 86400, "in 3 days"],
    [NOW + 86400, "in 1 day"],
    [NOW + 5 * 3600, "in 5 hours"],
    [NOW + 3600, "in 1 hour"],
    [NOW + 120, "in 2 minutes"],
    [NOW + 10, "in 1 minute"],
    [NOW + 7 * 86400 - 60, "in 7 days"],
    [NOW - 2 * 86400, "2 days ago"],
  ])("%s -> %s", (expiresAt, label) => {
    expect(relativeExpiry(expiresAt, NOW)).toBe(label);
  });
});
