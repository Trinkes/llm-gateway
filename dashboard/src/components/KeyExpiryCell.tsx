import { fmtDate } from "../lib/format";
import { expiryState, relativeExpiry } from "../lib/keyExpiry";

/** Expiry date plus a relative hint; amber within 7 days, red once past. */
export function KeyExpiryCell({ expiresAt }: { expiresAt: number | null }) {
  const now = Math.floor(Date.now() / 1000);
  const state = expiryState(expiresAt, now);
  if (expiresAt === null || state === "never") {
    return <span className="text-gray-400">Never</span>;
  }
  const tone =
    state === "expired"
      ? "text-red-600"
      : state === "soon"
        ? "text-amber-600"
        : "text-gray-600";
  return (
    <span className={tone} title={new Date(expiresAt * 1000).toString()}>
      {fmtDate(expiresAt)}
      <span className="ml-1 text-xs opacity-75">
        ({relativeExpiry(expiresAt, now)})
      </span>
    </span>
  );
}
