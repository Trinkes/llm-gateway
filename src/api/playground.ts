// [fork] W23: the dashboard playground's API key. One key per user, named
// PLAYGROUND_KEY_NAME, whose secret is replaced on every call (the plaintext is
// never stored), so the playground needs no manual key and the key list keeps
// one row per user with its usage history intact.
import type { AppBindings } from "../app";
import { auditLog } from "../audit/audit-logger";
import { newId } from "../tenants/encryption";
import { getTenantPrefixInfo } from "../tenants/prefixes";
import { nowSeconds, sha256Hex } from "../utils/crypto";
import { generateApiKey } from "./keys";
import { PLAYGROUND_KEY_NAME } from "./playground-key-name";
import { Hono } from "hono";

/** How long a playground secret works before the page asks for a new one. */
export const PLAYGROUND_KEY_TTL_S = 24 * 3600;

export const playgroundRouter = new Hono<AppBindings>();

// POST /api/playground/key — issue a fresh secret for the caller's playground key.
playgroundRouter.post("/key", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  const plaintext = generateApiKey();
  const keyHash = await sha256Hex(plaintext);
  const keyPrefix = plaintext.slice(0, 8);
  const now = nowSeconds();
  const expiresAt = now + PLAYGROUND_KEY_TTL_S;

  // Usually one round trip: only the first call for a user inserts.
  const updated = await c.env.DB.prepare(
    `UPDATE api_keys SET key_hash = ?, key_prefix = ?, expires_at = ?, status = 'active'
     WHERE organization_id = ? AND created_by = ? AND name = ?
     RETURNING id`,
  )
    .bind(
      keyHash,
      keyPrefix,
      expiresAt,
      orgId,
      session.userId,
      PLAYGROUND_KEY_NAME,
    )
    .first<{ id: string }>();

  let id = updated?.id;
  if (!id) {
    id = newId("key");
    await c.env.DB.prepare(
      `INSERT INTO api_keys (id, organization_id, name, key_hash, key_prefix, created_by, created_at, expires_at, status, scopes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', '{}')`,
    )
      .bind(
        id,
        orgId,
        PLAYGROUND_KEY_NAME,
        keyHash,
        keyPrefix,
        session.userId,
        now,
        expiresAt,
      )
      .run();
  }

  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: updated ? "rotate" : "create",
    resourceType: "api_key",
    resourceId: id,
    details: { name: PLAYGROUND_KEY_NAME, keyPrefix },
  });

  const prefixInfo = await getTenantPrefixInfo(c.env, orgId);
  const basePath = prefixInfo
    ? (prefixInfo.customPrefix ??
      (prefixInfo.isRoot ? "" : (prefixInfo.systemPrefix ?? "")))
    : "";

  return c.json({ id, key: plaintext, keyPrefix, expiresAt, basePath });
});
