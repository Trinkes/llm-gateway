import { expiryState } from "../lib/keyExpiry";
import { Badge } from "./ui";

/** Key status, with "expired" derived from `expiresAt` (the DB only stores active/revoked). */
export function KeyStatusBadge({
  status,
  expiresAt,
}: {
  status: string;
  expiresAt: number | null;
}) {
  if (status !== "active") return <Badge tone="red">{status}</Badge>;
  if (expiryState(expiresAt, Math.floor(Date.now() / 1000)) === "expired") {
    return <Badge tone="red">expired</Badge>;
  }
  return <Badge tone="green">active</Badge>;
}
