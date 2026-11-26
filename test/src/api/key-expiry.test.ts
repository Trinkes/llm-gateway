import { describe, expect, it } from "vitest";
import { parseExpiresAt } from "~/src/api/key-expiry";
import { nowSeconds } from "~/src/utils/crypto";

describe("parseExpiresAt", () => {
  it("accepts a future integer", () => {
    const t = nowSeconds() + 60;
    expect(parseExpiresAt(t, { allowNull: false })).toEqual({
      ok: true,
      value: t,
    });
  });

  it("accepts null only when allowed", () => {
    expect(parseExpiresAt(null, { allowNull: true })).toEqual({
      ok: true,
      value: null,
    });
    expect(parseExpiresAt(null, { allowNull: false })).toEqual({
      ok: false,
      error: "expiresAt must be a unix timestamp (seconds)",
    });
  });

  it("refuses now and the past", () => {
    expect(parseExpiresAt(nowSeconds(), { allowNull: false }).ok).toBe(false);
  });
});
