// API key expiry helpers. The server stores unix seconds (UTC); the picker
// shows and reads the browser's local time.

const DAY_SECONDS = 86400;
/** Matches the server's first expiry warning (src/alerts/evaluator.ts). */
export const EXPIRY_SOON_SECONDS = 7 * DAY_SECONDS;

export const EXPIRY_PRESETS = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
] as const;

export type ExpiryState = "never" | "expired" | "soon" | "ok";

export function expiryState(
  expiresAt: number | null,
  nowSeconds: number,
): ExpiryState {
  if (expiresAt === null) return "never";
  if (expiresAt <= nowSeconds) return "expired";
  if (expiresAt - nowSeconds <= EXPIRY_SOON_SECONDS) return "soon";
  return "ok";
}

/** Unix seconds -> `YYYY-MM-DDTHH:mm` in local time, for `<input type="datetime-local">`. */
export function toLocalInputValue(unixSeconds: number | null): string {
  if (unixSeconds === null) return "";
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** `datetime-local` value (local time) -> unix seconds; "" or invalid -> null. */
export function fromLocalInputValue(value: string): number | null {
  if (value.trim() === "") return null;
  // No zone suffix: the Date constructor reads it as local time.
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

/** `days` from now, as a `datetime-local` value. */
export function presetInputValue(days: number, nowSeconds: number): string {
  return toLocalInputValue(nowSeconds + days * DAY_SECONDS);
}

/** Short relative label, rounded: "in 7 days", "in 5 hours", "2 days ago". */
export function relativeExpiry(expiresAt: number, nowSeconds: number): string {
  const diff = expiresAt - nowSeconds;
  const abs = Math.abs(diff);
  const unit =
    abs >= DAY_SECONDS
      ? plural(Math.round(abs / DAY_SECONDS), "day")
      : abs >= 3600
        ? plural(Math.round(abs / 3600), "hour")
        : plural(Math.max(1, Math.round(abs / 60)), "minute");
  return diff > 0 ? `in ${unit}` : `${unit} ago`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
