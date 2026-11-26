import { nowSeconds } from "../utils/crypto";

/**
 * Unix-seconds values at or above this are almost surely milliseconds
 * (1e11 s is the year 5138), so they are refused instead of stored.
 */
const MAX_UNIX_SECONDS = 1e11;

export type ExpiryParseResult =
  { ok: true; value: number | null } | { ok: false; error: string };

/**
 * Validate a client-supplied `expiresAt` (unix seconds, UTC).
 * `null` clears the expiry when `allowNull` is set.
 */
export function parseExpiresAt(
  value: unknown,
  { allowNull }: { allowNull: boolean },
): ExpiryParseResult {
  if (value === null) {
    return allowNull
      ? { ok: true, value: null }
      : { ok: false, error: "expiresAt must be a unix timestamp (seconds)" };
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return {
      ok: false,
      error: allowNull
        ? "expiresAt must be a unix timestamp (seconds) or null"
        : "expiresAt must be a unix timestamp (seconds)",
    };
  }
  if (value >= MAX_UNIX_SECONDS) {
    return {
      ok: false,
      error: "expiresAt looks like milliseconds; send unix seconds",
    };
  }
  if (value <= nowSeconds()) {
    return { ok: false, error: "expiresAt must be in the future" };
  }
  return { ok: true, value };
}
